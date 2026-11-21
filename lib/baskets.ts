import { isValidBps } from "./money";

/**
 * What the creator signs when composing a basket. Readable, because a hardware
 * wallet shows it verbatim.
 *
 * The address is interpolated verbatim: a Stellar strkey is case-sensitive
 * base32, so any toLowerCase() on it would produce a string no wallet ever signed.
 *
 * The message also carries a nonce and an expiry timestamp, exactly like
 * transferMessage:
 *
 *  - `nonce`    — a client-generated UUID, consumed on the server after
 *                  first use so the same signed message is rejected on replay.
 *  - `expiresAt` — an ISO-8601 timestamp; the server rejects the message
 *                  if the current time is past this value.
 *
 * This means a captured basket-creation signature cannot be replayed to
 * insert duplicate baskets.
 */
export class BasketValidationError extends Error {
  constructor(
    message: string,
    public readonly agentId?: string,
    public readonly weights?: number[],
  ) {
    super(message);
    this.name = "BasketValidationError";
  }
}

export interface BasketMember {
  agentId: string;
  weightBps: number;
}

/**
 * Reject duplicate members carrying conflicting weights (#894).
 *
 * A basket composition is valid iff every agentId appears at most once, OR
 * appears multiple times with the *identical* weight (which collapses to a
 * single entry — the deterministic canonical form).
 *
 * Deterministic and side-effect free: the error names the offending agentId
 * and the conflicting weights, but no timestamps, orderings, or host data.
 */
export function validateBasketComposition(members: readonly BasketMember[]): void {
  const byAgent = new Map<string, number[]>();
  for (const member of members) {
    if (typeof member.agentId !== "string" || member.agentId.length === 0) {
      throw new BasketValidationError("basket member has empty agentId");
    }
    if (!Number.isInteger(member.weightBps) || member.weightBps <= 0) {
      throw new BasketValidationError(
        "basket member weightBps must be a positive integer",
        member.agentId,
        [member.weightBps],
      );
    }
    const weights = byAgent.get(member.agentId) ?? [];
    weights.push(member.weightBps);
    byAgent.set(member.agentId, weights);
  }
  for (const [agentId, weights] of byAgent) {
    if (weights.length > 1 && new Set(weights).size > 1) {
      throw new BasketValidationError(
        `duplicate basket member ${agentId} carries conflicting weights: ${weights.join(", ")}`,
        agentId,
        weights.slice(),
      );
    }
  }
}

/**
 * Return the canonical member ordering, collapsing identical-weight duplicates.
 *
 * Sort key: agentId ascending; tie-break by weightBps ascending. Two baskets
 * with the same members produce byte-identical canonical arrays regardless of
 * input order. Call ONLY after validateBasketComposition() has passed.
 */
export function canonicalizeMembers(members: readonly BasketMember[]): BasketMember[] {
  const byAgent = new Map<string, number>();
  for (const member of members) {
    const existing = byAgent.get(member.agentId);
    if (existing === undefined) {
      byAgent.set(member.agentId, member.weightBps);
    } else if (existing !== member.weightBps) {
      // Defensive: validateBasketComposition should have rejected this.
      throw new BasketValidationError(
        `canonicalizeMembers received conflicting weights for ${member.agentId}`,
        member.agentId,
        [existing, member.weightBps],
      );
    }
  }
  return [...byAgent.entries()]
    .map(([agentId, weightBps]) => ({ agentId, weightBps }))
    .sort((a, b) => {
      if (a.agentId !== b.agentId) return a.agentId < b.agentId ? -1 : 1;
      return a.weightBps - b.weightBps;
    });
}

export function basketMessage(args: {
  name: string; creator: string; members: Array<{ agentId: string; weightBps: number }>;
  nonce: string; expiresAt: number;
}): string {
  // Validate before serialization (#894): a signed message must not carry a
  // contradictory composition. Canonicalize so signature bytes are stable
  // regardless of the caller's array order.
  validateBasketComposition(args.members);
  const canonicalMembers = canonicalizeMembers(args.members);
  return [
    "Mimir basket",
    `name: ${args.name}`,
    `creator: ${args.creator}`,
    `members: ${canonicalMembers.map((m) => `${m.agentId}:${m.weightBps}`).join(",")}`,
    `nonce: ${args.nonce}`,
    `expiresAt: ${new Date(args.expiresAt).toISOString()}`,
  ].join("\n");
}

/**
 * How long a basket-creation authorisation is valid from the moment it is
 * signed. Matches TRANSFER_EXPIRY_MS so the clock-skew budget is the same
 * across all signed mutations.
 */
export const BASKET_EXPIRY_MS = 5 * 60_000; // 5 minutes

/**
 * How long a transfer authorisation is valid from the moment it is signed.
 *
 * Five minutes matches the agent-request clock-skew window
 * (`AGENT_REQUEST_MAX_SKEW_MS` in lib/agents/api.ts`). A signer generates the
 * message, signs it in their wallet, and submits — that round-trip is well
 * inside five minutes. Any captured signature is useless after the window.
 */
export const TRANSFER_EXPIRY_MS = 5 * 60_000; // 5 minutes

/**
 * What the CURRENT owner signs to authorise a transfer.
 *
 * Both addresses are interpolated verbatim — Stellar strkeys are case-sensitive
 * base32 and must never be lowercased. The message also includes:
 *
 *  - `nonce`    — a client-generated UUID, stored on the server after first use
 *                  so the same signed message is rejected on any replay attempt.
 *  - `expiresAt` — an ISO-8601 timestamp; the server rejects the message if the
 *                  current time is past this value. Limits the replay window even before
 *                  the nonce has been persisted (e.g. during a DB outage).
 *
 * Together these two fields mean:
 *   - A signature captured in transit cannot be replayed after TRANSFER_EXPIRY_MS.
 *   - Even within the window, submitting the same signed payload twice is rejected
 *     by the UNIQUE(nonce) constraint on basket_ownership_transfers.
 *   - If ownership cycles A–B→…, the old A–B→… signature is still unusable because
 *     its nonce was consumed on first use.
 */
export function transferMessage(args: {
  basketId: string;
  currentOwner: string;
  newOwner: string;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    "Mimir basket transfer",
    `basket: ${args.basketId}`,
    `from: ${args.currentOwner}`,
    `to: ${args.newOwner}`,
    `nonce: ${args.nonce}`,
    `expiresAt: ${new Date(args.expiresAt).toISOString()}`,
  ].join("\n");
}

/**
 * What a subscriber signs to follow or unfollow a basket.
 *
 * The action is part of the signed text, so a subscribe signature can never be
 * presented as an unsubscribe (or the reverse), and the nonce plus a short
 * expiry make each signature single-use. The address is interpolated
 * VERBATIM: a Stellar strkey is case-sensitive base32. Shared by the route and
 * the browser so both build the message byte for byte.
 */
export function subscriptionMessage(args: {
  action: "subscribe" | "unsubscribe";
  basketId: string;
  subscriber: string;
  perMarketUsdc: number;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    "Mimir basket subscription",
    `action: ${args.action}`,
    `basket: ${args.basketId}`,
    `subscriber: ${args.subscriber}`,
    `per market: ${args.perMarketUsdc} USD`,
    `nonce: ${args.nonce}`,
    `expiresAt: ${new Date(args.expiresAt).toISOString()}`,
    "Mimir never holds your funds. Every stake is signed by you.",
  ].join("\n");
}

/** Minimum per-market amount in USDC that a follower can set. */
export const PER_MARKET_MIN_USDC = 1;

/** Maximum per-market amount in USDC that a follower can set. */
export const PER_MARKET_MAX_USDC = 100;

export type PerMarketParseResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Parse the raw string from the per-market input into a valid USDC amount.
 *
 * The input keeps the raw string in state while editing so the field can be
 * cleared and retyped freely; this helper is the single source of truth for
 * whether the current value is acceptable and what error to show if not.
 */
export function parsePerMarketUsdc(raw: string): PerMarketParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: `Enter an amount between ${PER_MARKET_MIN_USDC} and ${PER_MARKET_MAX_USDC} USDC.`,
    };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { ok: false, error: "Enter a valid number." };
  }
  if (!Number.isInteger(n)) {
    return { ok: false, error: "Use a whole number of USDC." };
  }
  if (n < PER_MARKET_MIN_USDC || n > PER_MARKET_MAX_USDC) {
    return {
      ok: false,
      error: `Enter an amount between ${PER_MARKET_MIN_USDC} and ${PER_MARKET_MAX_USDC} USDC.`,
    };
  }
  return { ok: true, value: n };
}

/**
 * The ids of curated baskets that ship with Mimir.
 *
 * Kept here (the pure computation module, no server-only dependency) so that
 * tests and non-server code can verify the curated-basket guard without pulling
 * in lib/server/basket-directory which carries `import "server-only"`.
 *
 * This list must stay in sync with the basket directory.
 */
export const CURATED_BASKET_IDS: readonly string[] = [];

/**
 * A single point on a basket's NAV series.
 */
export interface NavPoint {
  /** ISO-8601 timestamp for the point. */
  t: string;
  /** Net asset value, indexed to 100 at the first point. */
  nav: number;
}

/**
 * A member's contribution to the basket NAV.
 */
export interface NavMember {
  agentId: string;
  weightBps: number;
  category: string;
  mode: string;
  paused?: boolean;
  stale?: boolean;
  /** Per-period returns for this member, as decimals (e.g. 0.01 = +1%). */
  returns: number[];
}

export interface BasketReturnPoint { timestamp: number; returnsBps: Record<string, number> }
export interface BasketPolicy { maxSingleAgentBps: number; maxCategoryBps: number; staleSignalAction: "skip" | "pause"; failedCopyAction: "keep_idle" | "pause" }
export interface BasketSnapshot { timestamp: number; navAtomic: bigint; drawdownBps: number }

export const VIRTUAL_BASKET_INITIAL_NAV_ATOMIC = 1_000_000_000n;

export const DEFAULT_BASKET_POLICY: BasketPolicy = {
  maxSingleAgentBps: 4_000,
  maxCategoryBps: 6_000,
  staleSignalAction: "skip",
  failedCopyAction: "keep_idle",
};

export type BasketExposurePreviewStatus = "empty" | "incomplete" | "invalid" | "ready";

export interface BasketExposureBar {
  key: string;
  bps: number;
  /** True when this bar alone breaches the matching policy cap. */
  overLimit: boolean;
}

export interface BasketExposurePreview {
  status: BasketExposurePreviewStatus;
  totalBps: number;
  categories: Record<string, number>;
  modes: Record<string, number>;
  categoryBars: BasketExposureBar[];
  modeBars: BasketExposureBar[];
  agentBars: BasketExposureBar[];
  errors: string[];
  policy: BasketPolicy;
}

/**
 * Build a NAV series from basket member performance.
 *
 * The series is indexed to 100 at the first point. Each subsequent point is the
 * weighted return of the members for that period. Members whose weights do not
 * sum to 10000 baps are normalised against the total weight, so a partially-
 * composed basket still produces a sensible series. Returns an empty array when
 * there is not enough information to draw a line.
 */
export function buildNavSeries(
  members: readonly NavMember[],
  startsAt: Date = new Date(0),
  periodMs: number = 24 * 60 * 60 * 1000,
): NavPoint[] {
  if (members.length === 0) return [];

  const validMembers = members.filter(
    (m) => isValidBps(m.weightBps) && m.weightBps > 0 && m.returns.length > 0,
  );
  if (validMembers.length === 0) return [];

  const totalWeight = validMembers.reduce((sum, m) => sum + m.weightBps, 0);
  if (totalWeight <= 0) return [];

  const periods = Math.min(...validMembers.map((m) => m.returns.length));
  if (periods < 1) return [];

  const points: NavPoint[] = [];
  let nav = 100;
  points.push({ t: new Date(startsAt.getTime()).toISOString(), nav });

  for (let period = 0; period < periods; period++) {
    let weightedReturn = 0;
    for (const member of validMembers) {
      weightedReturn += (member.weightBps / totalWeight) * member.returns[period];
    }
    nav *= 1 + weightedReturn;
    const t = new Date(startsAt.getTime() + (period + 1) * periodMs).toISOString();
    points.push({ t, nav: Number(nav.toFixed(4)) });
  }

  return points;
}

/** Performance fee applies only to realized NAV above the previous high-water mark. */
export function highWaterMarkFee(navAtomic: bigint, highWaterMarkAtomic: bigint, performanceFeeBps: bigint) {
  if (performanceFeeBps < 0n || performanceFeeBps > 1_000n) throw new Error("performance fee cap");
  const gain = navAtomic > highWaterMarkAtomic ? navAtomic - highWaterMarkAtomic : 0n;
  const feeAtomic = (gain * performanceFeeBps) / 10_000n;
  return { feeAtomic, nextHighWaterMarkAtomic: navAtomic > highWaterMarkAtomic ? navAtomic : highWaterMarkAtomic };
}

export function sharesForDeposit(assetsAtomic: bigint, totalAssetsAtomic: bigint, totalSharesAtomic: bigint): bigint {
  if (assetsAtomic <= 0n) throw new Error("zero deposit");
  if (totalSharesAtomic === 0n) return assetsAtomic;
  if (totalAssetsAtomic <= 0n) throw new Error("invalid insolvent vault");
  return (assetsAtomic * totalSharesAtomic) / totalAssetsAtomic;
}

export function assetsForRedemption(sharesAtomic: bigint, totalAssetsAtomic: bigint, totalSharesAtomic: bigint): bigint {
  if (sharesAtomic <= 0n || totalSharesAtomic <= 0n) throw new Error("invalid redemption");
  return (sharesAtomic * totalAssetsAtomic) / totalSharesAtomic;
}

const DAY_MS = 86_400_000;

/** One agent's settled result, as the basket engine needs to see it. */
export interface BasketAgentResult {
  agentId: string;
  /** Milliseconds. */
  settledAt: number;
  pnlAtomic: bigint;
  stakeAtomic: bigint;
}

/**
 * Daily return per agent, in basis points of what that agent staked that day.
 *
 * Weighted by stake rather than counting trades: a 10 USDC decision and a 1 USDC one
 * are not two equal votes, and averaging them as if they were flatters whoever bets
 * small and often.
 *
 * Days with no settlement produce no point at all, so an idle agent contributes a
 * flat line rather than a zero that drags the basket's average down.
 */
export function dailyReturnPoints(results: readonly BasketAgentResult[]): BasketReturnPoint[] {
  const byDay = new Map<number, Map<string, { pnl: bigint; stake: bigint }>>();

  for (const result of results) {
    if (result.stakeAtomic <= 0n) continue;
    const day = Math.floor(result.settledAt / DAY_MS) * DAY_MS;
    const agents = byDay.get(day) ?? new Map();
    const prev = agents.get(result.agentId) ?? { pnl: 0n, stake: 0n };
    agents.set(result.agentId, { pnl: prev.pnl + result.pnlAtomic, stake: prev.stake + result.stakeAtomic });
    byDay.set(day, agents);
  }

  const points: BasketReturnPoint[] = [];
  for (const [day, agents] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const returnsBps: Record<string, number> = {};
    for (const [agentId, { pnl, stake }] of agents) {
      returnsBps[agentId] = Number((pnl * 10_000n) / stake);
    }
    points.push({ timestamp: day, returnsBps });
  }
  return points;
}

function completeSeries(members: readonly NavMember[], periods: number): boolean {
  return members.every((m) =>
    m.returns.slice(0, periods).every((r) => Number.isFinite(r)),
  );
}

/** Stellar Testnet USDC SAC decimals (7, not 6). */
export const MIRROR_USDC_DECIMALS = 7;

/** 1 USDC in atomic units (10^7). */
export const MIRROR_USDC_UNIT = 10_000_000n;

/**
 * Convert a non-negative USDC amount into exact 7-decimal atomic units.
 *
 * - `bigint` inputs are treated as already-atomic units.
 * - `string` inputs are parsed as decimal USDC with up to 7 fractional digits.
 * - `number` inputs are normalized to 7 fixed decimal places before integer parsing
 *   to avoid IEEE-754 representation artifacts (e.g. `0.1 + 0.2`).
 */
export function toUsdcAtomic(amount: bigint | string | number): bigint {
  if (typeof amount === "bigint") {
    if (amount < 0n) throw new Error("USDC amount must be non-negative");
    return amount;
  }
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("USDC amount must be a finite non-negative number");
    }
    const [whole, fraction = ""] = amount.toFixed(MIRROR_USDC_DECIMALS).split(".");
    return BigInt(whole) * MIRROR_USDC_UNIT + BigInt(fraction.padEnd(MIRROR_USDC_DECIMALS, "0"));
  }
  const trimmed = amount.trim();
  if (!/^\d+(?:\.\d{1,7})?$/.test(trimmed)) {
    throw new Error("Invalid USDC amount");
  }
  const [whole, fraction = ""] = trimmed.split(".");
  return BigInt(whole) * MIRROR_USDC_UNIT + BigInt(fraction.padEnd(MIRROR_USDC_DECIMALS, "0"));
}

/**
 * Compute the exact atomic mirror stake for a subscriber's per-market budget
 * scaled by a basket member's basis-point weight.
 *
 * Uses integer division (`(budgetAtomic * weightBps) / 10_000n`) so the result
 * never suffers floating-point drift or rounds up past the subscriber's cap.
 * Returns `0n` for invalid or non-positive inputs.
 */
export function computeMirrorAmountAtomic(
  perMarketUsdc: bigint | string | number,
  weightBps: number,
): bigint {
  if (!isValidBps(weightBps) || weightBps === 0) return 0n;
  let budgetAtomic: bigint;
  try {
    budgetAtomic = toUsdcAtomic(perMarketUsdc);
  } catch {
    return 0n;
  }
  if (budgetAtomic <= 0n) return 0n;
  return (budgetAtomic * BigInt(weightBps)) / 10_000n;
}

/**
 * Format an exact 7-decimal atomic USDC string (or bigint) for display in a
 * UI consumer without passing through IEEE-754 floats.
 *
 * When `fixedDecimals` is provided, renders exactly that many fractional digits
 * (truncated toward zero, e.g. `"6666000"` with `2` -> `"0.66"`). When omitted,
 * renders the exact decimal value with trailing fractional zeros stripped
 * (e.g. `"6666000"` -> `"0.6666"`).
 */
export function formatMirrorAtomicUsdc(
  atomic: string | bigint,
  fixedDecimals?: number,
): string {
  const value = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const whole = abs / MIRROR_USDC_UNIT;
  const rawFraction = (abs % MIRROR_USDC_UNIT).toString().padStart(MIRROR_USDC_DECIMALS, "0");

  if (fixedDecimals !== undefined) {
    const digits = Math.max(0, Math.min(MIRROR_USDC_DECIMALS, Math.trunc(fixedDecimals)));
    if (digits === 0) return `${sign}${whole}`;
    return `${sign}${whole}.${rawFraction.slice(0, digits)}`;
  }

  const trimmed = rawFraction.replace(/0+$/, "");
  return trimmed ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`;
}
