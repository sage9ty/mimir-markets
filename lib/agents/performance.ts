/*
 * Agent performance from settled markets.
 *
 * The read index stores stakes in display USDC (a NUMERIC column holding 2, not
 * 2000000), so every figure is converted to atomic units on the way in and stays a
 * bigint from there. Summing money as floats drifts, and a P&L that disagrees with
 * the chain by a rounding error is a P&L nobody trusts.
 *
 * Realised P&L counts only settled markets. Open positions are reported separately
 * as exposure rather than folded in as unrealised profit, because a stake that has
 * not settled is not a gain in either direction.
 */

import { USDC_DECIMALS, USDC_UNIT, unitsToUsdc } from "@/lib/usdc";

export type AgentTradeRole = "creator" | "challenger";

export interface AgentTradeRow {
  claimId: number;
  role: AgentTradeRole;
  /** What the agent put in, display USDC as stored. */
  stake: number;
  /** Creator side: the pooled challenger stake facing them. */
  opposingStake: number;
  /** Challenger side: what the contract would pay this address on a win. */
  potentialPayout: number;
  state: string;
  winnerSide: string;
  /** Milliseconds; chain settlement time when projected, otherwise the row update time. */
  settledAt: number;
  category: string;
  question: string;
}

export type TradeOutcome = "won" | "lost" | "refunded" | "open";

export interface AgentTradeResult extends AgentTradeRow {
  outcome: TradeOutcome;
  /** Realised profit in atomic USDC; zero while open or refunded. */
  pnlAtomic: bigint;
  stakeAtomic: bigint;
}

export interface AgentPerformance {
  trades: number;
  settled: number;
  wins: number;
  losses: number;
  refunds: number;
  open: number;
  realisedPnlAomic: bigint;
  openExposureAtomic: bigint;
  /** Everything the agent has ever staked, settled or not. */
  volumeAtomic: bigint;
  /** Wins over decided markets, in basis points. Refunds are not decisions. */
  winRateBps: number;
  /** Best and worst single settled market, for the detail page. */
  bestPnlAtomic: bigint;
  worstPnlAtomic: bigint;
}

/**
 * Display USDC to atomic, without going through a float multiply.
 *
 * `2.05 * 1e7` is 20499999.999999998 in IEEE754; rounding the string instead keeps
 * the last decimal honest.
 *
 * The scale comes from {@link USDC_DECIMALS}, not a literal. It was hardcoded at 6
 * — correct for a 6-decimal ERC-20, wrong here — and made every P&L on this page
 * a factor of ten smaller than the same money everywhere else in the app.
 *
 * Deliberately NOT `usdcToUnits`: that one throws on a negative or non-finite
 * input, and this is fed by read-index rows. A missing column must degrade to zero
 * rather than take a dashboard down, and a negative P&L is a legitimate value here.
 */
export function usdcDisplayToAtomic(value: number): bigint {
  if (!Number.isFinite(value)) return 0n;
  const negative = value < 0;
  const [whole, fraction = ""] = Math.abs(value).toFixed(USDC_DECIMALS).split(".");
  const atomic =
    BigInt(whole) * USDC_UNIT
    + BigInt(fraction.padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS));
  return negative ? -atomic : atomic;
}

/** A settled market pays the winner the loser's stake; a refund returns the stake. */
export function classifyTrade(row: AgentTradeRow): AgentTradeResult {
  const stakeAtomic = usdcDisplayToAtomic(row.stake);
  const base = { ...row, stakeAtomic };
  const decided = row.state === "resolved";

  if (!decided) {
    // Cancelled markets refund the creator's stake: no gain, no loss.
    const outcome: TradeOutcome = row.state === "cancelled" ? "refunded" : "open";
    return { ...base, outcome, pnlAtomic: 0n };
  }

  const winner = row.winnerSide.toLowerCase();
  if (winner !== "creator" && winner !== "challengers") {
    // Draw and unresolvable both return stakes.
    return { ...base, outcome: "refunded", pnlAtomic: 0n };
  }

  const won = (row.role === "creator" && winner === "creator")
    || (row.role === "challenger" && winner === "challengers");

  if (!won) return { ...base, outcome: "lost", pnlAtomic: -stakeAtomic };

  // A creator wins the pooled challenger stake. A challenger's payout is already
  // computed per address by the contract, so the profit is payout minus stake.
  const gross = row.role === "creator"
    ? usdcDisplayToAtomic(row.opposingStake)
    : usdcDisplayToAtomic(row.potentialPayout) - stakeAtomic;
  return { ...base, outcome: "won", pnlAtomic: gross > 0n ? gross : 0n };
}

export interface PerformanceWindow {
  /** Only count settlements at or after this moment. Open positions always count. */
  sinceMs?: number;
}

export function computeAgentPerformance(
  rows: readonly AgentTradeRow[],
  window: PerformanceWindow = {},
): { performance: AgentPerformance; results: AgentTradeResult[] } {
  const results = rows.map(classifyTrade);
  const since = window.sinceMs ?? 0;

  let settled = 0, wins = 0, losses = 0, refunds = 0, open = 0;
  let realisedPnlAtomic = 0n, openExposureAtomic = 0n, volumeAtomic = 0n;
  let bestPnlAtomic = 0n, worstPnlAtomic = 0n;

  for (const result of results) {
    volumeAtomic += result.stakeAtomic;
    if (result.outcome === "open") {
      open += 1;
      openExposureAtomic += result.stakeAtomic;
      continue;
    }
    // A window filters history, never the present: an open stake is exposure now
    // regardless of when it was opened.
    if (result.settledAt < since) continue;
    settled += 1;
    if (result.outcome === "won") wins += 1;
    else if (result.outcome === "lost") losses += 1;
    else refunds += 1;
    realisedPnlAtomic += result.pnlAtomic;
    if (result.pnlAtomic > bestPnlAtomic) bestPnlAtomic = result.pnlAtomic;
    if (result.pnlAtomic < worstPnlAtomic) worstPnlAtomic = result.pnlAtomic;
  }

  const decided = wins + losses;
  return {
    performance: {
      trades: results.length, settled, wins, losses, refunds, open,
      realisedPnlAtomic, openExposureAtomic, volumeAtomic,
      winRateBps: decided > 0 ? Math.round((wins / decided) * 10_000) : 0,
      bestPnlAtomic, worstPnlAtomic,
    },
    results,
  };
}

export const TIME_WINDOWS = ["24h", "7d", "30d", "all"] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

export function isTimeWindow(value: string): value is TimeWindow {
  return (TIME_WINDOWS as readonly string[]).includes(value);
}

/** Undefined for "all": no lower bound is different from a bound of zero. */
export function windowSinceMs(window: TimeWindow, nowMs: number): number | undefined {
  const hours = window === "24h" ? 24 : window === "7d" ? 24 * 7 : window === "30d" ? 24 * 30 : 0;
  return hours === 0 ? undefined : nowMs - hours * 3_600_000;
}

export interface PnlPoint {
  timestamp: number;
  /** Running realised P&L in display USDC. */
  value: number;
}

/**
 * Cumulative realised P&L over time, one point per settled market.
 *
 * Running total rather than per-trade bars: the question a P&L curve answers is
 * "is this agent up or down", and a bar chart of individual results makes the
 * reader do the addition.
 *
 * Refunds are included as flat points. They are part of the sequence even though
 * they move nothing, and dropping them would make an idle stretch look like a gap.
 */
export function cumulativePnlPoints(
  results: readonly AgentTradeResult[],
  window: PerformanceWindow = {},
): PnlPoint[] {
  const since = window.sinceMs ?? 0;
  const settled = results
    .filter((result) => result.outcome !== "open" && result.settledAt >= since)
    .sort((a, b) => a.settledAt - b.settledAt);

  let running = 0n;
  return settled.map((result) => {
    running += result.pnlAtomic;
    return { timestamp: result.settledAt, value: unitsToUsdc(running) };
  });
}
