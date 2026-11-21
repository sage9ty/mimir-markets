/**
 * Mimir's Stellar-native x402 payment scheme — `exact` on `stellar:testnet`.
 *
 * This module is the whole mechanism: the buyer half, the seller half, and the
 * ... 
 * local stand-in for what used to be an HTTP facilitator. It implements the real
 * `@x402/core` v2.21 interfaces (`SchemeNetworkClient`, `SchemeNetworkServer`,
 * `SchemeNetworkFacilitator`, `FacilitatorClient`) — nothing here is a shim
 * around an EVM shape.
 *
 * ── Why the flow is different from `exact` on EVM ────────────────────────────
 *
 * EVM `exact` is EIP-3009: the buyer SIGNS a `transferWithAuthorization` and hands
 * the signature over; a facilitator submits it, pays the gas, and reports back.
 * That indirection exists because gas is expensive enough that somebody has to
 * sponsor it and because an EVM account cannot cheaply pay per HTTP request.
 *
 * A Stellar operation costs ~100 stroops (0.00001 XLM). So the buyer simply pays,
 * and presents PROOF OF A PAYMENT THAT ALREADY LANDED:
 *
 *   1. Buyer gets a 402 carrying `{ amount, asset, payTo, network }`.
 *   2. Buyer submits a classic `Payment` operation on `USDC:GBBD47…` for at least
 *      `amount` to `payTo`, and waits for Horizon to return the result.
 *   3. Buyer signs a canonical proof message (Ed25519, the payer's own key) and
 *      sends `{ transaction, payer, signature }` as the payment payload.
 *   4. Seller reads that transaction back off Horizon and checks it is a real,
 *      successful, recent payment of the right asset and amount to the right
 *      account, made by the account that signed the proof.
 *
 * Verification is a Horizon read, so there is no third party and no HTTP
 * facilitator. `x402ResourceServer` still needs a `FacilitatorClient` — its
 * `initialize()` throws when no facilitator advertises a supported kind — so
 * {@link LocalStellarFacilitatorClient} answers those three calls in-process.
 *
 * ── Why the payload is SIGNED, not just a transaction hash ───────────────────
 *
 * A landed transaction hash is public and permanent. If the proof were the hash
 * alone, anyone watching Horizon could lift a payment out of the ledger inside the
 * freshness window and spend it on their own request — a bearer token published to
 * the world by construction. Requiring an Ed25519 signature by the payment's
 * SOURCE ACCOUNT over `{network, transaction, payTo, amount, asset}` means the
 * proof is only usable by whoever holds the paying key. Same primitive, and the
 * same "the public key is an input, not an output" property, as
 * `lib/stellar-message.ts`.
 *
 * ── Replay ──────────────────────────────────────────────────────────────────
 *
 * See {@link consumeSettlement}. Stellar's sequence numbers stop a signed
 * transaction from being SUBMITTED twice, but nothing stops an already-landed hash
 * from being PRESENTED twice, and the payments ledger's unique index alone does
 * not deny the second request — `insertPayment` is `ON CONFLICT DO NOTHING` and
 * runs in `onAfterSettle`, i.e. after the paid response was already produced. So
 * settlement claims the hash first: durably against `payments_v2`, and in-process
 * for the window before that row exists.
 */

import { Keypair } from "@stellar/stellar-sdk";

import type {
  AssetAmount,
  Network,
  PaymentPayload,
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  Price,
  SchemeNetworkClient,
  SchemeNetworkFacilitator,
  SchemeNetworkServer,
  SettleResponse,
  SupportedKind,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";

import {
  X402_ASSET,
  X402_ASSET_CODE,
  X402_ASSET_ISSUER,
  X402_ASSET_SAC_ID,
  X402_FRESHNESS_POLICY_VERSION,
  type X402FreshnessPolicy,
  X402_NETWORK,
  X402_PAYMENT_MAX_AGE_MS,
  X402_SCHEME,
  defaultFreshnessPolicy,
  x402PaymentMaxAgeMs,
} from "./config";

export {
  X402_FRESHNESS_POLICY_VERSION,
  type X402FreshnessPolicy,
  defaultFreshnessPolicy,
  x402PaymentMaxAgeMs,
};

/**
 * Human-readable explanation of a freshness policy evaluation.
 */
export function formatFreshnessExplanation(args: {
  ageMs: number;
  maxAgeMs: number;
  policyVersion: string;
  ok: boolean;
}): string {
  const ageSec = Math.round(args.ageMs / 1000);
  const maxSec = Math.round(args.maxAgeMs / 1000);
  if (args.ok) {
    return `payment age ${args.ageMs}ms (~${ageSec}s) is within window ${args.maxAgeMs}ms (~${maxSec}s) under ${args.policyVersion}`;
  }
  return `payment age ${args.ageMs}ms (~${ageSec}s) exceeds window ${args.maxAgeMs}ms (~${maxSec}s) under ${args.policyVersion}`;
}
import { createHorizonServer, isAccountAddress } from "../stellar";
import { USDC_DECIMALS, formatAtomicUsdc, parseUsdcAtomic } from "../usdc";
import { transferUsdc, type AgentWallet } from "../agent-wallets";

// ── Wire format ───────────────────────────────────────────────────────────────

/** Discriminator carried in the payload so an unknown proof shape fails loudly. */
export const STELLAR_PROOF_KIND = "stellar-payment-v1";

/**
 * The payment proof — this is `PaymentPayload.payload` on the wire, base64'd into
 * the `PAYMENT-SIGNATURE` header by the SDK.
 *
 * Deliberately minimal: everything else the seller needs (amount, asset, payTo)
 * it already has in its own `PaymentRequirements`, and reading those back off the
 * buyer's payload would only create a second, forgeable source of truth. The
 * ledger record on Horizon is authoritative for all of it.
 */
export interface StellarPaymentProof {
  kind: typeof STELLAR_PROOF_KIND;
  /** Network the payment landed on, e.g. `stellar:testnet`. */
  network: string;
  /** 64-char lowercase hex Stellar transaction hash. */
  transaction: string;
  /** `G…` account that sent the payment AND produced `signature`. */
  payer: string;
  /** Base64 Ed25519 signature by `payer` over {@link paymentProofMessage}. */
  signature: string;
}

/**
 * The exact bytes both sides sign and verify.
 *
 * Line-oriented and prefixed with a `Mimir …` header, matching the domain
 * separation convention `lib/stellar-message.ts` established: a signature
 * harvested from another Mimir surface cannot be replayed as a payment proof and
 * vice versa. Everything that decides whether the payment satisfies the quote is
 * in here, so a proof cannot be moved to a differently-priced resource.
 */
export function paymentProofMessage(args: {
  network: string;
  transaction: string;
  payTo: string;
  /** Atomic units, exactly as `PaymentRequirements.amount` carries it. */
  amount: string;
  asset: string;
}): string {
  return [
    "Mimir x402 payment v1",
    `network: ${args.network}`,
    `transaction: ${args.transaction.toLowerCase()}`,
    `payTo: ${args.payTo}`,
    `amount: ${args.amount}`,
    `asset: ${args.asset}`,
  ].join("\n");
}

/** Narrow an untrusted `payload` to a proof. Shape only — nothing is trusted yet. */
export function parsePaymentProof(payload: unknown): StellarPaymentProof | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.kind !== STELLAR_PROOF_KIND) return null;
  if (typeof p.network !== "string" || typeof p.transaction !== "string") return null;
  if (typeof p.payer !== "string" || typeof p.signature !== "string") return null;
  const transaction = p.transaction.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(transaction)) return null;
  if (!isAccountAddress(p.payer.trim())) return null;
  return {
    kind: STELLAR_PROOF_KIND,
    network: p.network.trim(),
    transaction,
    payer: p.payer.trim(),
    signature: p.signature.trim(),
  };
}

/** The payer of a verified proof, or null when the payload is not one. */
export function proofPayer(payload: unknown): string | null {
  return parsePaymentProof(payload)?.payer ?? null;
}

// ── Price / asset plumbing ────────────────────────────────────────────────────

/**
 * Dollar quote (or explicit AssetAmount) → USDC atomic units on Stellar.
 *
 * SEVEN decimals. This is the single most load-bearing difference from the EVM
 * scheme this replaces, which hardcoded 6 for every USDC it knew about: a quote
 * parsed at 6dp under-charges by 10x on Stellar.
 */
function parseUsdcPrice(price: Price): AssetAmount {
  if (typeof price === "object" && price !== null && "amount" in price) {
    if (!price.asset) throw new Error("x402 AssetAmount price is missing its asset");
    return { amount: price.amount, asset: price.asset, extra: price.extra ?? {} };
  }
  const raw = typeof price === "number" ? price.toFixed(USDC_DECIMALS) : String(price).trim();
  const amount = parseUsdcAtomic(raw.replace(/^\$/, ""));
  if (amount <= 0n) throw new Error(`x402 price must be greater than zero: ${String(price)}`);
  return {
    amount: amount.toString(),
    asset: X402_ASSET,
    extra: {
      assetCode: X402_ASSET_CODE,
      assetIssuer: X402_ASSET_ISSUER,
      decimals: USDC_DECIMALS,
      // Advertised so a Soroban-side buyer can move the same balance through the
      // SAC; verification never matches on it (see config's X402_ASSET comment).
      sacId: X402_ASSET_SAC_ID,
      proofKind: STELLAR_PROOF_KIND,
    },
  };
}

/** True when a `CODE:ISSUER` string names the asset a quote is denominated in. */
function assetMatches(required: string, code: string, issuer: string): boolean {
  const [wantCode, wantIssuer] = required.split(":");
  return wantCode === code && wantIssuer === issuer;
}

// ── Horizon verification ──────────────────────────────────────────────────────

/** Why a proof was refused. Reported as `invalidReason` / `errorReason`. */
export type StellarVerifyFailure =
  | "malformed_proof"
  | "network_mismatch"
  | "unsupported_asset"
  | "unsupported_pay_to"
  | "invalid_signature"
  | "transaction_not_found"
  | "transaction_failed"
  | "payment_too_old"
  | "no_matching_payment"
  | "insufficient_amount"
  | "already_settled"
  | "horizon_unavailable";

export const RETRYABLE_VERIFY_FAILURES: ReadonlySet<StellarVerifyFailure> = new Set(["horizon_unavailable"]);

export type StellarVerifyResult =
  | {
      ok: true;
      transaction: string;
      payer: string;
      /** Atomic units actually paid — may exceed the quote; never less. */
      amountAtomic: bigint;
      settledAt: number;
      observedAt: number;
      policy: X402FreshnessPolicy;
      explanation: string;
    }
  | {
      ok: false;
      reason: StellarVerifyFailure;
      message: string;
      observedAt?: number;
      policy?: X402FreshnessPolicy;
      explanation?: string;
    };

export interface HorizonPaymentOperation {
  type: string;
  from?: string;
  to?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
  transaction_successful?: boolean;
}

/**
 * The two Horizon reads verification performs, as replaceable functions.
 *
 * A load test needs to exercise `verifyStellarPayment` (and therefore the
 * facilitator) deterministically — thousands of verifications, each reading "its
 * own" transaction — without a live network. Injecting a reader is what allows
 * that: a fixture backend answers from memory, and production code keeps using
 * {@link horizonPaymentReader()} below. Failures must be shaped like Horizon's so
 * the caller's distinguished handling (404 → `transaction_not_found`, anything
 * else → `horizon_unavailable`) still fires.
 */
export interface StellarHorizonReader {
  /** Resolve a transaction. Throw `{ response: { status: 404 } }` when absent. */
  getTransaction(txHash: string): Promise<{ createdAtMs: number; successful: boolean }>;
  getPaymentOperations(txHash: string): Promise<HorizonPaymentOperation[]>;
}

/** The real reader: two Horizon requests, like the code always made. */
export function horizonPaymentReader(): StellarHorizonReader {
  const horizon = createHorizonServer();
  return {
    async getTransaction(txHash: string) {
      const tx = await horizon.transactions().transaction(txHash).call();
      return { createdAtMs: Date.parse(tx.created_at), successful: tx.successful };
    },
    async getPaymentOperations(txHash: string) {
      const page = await horizon.operations().forTransaction(txHash).limit(200).call();
      return page.records as unknown as HorizonPaymentOperation[];
    },
  };
}

/**
 * Check a proof against the ledger.
 *
 * Pure read, no side effects — `verify()` and `settle()` both call it and only
 * `settle()` goes on to claim the hash. Every check is against `requirements`,
 * never against the buyer's own claims about its payment.
 */
export async function verifyStellarPayment(
  payload: Readonly<Record<string, unknown>>,
  requirements: PaymentRequirements,
  options: {
    maxAgeMs?: number;
    now?: number;
    backend?: StellarHorizonReader;
    policy?: X402FreshnessPolicy;
    policyVersion?: string;
  } = {},
): Promise<StellarVerifyResult> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? options.policy?.maxAgeMs ?? x402PaymentMaxAgeMs();
  const policyVersion = options.policy?.version ?? options.policyVersion ?? X402_FRESHNESS_POLICY_VERSION;
  const policy: X402FreshnessPolicy = {
    version: policyVersion,
    maxAgeMs,
  };

  const proof = parsePaymentProof(payload);
  if (!proof) {
    return {
      ok: false,
      reason: "malformed_proof",
      message: `payment payload is not a ${STELLAR_PROOF_KIND} proof`,
      observedAt: now,
      policy,
    };
  }
  if (proof.network !== requirements.network) {
    return {
      ok: false,
      reason: "network_mismatch",
      message: `proof names ${proof.network}, quote is for ${requirements.network}`,
      observedAt: now,
      policy,
    };
  }
  if (!assetMatches(requirements.asset, X402_ASSET_CODE, X402_ASSET_ISSUER)) {
    return {
      ok: false,
      reason: "unsupported_asset",
      message: `this scheme only settles ${X402_ASSET}, quote asked for ${requirements.asset}`,
      observedAt: now,
      policy,
    };
  }
  if (!isAccountAddress(requirements.payTo)) {
    return {
      ok: false,
      reason: "unsupported_pay_to",
      message: `payTo ${requirements.payTo} is not a valid Stellar account address`,
      observedAt: now,
      policy,
    };
  }

  const message = paymentProofMessage({
    network: requirements.network,
    transaction: proof.transaction,
    payTo: requirements.payTo,
    amount: requirements.amount,
    asset: requirements.asset,
  });
  if (!verifyProofSignature(proof, message)) {
    return {
      ok: false,
      reason: "invalid_signature",
      message: `proof is not signed by ${proof.payer} over this quote`,
      observedAt: now,
      policy,
    };
  }

  const reader = options.backend ?? horizonPaymentReader();
  let createdAt: number;
  let successful: boolean;
  try {
    const tx = await reader.getTransaction(proof.transaction);
    createdAt = tx.createdAtMs;
    successful = tx.successful;
  } catch (cause) {
    const status = (cause as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return {
        ok: false,
        reason: "transaction_not_found",
        message: `${proof.transaction} is not on the ${requirements.network} ledger`,
        observedAt: now,
        policy,
      };
    }
    return {
      ok: false,
      reason: "horizon_unavailable",
      message: `Horizon could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      observedAt: now,
      policy,
    };
  }

  if (!successful) {
    return {
      ok: false,
      reason: "transaction_failed",
      message: `${proof.transaction} landed but did not succeed`,
      observedAt: now,
      policy,
    };
  }

  const age = now - createdAt;
  if (!Number.isFinite(createdAt) || age > maxAgeMs) {
    const explanation = formatFreshnessExplanation({
      ageMs: age,
      maxAgeMs,
      policyVersion: policy.version,
      ok: false,
    });
    return {
      ok: false,
      reason: "payment_too_old",
      message: `payment is ${Math.round(age / 1000)}s old, the window is ${Math.round(maxAgeMs / 1000)}s`,
      observedAt: now,
      policy,
      explanation,
    };
  }

  let operations: HorizonPaymentOperation[];
  try {
    operations = await reader.getPaymentOperations(proof.transaction);
  } catch (cause) {
    return {
      ok: false,
      reason: "horizon_unavailable",
      message: `Horizon operations read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      observedAt: now,
      policy,
    };
  }

  // Only a plain `payment` counts. A path payment could be made to satisfy the
  // same quote, but its `amount` semantics differ per variant and an ambiguous
  // amount check on a money path is not worth the flexibility.
  const candidates = operations.filter(
    (op) =>
      op.type === "payment" &&
      op.from === proof.payer &&
      op.to === requirements.payTo &&
      op.asset_type !== "native" &&
      op.asset_code === X402_ASSET_CODE &&
      op.asset_issuer === X402_ASSET_ISSUER,
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "no_matching_payment",
      message: `${proof.transaction} contains no ${X402_ASSET} payment from ${proof.payer} to ${requirements.payTo}`,
      observedAt: now,
      policy,
    };
  }

  // Summed, not "first match": a buyer batching two operations in one transaction
  // has genuinely paid the total, and charging it for only one of them would be a
  // silent overcharge.
  let paid = 0n;
  for (const op of candidates) {
    try {
      paid += parseUsdcAtomic(op.amount ?? "0");
    } catch {
      /* an amount Horizon reports outside 7dp cannot be counted; ignore it */
    }
  }
  const required = BigInt(requirements.amount);
  if (paid < required) {
    return {
      ok: false,
      reason: "insufficient_amount",
      message: `paid ${formatAtomicUsdc(paid)} USDC, quote is ${formatAtomicUsdc(required)} USDC`,
      observedAt: now,
      policy,
    };
  }

  const explanation = formatFreshnessExplanation({
    ageMs: age,
    maxAgeMs,
    policyVersion: policy.version,
    ok: true,
  });

  return {
    ok: true,
    transaction: proof.transaction,
    payer: proof.payer,
    amountAtomic: paid,
    settledAt: createdAt,
    observedAt: now,
    policy,
    explanation,
  };
}

// ── Decision trace (privacy-safe) ─────────────────────────────────────────────

/** Ed25519 check. Fails closed on anything malformed, like `lib/stellar-message.ts`. */
function verifyProofSignature(proof: StellarPaymentProof, message: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(proof.signature)) return false;
  try {
    const raw = Buffer.from(proof.signature, "base64");
    if (raw.length !== 64) return false;
    return Keypair.fromPublicKey(proof.payer).verify(Buffer.from(message, "utf8"), raw);
  } catch {
    return false;
  }
}

// ── Replay protection ─────────────────────────────────────────────────────────

/**
 * Transaction hashes this process has already settled.
 *
 * Bounded because a long-lived worker would otherwise grow it without limit; the
 * cap is far above the number of settlements possible inside one freshness
 * window, which is the only period where a hash can still be presented.
 */
const consumed = new Set<string>();
export const CONSUMED_MAX = 4096;

/**
 * Test and operational seam: clear the in-process replay set.
 *
 * The set is process-local by design, so a load test (which verifies and settles
 * thousands of hashes against fixtures in one process) would otherwise inherit
 * settlements from an earlier test block. Nothing about replay semantics changes
 * — this is the same reset a worker restart performs implicitly.
 */
export function resetConsumedSettlements(): void {
  consumed.clear();
}

/** How many hashes the in-process replay set currently holds (bounded by `CONSUMED_MAX`). */
export function consumedSettlementsCount(): number {
  return consumed.size;
}

/**
 * Claim a transaction hash for exactly one settlement. `false` means replay.
 *
 * Two layers, because neither alone is enough:
 *
 *  - **Durable:** a `payments_v2` row for this `(network, payment_identifier)`
 *    means a previous request already settled this hash. This is what survives a
 *    process restart and covers a second serverless instance.
 *  - **In-process:** the durable row is written by `recordPayment` in
 *    `onAfterSettle`, i.e. AFTER this point, so between settle and insert the DB
 *    still says "unseen". The in-memory set closes that window for the instance
 *    doing the settling.
 *
 * What is deliberately NOT built: a shared lock or a dedicated nonce table. The
 * residual exposure is two requests presenting the same hash to two DIFFERENT
 * instances within the few hundred milliseconds before the first row lands — and
 * both would have to be signed by the payer's own key, so the worst case is a
 * buyer double-spending its own proof against itself. Adding a distributed lock
 * to the request path to close that is not a trade worth making.
 *
 * **Contrast with `lib/server/nonce-store.ts`**: the agent API uses caller-supplied
 * nonce strings that do not have an inherent lifetime guarantee from the ledger, so
 * it maintains a separate `agent_api_nonces` table with per-row `expires_at` TTLs.
 * x402 transaction hashes are already single-use by the ledger (a transaction can
 * only land once), which is why `payments_v2` is sufficient here and no extra nonce
 * table is needed for this path.
 *
 * With no DATABASE_URL only the in-process layer exists; that is the same
 * degradation the payments ledger itself already accepts.
 */
export async function consumeSettlement(network: string, transaction: string): Promise<boolean> {
  const key = `${network}|${transaction.toLowerCase()}`;
  if (consumed.has(key)) return false;
  
  // Claim the hash in-memory BEFORE yielding to the DB read.
  // This prevents concurrent requests on the same instance from both seeing "unseen"
  // and both settling successfully before the DB row lands.
  remember(key);
  
  if (await settledInLedger(network, transaction)) {
    return false;
  }
  return true;
}

/**
 * Read-only "has this already been settled" check, for `verify()`.
 *
 * ⚠️ **Do not write `return settledInLedger(...)` here.** Returning the promise
 * instead of awaiting it makes every return value of this function statically
 * "truthy" (a `Promise` is an object), and Turbopack's constant folder propagates
 * that through `await` at the call site: `if (await isSettlementConsumed(…))`
 * compiled to `if ("TURBOPACK compile-time truthy", 1)` with the alternative
 * branch replaced by `//TURBOPACK unreachable`. Every single payment was then
 * rejected as `already_settled` — in the Turbopack build ONLY, while `tsx` and
 * `tsc` were perfectly happy, which is exactly the shape of bug that gets shipped.
 * Awaiting into a local makes the return value opaque again. Verified by grepping
 * the emitted chunk for `TURBOPACK compile-time truthy`.
 */
export async function isSettlementConsumed(network: string, transaction: string): Promise<boolean> {
  const key = `${network}|${transaction.toLowerCase()}`;
  if (consumed.has(key)) return true;
  const recorded = await settledInLedger(network, transaction);
  return recorded;
}

function remember(key: string): void {
  consumed.add(key);
  if (consumed.size > CONSUMED_MAX) {
    // Insertion-ordered, so this drops the oldest — all of which are far outside
    // the freshness window by the time the cap is reached.
    for (const old of consumed) {
      consumed.delete(old);
      if (consumed.size <= CONSUMED_MAX) break;
    }
  }
}

async function settledInLedger(network: string, transaction: string): Promise<boolean> {
  try {
    // Imported lazily: this module's client half runs in agent worker processes
    // that have no reason to open a database pool.
    const { isDbConfigured, getDb } = await import("../db");
    if (!isDbConfigured()) return false;
    const pool = await getDb();
    const result = await pool.query(
      "SELECT 1 FROM payments_v2 WHERE network = $1 AND payment_identifier = $2 LIMIT 1",
      [network, transaction.toLowerCase()],
    );
    return result.rows.length > 0;
  } catch (error) {
    // Fail OPEN on an unreachable ledger. The alternative — refusing every
    // payment when the accounting database blips — turns a bookkeeping outage
    // into a serving outage, and the in-process set still holds.
    console.warn(
      "[x402] replay lookup failed, falling back to in-process only:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

// ── Seller: SchemeNetworkServer ───────────────────────────────────────────────

/**
 * The seller-side scheme. Its whole job is turning a dollar quote into a Stellar
 * USDC requirement — verification lives in the facilitator half below, which is
 * where `@x402/core` actually routes verify/settle.
 */
export class ExactStellarScheme implements SchemeNetworkServer {
  readonly scheme = X402_SCHEME;

  parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    return Promise.resolve(parseUsdcPrice(price));
  }

  /** 7 on Stellar. The SDK's fallback is 6, which would be a 10x error. */
  getAssetDecimals(_asset: string, _network: Network): number {
    return USDC_DECIMALS;
  }

  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    return Promise.resolve(paymentRequirements);
  }
}

// ── Seller: SchemeNetworkFacilitator (verify + settle) ────────────────────────

/**
 * Verification and settlement, done inline against Horizon.
 *
 * "Settle" does not submit anything — the buyer already did. It re-checks the
 * payment (requirements can be re-resolved between verify and settle, and the
 * freshness window may have closed in between) and then claims the hash so the
 * same proof cannot buy a second response.
 */
export class ExactStellarFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = X402_SCHEME;
  /** Groups this facilitator's signers by family in the supported response. */
  readonly caipFamily = "stellar:*";

  /**
   * @param backend optional Horizon reader for deterministic tests. Absent, the
   * real reader (live Horizon reads) is used, exactly as before.
   */
  constructor(private readonly backend?: StellarHorizonReader) {}

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return {
      assetCode: X402_ASSET_CODE,
      assetIssuer: X402_ASSET_ISSUER,
      decimals: USDC_DECIMALS,
      proofKind: STELLAR_PROOF_KIND,
      maxAgeMs: x402PaymentMaxAgeMs(),
      policyVersion: X402_FRESHNESS_POLICY_VERSION,
      policy: defaultFreshnessPolicy(),
    };
  }

  /**
   * Empty, and that is the point: an EVM facilitator lists the addresses that will
   * submit and pay gas for the buyer. Here the buyer submits its own payment, so
   * there is no facilitator-side signer for a client to know about.
   */
  getSigners(_network: string): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const result = await verifyStellarPayment(payload.payload, requirements, {
      backend: this.backend,
    });
    if (!result.ok) {
      return {
        isValid: false,
        invalidReason: result.reason,
        invalidMessage: result.message,
        extra: {
          retryable: RETRYABLE_VERIFY_FAILURES.has(result.reason),
          ...(result.observedAt !== undefined ? { observedAt: result.observedAt } : {}),
          ...(result.policy !== undefined ? { policy: result.policy } : {}),
          ...(result.explanation !== undefined ? { explanation: result.explanation } : {}),
        },
      };
    }
    if (await isSettlementConsumed(requirements.network, result.transaction)) {
      return {
        isValid: false,
        invalidReason: "already_settled",
        invalidMessage: `${result.transaction} has already paid for a response`,
        extra: {
          observedAt: result.observedAt,
          policy: result.policy,
          explanation: result.explanation,
        },
      };
    }
    return {
      isValid: true,
      payer: result.payer,
      extra: {
        transaction: result.transaction,
        amount: result.amountAtomic.toString(),
        observedAt: result.observedAt,
        policy: result.policy,
        explanation: result.explanation,
      },
    };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const result = await verifyStellarPayment(payload.payload, requirements, {
      backend: this.backend,
    });
    if (!result.ok) {
      return {
        success: false,
        errorReason: result.reason,
        errorMessage: result.message,
        transaction: parsePaymentProof(payload.payload)?.transaction ?? "",
        network: requirements.network,
        extra: {
          ...(result.observedAt !== undefined ? { observedAt: result.observedAt } : {}),
          ...(result.policy !== undefined ? { policy: result.policy } : {}),
          ...(result.explanation !== undefined ? { explanation: result.explanation } : {}),
        },
      };
    }
    if (!(await consumeSettlement(requirements.network, result.transaction))) {
      return {
        success: false,
        errorReason: "already_settled",
        errorMessage: `${result.transaction} has already paid for a response`,
        transaction: result.transaction,
        network: requirements.network,
        extra: {
          observedAt: result.observedAt,
          policy: result.policy,
          explanation: result.explanation,
        },
      };
    }
    return {
      success: true,
      transaction: result.transaction,
      network: requirements.network,
      payer: result.payer,
      // The quote, not the (possibly larger) amount observed on chain: `exact`
      // settles what was agreed, and a buyer that overpaid must not have the
      // surplus booked as Mimir revenue for this call.
      amount: requirements.amount,
      extra: {
        observedAt: result.observedAt,
        policy: result.policy,
        explanation: result.explanation,
      },
    };
  }
}

// ── Seller: local FacilitatorClient ───────────────────────────────────────────

/**
 * The `FacilitatorClient` `x402ResourceServer` insists on, with no network hop.
 *
 * A facilitator-less resource server is NOT possible in `@x402/core` 2.21:
 * `initialize()` iterates `facilitatorClients`, builds its supported-kinds map
 * from `getSupported()`, and throws `"Failed to initialize: no supported payment
 * kinds loaded from any facilitator"` when the map ends up empty; `buildPayment-
 * Requirements` then refuses any scheme/network that is not in that map. So the
 * object is mandatory — but nothing requires it to speak HTTP.
 */
export class LocalStellarFacilitatorClient implements FacilitatorClient {
  private readonly facilitator: ExactStellarFacilitator;

  constructor(
    private readonly networks: Network[] = [X402_NETWORK],
    backend?: StellarHorizonReader,
  ) {
    this.facilitator = new ExactStellarFacilitator(backend);
  }

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.facilitator.verify(payload, requirements);
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.facilitator.settle(payload, requirements);
  }

  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve({
      kinds: this.networks.map((network) => ({
        // v2 only. The v1 wire format is EVM-shaped (`maxAmountRequired`, a bare
        // network slug) and there is no v1 Stellar network name to advertise.
        x402Version: 2,
        scheme: X402_SCHEME,
        network,
        extra: this.facilitator.getExtra(network),
      })),
      // Bazaar discovery metadata is attached to every paid route (see
      // `paidRoute`), so it has to be advertised here or the declaration is
      // dropped as unsupported.
      extensions: ["bazaar"],
      signers: { [this.facilitator.caipFamily]: [] },
    });
  }
}

// ── Buyer: SchemeNetworkClient ────────────────────────────────────────────────

/** How the buyer half reports what it did, for logging at the call site. */
export interface StellarPaymentSubmission {
  transaction: string;
  amountAtomic: bigint;
  payTo: string;
}

/**
 * The buyer half: pay, then prove.
 *
 * `createPaymentPayload` genuinely submits a Stellar transaction and waits for
 * Horizon to return its result, so it is on the order of a ledger close (~5s) and
 * IT SPENDS REAL MONEY. That is the honest shape of this scheme — there is no
 * signature-only step to defer the spend to, because there is no facilitator to
 * hand a signature to. The budget guard in `./buyer.ts` therefore has to run
 * BEFORE this is ever called, which is exactly where it runs: inside the payment
 * requirements policy.
 */
export class ExactStellarClient implements SchemeNetworkClient {
  readonly scheme = X402_SCHEME;

  constructor(
    private readonly wallet: AgentWallet,
    private readonly onPaid?: (submission: StellarPaymentSubmission) => void,
  ) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const { asset, amount, payTo, network } = paymentRequirements;

    if (!assetMatches(asset, X402_ASSET_CODE, X402_ASSET_ISSUER)) {
      throw new Error(`402 quote is denominated in ${asset}; this wallet only pays ${X402_ASSET}`);
    }
    if (!isAccountAddress(payTo)) {
      throw new Error(`402 quote pays to ${payTo}, which is not a Stellar account`);
    }
    const atomic = BigInt(amount);
    if (atomic <= 0n) throw new Error(`402 quote asks for a non-positive amount: ${amount}`);

    // Exact decimal rendering of the atomic quote — never via IEEE-754, so a
    // sub-cent price is paid to the stroop.
    const amountUsdc = formatAtomicUsdc(atomic);
    const transaction = await transferUsdc({ wallet: this.wallet, to: payTo, amountUsdc });

    const signature = this.wallet.keypair
      .sign(Buffer.from(paymentProofMessage({ network, transaction, payTo, amount, asset }), "utf8"))
      .toString("base64");

    this.onPaid?.({ transaction, amountAtomic: atomic, payTo });

    const proof: StellarPaymentProof = {
      kind: STELLAR_PROOF_KIND,
      network,
      transaction: transaction.toLowerCase(),
      payer: this.wallet.address,
      signature,
    };
    return { x402Version, payload: proof as unknown as Record<string, unknown> };
  }
}
