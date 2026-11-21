/**
 * x402 v2 configuration — the single place that knows what Mimir sells, for how
 * much, and on which network.
 *
 * Scheme `exact`, asset USDC on Stellar. Prices are dollar strings; the
 * seller-side scheme in `./stellar-scheme.ts` resolves them to USDC atomic units
 * (7 decimals — see `lib/usdc.ts`).
 *
 * ── Why there is no facilitator URL here any more ────────────────────────────
 *
 * The EVM-era layer pointed at `x402.org`/CDP because `exact` on EVM is EIP-3009:
 * the buyer signs a `transferWithAuthorization` and a THIRD PARTY submits it and
 * pays the gas. Verification and settlement had to happen somewhere the payer was
 * not.
 *
 * On Stellar a fee is ~0.00001 XLM, so the buyer just submits its own payment and
 * presents the transaction hash. "Verify + settle" collapses into "read Horizon",
 * which Mimir does in-process — see {@link X402_SETTLEMENT_SOURCE}. The x402 SDK
 * still wants a `FacilitatorClient` object (its `initialize()` throws when no
 * facilitator advertises any supported kind), so `./stellar-scheme.ts` supplies a
 * local one that answers out of memory instead of over the network.
 */
import { USDC_ASSET, USDC_CODE, USDC_ISSUER, USDC_SAC_ID, parseUsdcAtomic } from "../usdc";
import { STELLAR_NETWORK, getHorizonUrl, isAccountAddress, isContractAddress } from "../stellar";

/**
 * CAIP-2 identifier for the network payments settle on.
 *
 * `stellar:<network>` per the CAIP-2 Stellar namespace, replacing the EVM
 * namespace-plus-chain-id form this used to carry. `@x402/core` types `Network`
 * as the free-form template literal `` `${string}:${string}` `` rather than a
 * constrained union, so this is a naming choice and not a registration: nothing
 * in the SDK validates the namespace. Overridable so a deployment on a different
 * Stellar network — or one that has to match another party's spelling — needs no
 * code change.
 */
export const X402_NETWORK = (process.env.X402_NETWORK?.trim() ||
  `stellar:${STELLAR_NETWORK}`) as `${string}:${string}`;
export const X402_SCHEME = "exact";

/**
 * The asset a payment must be denominated in, as `CODE:ISSUER`.
 *
 * **Deliberately the CLASSIC asset id, not the SAC contract id.** Verification
 * reads the payment back off Horizon, and a Horizon payment operation reports
 * `asset_code` + `asset_issuer` — it has no idea a Stellar Asset Contract wraps
 * the same balance. Configuring the `C…` SAC id here would give the verifier a
 * value it can never match against the ledger record it is checking. The SAC id
 * is still carried in the requirements' `extra` for buyers that want to move the
 * same balance through Soroban instead (see {@link X402_ASSET_SAC_ID}).
 */
export const X402_ASSET = USDC_ASSET;
export const X402_ASSET_CODE = USDC_CODE;
export const X402_ASSET_ISSUER = USDC_ISSUER;

/** The SAC id for the same balance — advertised, never used as the match key. */
export const X402_ASSET_SAC_ID = USDC_SAC_ID;

/**
 * Recorded as the `facilitator` of every settlement in the payments ledger.
 *
 * There is no third party in the loop, so what matters for an audit is WHICH
 * Horizon instance was believed about a transaction. A function, not a constant:
 * `getHorizonUrl()` is read lazily so a process that configures itself after
 * import still records the endpoint it actually queried.
 */
export function X402_SETTLEMENT_SOURCE(): string {
  return getHorizonUrl();
}

/**
 * How old a Stellar payment may be and still buy a response.
 *
 * A transaction hash is a permanent, publicly readable artifact: without an upper
 * bound on age, yesterday's payment would keep buying today's responses. Five
 * minutes is comfortably longer than the ~5s ledger close plus the buyer's own
 * round trip, and short enough that a proof is not worth harvesting. (Harvesting
 * it does not work anyway — the proof is signed by the payer's key — but a narrow
 * window is what makes that a second line of defence rather than the only one.)
 *
 * This constant is used by the verification layer to expire quotes before
 * verification, ensuring contract-first accounting and clear market semantics.
 */
export const X402_PAYMENT_MAX_AGE_MS = (() => {
  const raw = Number(process.env.X402_PAYMENT_MAX_AGE_MS ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5 * 60 * 1000;
})();

/**
 * Canonical version identifier for the x402 verification freshness policy.
 */
export const X402_FRESHNESS_POLICY_VERSION = "x402-freshness-v1";

/**
 * Versioned verification freshness policy shape applied during x402 proof checks.
 */
export interface X402FreshnessPolicy {
  version: string;
  maxAgeMs: number;
}

/**
 * Resolved dynamically so configuration changes (e.g. via process.env)
 * take effect without requiring module re-import.
 */
export function x402PaymentMaxAgeMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.X402_PAYMENT_MAX_AGE_MS ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : X402_PAYMENT_MAX_AGE_MS;
}

/**
 * Active verification freshness policy for current settlements.
 */
export function defaultFreshnessPolicy(maxAgeMs?: number): X402FreshnessPolicy {
  return {
    version: X402_FRESHNESS_POLICY_VERSION,
    maxAgeMs: maxAgeMs ?? x402PaymentMaxAgeMs(),
  };
}

/**
 * Default seller — usually the oracle wallet. Persona routes override per-request.
 */
export function sellerAddress(payTo?: string): string {
  const addr = (payTo ?? process.env.SELLER_ADDRESS ?? "").split(/\s+#/)[0].trim();
  if (!addr || !(isAccountAddress(addr) || isContractAddress(addr))) {
    throw new Error("SELLER_ADDRESS must be a Stellar address to sell paid resources");
  }
  return addr;
}

/** Every paid endpoint's price, in dollars. Buyers read these too. */
export const PRICES = {
  premiumPrice:      "$0.001",
  oracle:            "$0.005",
  councilPreflight:  "$0.001",
  councilReasoning:  "$0.001",
  councilVote:       "$0.001",
  councilSubscribe:  "$0.01",
} as const;

export type PriceKey = keyof typeof PRICES;

/** Dollar price string -> USDC atomic units, for buyer-side budget caps. */
export function priceToUsdcUnits(price: string): bigint {
  try { return parseUsdcAtomic(price.replace(/^\$/, "")); }
  catch { throw new Error(`Invalid x402 price: ${price}`); }
}

/**
 * Bazaar discovery metadata attached to every route so agents can find these
 * services without out-of-band docs.
 */
export interface PaidResourceMeta {
  description: string;
  mimeType: string;
  serviceName: string;
  tags: string[];
  example?: { input?: unknown; output?: unknown };
}

export const RESOURCE_META: Record<PriceKey, PaidResourceMeta> = {
  premiumPrice: {
    description:
      "Premium price oracle: current reference price plus a confidence band for a supported market symbol.",
    mimeType: "application/json",
    serviceName: "Mimir Premium Price Oracle",
    tags: ["price", "oracle", "market-data"],
    example: {
      input: { symbol: "BTC" },
      output: { symbol: "BTC", price: 64000, confidence: 0.92, at: 1760000000000 },
    },
  },
  oracle: {
    description:
      "Oracle-as-a-service: submit a claim and resolution URL, get an AI verdict with confidence and a SHA-256 evidence hash.",
    mimeType: "application/json",
    serviceName: "Mimir Oracle",
    tags: ["oracle", "settlement", "ai", "verdict"],
    example: {
      input: { question: "Will X ship by Friday?", resolutionUrl: "https://example.com/status" },
      output: { verdict: "CREATOR", confidence: 78, evidenceHash: "9f86d081…" },
    },
  },
  councilPreflight: {
    description:
      "Council preflight: one persona's open/revise/skip opinion and quality score on a draft market before it is created.",
    mimeType: "application/json",
    serviceName: "Mimir Council Preflight",
    tags: ["council", "review", "market-quality"],
    example: {
      input: { question: "Will X ship by Friday?", category: "tech" },
      output: { decision: "open", score: 72, confidence: 65, reasoning: "…" },
    },
  },
  councilReasoning: {
    description:
      "Council reasoning: a single persona's written take on an open claim. Paid directly to that persona's own wallet.",
    mimeType: "application/json",
    serviceName: "Mimir Council Reasoning",
    tags: ["council", "reasoning", "persona"],
    example: {
      input: { claimId: 12, persona: "optimist" },
      output: { persona: { slug: "optimist" }, claimId: 12, reasoning: "…" },
    },
  },
  councilVote: {
    description:
      "Council vote: a single persona's structured verdict on a claim, paid directly to that persona's own wallet.",
    mimeType: "application/json",
    serviceName: "Mimir Council Vote",
    tags: ["council", "vote", "jury", "settlement"],
    example: {
      input: { claimId: 12, persona: "statistician" },
      output: { claimId: 12, verdict: "CHALLENGERS", confidence: 71, explanation: "…" },
    },
  },
  councilSubscribe: {
    description:
      "Council pass: a short-lived signed pass that unlocks council reasoning reads without a per-request payment.",
    mimeType: "application/json",
    serviceName: "Mimir Council Pass",
    tags: ["council", "pass", "subscription"],
    example: {
      input: {},
      output: { plan: "council-pass", pass: "…", expiresAt: 1760000600000, ttlMs: 600000 },
    },
  },
};
