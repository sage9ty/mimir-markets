/*
 * Payments revenue ledger — tracks the x402 USDC settlements Mimir's paid
 * endpoints earn.
 *
 * Accounting is done on atomic integers (`amount_atomic`, USDC 7dp). Decimal
 * conversion happens in the API/UI layer only — never in the ledger, never in
 * the SUMs. Durable in Neon (payments_v2); falls back to an in-memory ring
 * buffer (last 1000 events) when DATABASE_URL is unset, so serving never breaks.
 */

import {
  getMarketRevenueSummary,
  insertPayment,
  getPaymentsRevenueSummary,
  type PaymentsRevenueSummary,
} from "./db";
import { USDC_DECIMALS, USDC_SYMBOL, unitsToUsdc } from "./usdc";
import type { VerificationTrace } from "./x402/decision-trace";
import {
  X402_FRESHNESS_POLICY_VERSION,
  type X402FreshnessPolicy,
  defaultFreshnessPolicy,
  x402PaymentMaxAgeMs,
} from "./x402/config";
import { formatFreshnessExplanation } from "./x402/stellar-scheme";

export {
  X402_FRESHNESS_POLICY_VERSION,
  type X402FreshnessPolicy,
  defaultFreshnessPolicy,
  x402PaymentMaxAgeMs,
  formatFreshnessExplanation,
};

export interface PaymentEvent {
  /** Which endpoint earned it (e.g. /api/premium/price). */
  resource: string;
  scheme: string;
  /**
   * CAIP-2, e.g. `stellar:testnet` — the value `X02_NETWORK` resolves to in
   * `lib/x402/config.ts`, handed straight through by the `onAfterSettle` hook in
   * `lib/x402/server.ts` as `result.network`.
   */
  network: string;
  assetAddress: string;
  /** Settled amount in atomic token units. */
  amountAtomic: bigint;
  payer: string | null;
  seller: string | null;
  transactionHash: string | null;
  /** x402 authorization/settlement id — the idempotency key. */
  paymentIdentifier: string;
  facilitator: string;
  settledAt: number;
  /**
   * Optional privacy-safe verification decision trace. Never persisted to the
   * durable store; only surfaced on the in-memory view.
   */
  verificationTrace?: VerificationTrace;
  /** Applied verification freshness policy or version string */
  policy?: X402FreshnessPolicy | string;
  policyVersion?: string;
  policyMaxAgeMs?: number;
  /** Timestamp when payment freshness was observed on the ledger */
  observedAt?: number;
  observationTime?: number;
  /** Human-readable explanation of freshness verification preserved for audit */
  explanation?: string;
}

export type PaymentReceipt = PaymentEvent;

/**
 * Return human-readable explanation of freshness verification for a receipt.
 * Preserves the historical explanation recorded at verification time even if system
 * configuration (such as X402_PAYMENT_MAX_AGE_MS) changes afterwards.
 */
export function explainPaymentFreshness(receipt: {
  settledAt?: number;
  observedAt?: number;
  observationTime?: number;
  policy?: X402FreshnessPolicy | string;
  policyVersion?: string;
  policyMaxAgeMs?: number;
  explanation?: string;
}): string {
  if (receipt.explanation) {
    return receipt.explanation;
  }
  const policyObj =
    typeof receipt.policy === "object" && receipt.policy !== null
      ? receipt.policy
      : defaultFreshnessPolicy(receipt.policyMaxAgeMs);
  const version =
    receipt.policyVersion ??
    (typeof receipt.policy === "string" ? receipt.policy : policyObj.version);
  const maxAgeMs = receipt.policyMaxAgeMs ?? policyObj.maxAgeMs;
  const observedAt = receipt.observedAt ?? receipt.observationTime ?? Date.now();
  const settledAt = receipt.settledAt ?? observedAt;
  const ageMs = Math.max(0, observedAt - settledAt);
  const ok = ageMs <= maxAgeMs;
  return formatFreshnessExplanation({
    ageMs,
    maxAgeMs,
    policyVersion: version,
    ok,
  });
}

/**
 * Retrieve a stored payment receipt by paymentIdentifier or transactionHash.
 */
export function getStoredReceipt(identifierOrTxHash: string): PaymentEvent | null {
  const target = identifierOrTxHash.trim().toLowerCase();
  const found = events.find(
    (e) =>
      e.paymentIdentifier.toLowerCase() === target ||
      (e.transactionHash && e.transactionHash.toLowerCase() === target),
  );
  return found ? { ...found } : null;
}

const MAX = 1000;
const events: PaymentEvent[] = [];

/**
 * Record a settled payment. Never throws — accounting must not break serving.
 * Returns the durable-write promise so callers can `await` it: on Vercel the
 * serverless function is frozen right after the response returns, which drops
 * any fire-and-forget insert still in flight.
 */
export function recordPayment(e: PaymentEvent): Promise<void> {
  const observedAt = e.observedAt ?? e.observationTime ?? Date.now();
  const policyObj: X402FreshnessPolicy =
    typeof e.policy === "object" && e.policy !== null
      ? e.policy
      : defaultFreshnessPolicy(e.policyMaxAgeMs);
  const policyVersion =
    e.policyVersion ??
    (typeof e.policy === "string" ? e.policy : policyObj.version);
  const policyMaxAgeMs = e.policyMaxAgeMs ?? policyObj.maxAgeMs;
  const normalizedPolicy: X402FreshnessPolicy = {
    version: policyVersion,
    maxAgeMs: policyMaxAgeMs,
  };
  const explanation =
    e.explanation ??
    explainPaymentFreshness({
      settledAt: e.settledAt,
      observedAt,
      policy: normalizedPolicy,
    });

  const enrichedEvent: PaymentEvent = {
    ...e,
    observedAt,
    observationTime: observedAt,
    policy: normalizedPolicy,
    policyVersion,
    policyMaxAgeMs,
    explanation,
  };

  // In-memory mirror (instant, and the only store when no DB is configured).
  try {
    if (!events.some((x) => x.paymentIdentifier === enrichedEvent.paymentIdentifier)) {
      events.push(enrichedEvent);
      if (events.length > MAX) events.splice(0, events.length - MAX);
    }
  } catch {
    /* ignore */
  }
  // Durable write — swallow errors (e.g. DB not configured) but log them. The
  // unique (network, payment_identifier) index makes a retry idempotent.
  return insertPayment({
    resource: enrichedEvent.resource,
    scheme: enrichedEvent.scheme,
    network: enrichedEvent.network,
    asset_address: enrichedEvent.assetAddress,
    asset_symbol: USDC_SYMBOL,
    asset_decimals: USDC_DECIMALS,
    amount_atomic: enrichedEvent.amountAtomic,
    payer: enrichedEvent.payer,
    seller: enrichedEvent.seller,
    transaction_hash: enrichedEvent.transactionHash,
    payment_identifier: enrichedEvent.paymentIdentifier,
    facilitator: enrichedEvent.facilitator,
    settled_at: enrichedEvent.settledAt,
    created_at: Date.now(),
  }).catch((err) => {
    console.warn("[payments] durable write failed:", err instanceof Error ? err.message : err);
  });
}

/** One recent payment, with exact atomic integer string + explicit decimals. */
export interface RevenuePaymentView {
  resource: string;
  network: string;
  assetSymbol: string;
  assetDecimals: number;
  /** Exact settled integer amount in atomic token units (base-10 string). */
  amountAtomic: string;
  /** Display-only conversion derived from `amountAtomic`. */
  amountUsdc: number;
  payer: string | null;
  seller: string | null;
  transactionHash: string | null;
  at: number;
  /** Privacy-safe verification decision, present only for in-memory events. */
  verification?: VerificationTrace;
  policy?: X402FreshnessPolicy;
  policyVersion?: string;
  observedAt?: number;
  explanation?: string;
}

export interface RevenueSummary {
  /** Decimals for all `*Atomic` integer string fields in this statement. */
  assetDecimals: number;
  totalCalls: number;
  /** Portion of totalCalls carried over from an earlier deployment (0 when unset). */
  baselineCalls: number;
  /** Exact integer total (ledger + baseline) in atomic token units. */
  totalAtomic: string;
  /** Exact integer baseline carried over from an earlier deployment (`"0"` when unset). */
  baselineAtomic: string;
  totalUsdc: number;
  /** Portion of totalUsdc carried over from an earlier deployment (0 when unset). */
  baselineUsdc: number;
  uniquePayers: number;
  uniqueSellers: number;
  byResource: Array<{ resource: string; calls: number; amountAtomic: string; usdc: number }>;
  bySeller: Array<{ seller: string; calls: number; amountAtomic: string; usdc: number }>;
  recent: RevenuePaymentView[];
  market: {
    settledMarkets: number;
    grossVolumeAtomic: string;
    payoutAtomic: string;
    platformFeeAtomic: string;
    agentOwnerFeeAtomic: string;
    dustAtomic: string;
    unclaimedAtomic: string;
    grossVolumeUsdc: number;
    payoutUsdc: number;
    platformFeeUsdc: number;
    agentOwnerFeeUsdc: number;
    dustUsdc: number;
    unclaimedUsdc: number;
  };
}

export interface OwnerRevenueStatement {
  owner: string;
  assetSymbol: string;
  assetDecimals: number;
  totalCalls: number;
  /** Exact integer sum of all settled payments to `owner` (base-10 string). */
  totalAtomic: string;
  /** Display-only conversion derived from `totalAtomic`. */
  totalUsdc: number;
  uniquePayers: number;
  byResource: Array<{ resource: string; calls: number; amountAtomic: string; usdc: number }>;
  payments: RevenuePaymentView[];
}

const EMPTY_MARKET: RevenueSummary["market"] = {
  settledMarkets: 0,
  grossVolumeAtomic: "0",
  payoutAtomic: "0",
  platformFeeAtomic: "0",
  agentOwnerFeeAtomic: "0",
  dustAtomic: "0",
  unclaimedAtomic: "0",
  grossVolumeUsdc: 0,
  payoutUsdc: 0,
  platformFeeUsdc: 0,
  agentOwnerFeeUsdc: 0,
  dustUsdc: 0,
  unclaimedUsdc: 0,
};

/**
 * Volume served before a database reset. Those rows may be gone, so displayed
 * totals resume on top of these figures instead of restarting at zero. Left
 * unset for the Stellar migration — the counter starts fresh on testnet USDC.
 */
function positiveEnvNumber(key: string): number {
  const n = Number(process.env[key] ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function baselineCalls(): number {
  return Math.floor(positiveEnvNumber("PAYMENTS_BASELINE_CALLS"));
}

/**
 * Exact integer baseline in 7-decimal atomic USDC, parsed without floating-point
 * arithmetic. Returns `0n` when unset, zero, negative, or malformed.
 */
export function baselineAtomic(
  env: Record<string, string | undefined> = process.env,
): bigint {
  const raw = env.PAYMENTS_BASELINE_USDC?.trim();
  if (!raw) return 0n;
  try {
    const parsed = parseUsdcAtomic(raw);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

export function baselineUsdc(): number {
  return unitsToUsdc(baselineAtomic());
}

function compareBigIntDesc(a: bigint, b: bigint): number {
  return b > a ? 1 : b < a ? -1 : 0;
}

/**
 * Build an exact owner/seller revenue statement from settled payment events.
 *
 * Accumulates all totals strictly in `bigint` atomic units (never IEEE-754
 * floats) and serializes every integer amount as a base-10 string alongside
 * explicit `assetDecimals`. Seller matching is exact case-sensitive base32.
 */
export function buildOwnerRevenueStatement(args: {
  owner: string;
  paymentEvents: readonly PaymentEvent[];
  limit?: number;
  assetDecimals?: number;
}): OwnerRevenueStatement {
  const { owner, paymentEvents, limit = 50, assetDecimals = USDC_DECIMALS } = args;
  const trimmedOwner = owner.trim();
  const matched: PaymentEvent[] = [];
  const byResource = new Map<string, { calls: number; atomic: bigint }>();
  const payers = new Set<string>();
  let totalAtomic = 0n;

  for (const e of paymentEvents) {
    if (e.seller !== trimmedOwner) continue;
    if (typeof e.amountAtomic !== "bigint" || e.amountAtomic < 0n) {
      throw new Error(`Invalid atomic payment amount for ${e.paymentIdentifier}`);
    }
    matched.push(e);
    totalAtomic += e.amountAtomic;
    if (e.payer) payers.add(e.payer);
    const r = byResource.get(e.resource) ?? { calls: 0, atomic: 0n };
    r.calls += 1;
    r.atomic += e.amountAtomic;
    byResource.set(e.resource, r);
  }

  return {
    owner: trimmedOwner,
    assetSymbol: USDC_SYMBOL,
    assetDecimals,
    totalCalls: matched.length,
    totalAtomic: totalAtomic.toString(),
    totalUsdc: unitsToUsdc(totalAtomic),
    uniquePayers: payers.size,
    byResource: [...byResource.entries()]
      .sort((a, b) => compareBigIntDesc(a[1].atomic, b[1].atomic))
      .map(([resource, v]) => ({
        resource,
        calls: v.calls,
        amountAtomic: v.atomic.toString(),
        usdc: unitsToUsdc(v.atomic),
      })),
    payments: matched
      .slice(-Math.max(0, limit))
      .reverse()
      .map((e) => ({
        resource: e.resource,
        network: e.network,
        assetSymbol: USDC_SYMBOL,
        assetDecimals,
        amountAtomic: e.amountAtomic.toString(),
        amountUsdc: unitsToUsdc(e.amountAtomic),
        payer: e.payer,
        seller: e.seller,
        transactionHash: e.transactionHash,
        at: e.settledAt,
      })),
  };
}

function fromDbSummary(s: PaymentsRevenueSummary): RevenueSummary {
  return {
    assetDecimals: USDC_DECIMALS,
    totalCalls: s.totalCalls,
    baselineCalls: 0,
    totalAtomic: s.totalAtomic.toString(),
    baselineAtomic: "0",
    baselineUsdc: 0,
    totalUsdc: unitsToUsdc(s.totalAtomic),
    uniquePayers: s.uniquePayers,
    uniqueSellers: s.uniqueSellers,
    byResource: s.byResource.map((r) => ({
      resource: r.resource,
      calls: r.calls,
      amountAtomic: r.amountAtomic.toString(),
      usdc: unitsToUsdc(r.amountAtomic),
    })),
    bySeller: s.bySeller.map((r) => ({
      seller: r.seller,
      calls: r.calls,
      amountAtomic: r.amountAtomic.toString(),
      usdc: unitsToUsdc(r.amountAtomic),
    })),
    recent: s.recent.map((r) => ({
      resource: r.resource,
      network: r.network,
      assetSymbol: r.asset_symbol,
      assetDecimals: r.asset_decimals ?? USDC_DECIMALS,
      amountAtomic: r.amount_atomic.toString(),
      amountUsdc: unitsToUsdc(r.amount_atomic),
      payer: r.payer,
      seller: r.seller,
      transactionHash: r.transaction_hash,
      at: r.settled_at,
    })),
    market: EMPTY_MARKET,
  };
}

function inMemorySummary(limit: number, offset: number): RevenueSummary {
  const byResource = new Map<string, { calls: number; atomic: bigint }>();
  const bySeller = new Map<string, { calls: number; atomic: bigint }>();
  const payers = new Set<string>();
  const sellers = new Set<string>();
  let totalAtomic = 0n;
  for (const e of events) {
    totalAtomic += e.amountAtomic;
    // Grouped on the exact string. Folding case here did not merely mis-key the
    // map: `bySeller` is keyed by this value and the key is what /revenue renders,
    // so a lowercased `G…` was surfaced to the UI as the seller's address.
    if (e.payer) payers.add(e.payer);
    if (e.seller) {
      const seller = e.seller;
      sellers.add(seller);
      const s = bySeller.get(seller) ?? { calls: 0, atomic: 0n };
      s.calls += 1;
      s.atomic += e.amountAtomic;
      bySeller.set(seller, s);
    }
    const r = byResource.get(e.resource) ?? { calls: 0, atomic: 0n };
    r.calls += 1;
    r.atomic += e.amountAtomic;
    byResource.set(e.resource, r);
  }
  return {
    assetDecimals: USDC_DECIMALS,
    totalCalls: events.length,
    baselineCalls: 0,
    totalAtomic: totalAtomic.toString(),
    baselineAtomic: "0",
    baselineUsdc: 0,
    totalUsdc: unitsToUsdc(totalAtomic),
    uniquePayers: payers.size,
    uniqueSellers: sellers.size,
    byResource: [...byResource.entries()]
      .sort((a, b) => compareBigIntDesc(a[1].atomic, b[1].atomic))
      .map(([resource, v]) => ({
        resource,
        calls: v.calls,
        amountAtomic: v.atomic.toString(),
        usdc: unitsToUsdc(v.atomic),
      })),
    bySeller: [...bySeller.entries()]
      .sort((a, b) => compareBigIntDesc(a[1].atomic, b[1].atomic))
      .map(([seller, v]) => ({
        seller,
        calls: v.calls,
        amountAtomic: v.atomic.toString(),
        usdc: unitsToUsdc(v.atomic),
      })),
    recent: events
      .slice()
      .reverse()
      .slice(offset, offset + limit)
      .map((e) => ({
        resource: e.resource,
        network: e.network,
        assetSymbol: USDC_SYMBOL,
        assetDecimals: USDC_DECIMALS,
        amountAtomic: e.amountAtomic.toString(),
        amountUsdc: unitsToUsdc(e.amountAtomic),
        payer: e.payer,
        seller: e.seller,
        transactionHash: e.transactionHash,
        at: e.settledAt,
        ...(e.verificationTrace ? { verification: e.verificationTrace } : {}),
        ...(e.policy && typeof e.policy === "object" ? { policy: e.policy } : {}),
        ...(e.policyVersion ? { policyVersion: e.policyVersion } : {}),
        ...(e.observedAt ? { observedAt: e.observedAt } : {}),
        ...(e.explanation ? { explanation: e.explanation } : {}),
      })),
    market: EMPTY_MARKET,
  };
}

/** Durable summary from Neon; falls back to the in-memory buffer on any error. */
export async function getRevenueSummary(limit = 25, offset = 0): Promise<RevenueSummary> {
  const withBaseline = (s: RevenueSummary): RevenueSummary => {
    const calls = baselineCalls();
    const baseAtomic = baselineAtomic();
    if (calls === 0 && baseAtomic === 0n) return s;
    const combinedAtomic = BigInt(s.totalAtomic) + baseAtomic;
    return {
      ...s,
      totalCalls: s.totalCalls + calls,
      baselineCalls: calls,
      totalAtomic: combinedAtomic.toString(),
      baselineAtomic: baseAtomic.toString(),
      totalUsdc: unitsToUsdc(combinedAtomic),
      baselineUsdc: unitsToUsdc(baseAtomic),
    };
  };
  try {
    const [payments, market] = await Promise.all([
      getPaymentsRevenueSummary(limit, offset),
      getMarketRevenueSummary(),
    ]);
    return {
      ...withBaseline(fromDbSummary(payments)),
      market: {
        settledMarkets: market.settledMarkets,
        grossVolumeAtomic: market.grossVolumeAtomic.toString(),
        payoutAtomic: market.payoutAtomic.toString(),
        platformFeeAtomic: market.platformFeeAtomic.toString(),
        agentOwnerFeeAtomic: market.agentOwnerFeeAtomic.toString(),
        dustAtomic: market.dustAtomic.toString(),
        unclaimedAtomic: market.unclaimedAtomic.toString(),
        grossVolumeUsdc: unitsToUsdc(market.grossVolumeAtomic),
        payoutUsdc: unitsToUsdc(market.payoutAtomic),
        platformFeeUsdc: unitsToUsdc(market.platformFeeAtomic),
        agentOwnerFeeUsdc: unitsToUsdc(market.agentOwnerFeeAtomic),
        dustUsdc: unitsToUsdc(market.dustAtomic),
        unclaimedUsdc: unitsToUsdc(market.unclaimedAtomic),
      },
    };
  } catch {
    return withBaseline(inMemorySummary(limit, offset));
  }
}
