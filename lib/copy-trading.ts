/**
 * Copy trading policy and deterministic execution gate.
 *
 * Every USDC figure that crosses a boundary here is atomic at **7 decimals**
 * (`lib/usdc.ts`), not the 6 the EVM-era ERC-20 used. `maxRealizedLossAtomic`,
 * `realizedLossAtomic`, and `principalAtRiskAtomic` are the fields where that
 * matters, because they are the only ones supplied as atomic strings rather than
 * derived from a display number through `parseUsdcAtomic` — a 6-decimal value
 * there reads as a tenth of the intended limit and stops copying ten times too
 * early.
 *
 * Principal-at-risk vs realized loss
 * ───────────────────────────────────
 * `realizedLossAtomic`    — settled losses only. Sourced from settlement/payout
 *                           outcomes, NOT from execution audit rows (which carry
 *                           spend but not resolution).
 * `principalAtRiskAtomic` — the sum of stakes in open (unclosed) copy positions.
 *                           These have not yet resolved; treating them as already
 *                           realized would understate available headroom.
 *
 * The loss gate checks:
 *   realizedLossAtomic + principalAtRiskAtomic + stakeAtomic ≤ maxRealizedLossAtomic
 *
 * This keeps worst-case total exposure bounded while correctly distinguishing what
 * has been lost from what is merely at risk in open positions.
 */

import { sha256Hex } from "@/lib/content-hash";
import { isPaused } from "@/lib/ops/flags";
import { isAccountAddress, isContractAddress } from "@/lib/stellar";
import { parseUsdcAtomic } from "@/lib/usdc";

/** A wallet or contract id. Case-sensitive base32: never fold it. */
function isStellarAddress(value: string): boolean {
  const trimmed = value?.trim() ?? "";
  return isAccountAddress(trimmed) || isContractAddress(trimmed);
}

export interface CopyPermission {
  permissionId: string;
  ownerWallet: string;
  executionAgentId: string;
  signalAgentId: string;
  maxPerPositionUsdc: number;
  dailyCapUsdc: number;
  weeklyCapUsdc: number;
  totalOpenExposureUsdc: number;
  /**
   * Ceiling for the sum of settled losses and open principal at risk.
   * The gate checks: `realizedLossAtomic + principalAtRiskAtomic + stakeAtomic ≤ maxRealizedLossAtomic`.
   * Atomic USDC at 7 decimals — 15 USDC is `"150000000"`.
   */
  maxRealizedLossAtomic: string;
  allowedCategories: string[];
  allowedModes: string[];
  minConfidenceBps: number;
  minPayoutBps: number;
  expiresAt: number;
  depth: 1;
  status: "active" | "revoked" | "paused";
  spendPermission: { token: string; spender: string; allowanceAtomic: bigint; periodSeconds: number };
  signedPolicyHash: string;
}

export interface CopyUsage {
  usedTodayUsdc: number;
  usedThisWeekUsdc: number;
  openExposureUsdc: number;
  /**
   * Settled (realized) losses only, in atomic USDC at 7 decimals.
   * Must come from settlement/payout outcomes — NOT from execution audit rows,
   * which carry spend but not resolution.
   */
  realizedLossAtomic: string;
  /**
   * Sum of stakes in open (unclosed) copy positions, in atomic USDC at 7 decimals.
   * These are principal at risk: they have not yet resolved and must NOT be
   * counted as realized loss. The loss gate adds this to `realizedLossAtomic`
   * before comparing against `maxRealizedLossAtomic`.
   */
  principalAtRiskAtomic: string;
}

export interface CopySignal {
  sourcePositionId: string;
  signalAgentId: string;
  sourceDepth: number;
  claimId: number;
  category: string;
  mode: string;
  confidenceBps: number;
  payoutBps: number;
  stakeUsdc: number;
  deadline: number;
  remainingSlots: number;
  availableLiquidityUsdc: number;
  requiredLiquidityUsdc: number;
  sourceAttributionId: string;
  /** Optional chain status for callers that have already fetched the live claim. */
  marketState?: "open" | "active" | "resolved" | "cancelled";
}

export type CopySkipReason =
  | "global_paused" | "permission_revoked" | "permission_paused" | "permission_expired"
  | "malformed_signal" | "malformed_context" | "signal_agent_mismatch"
  | "self_copy" | "copy_depth" | "cycle" | "duplicate_position" | "stale_signal"
  | "market_cancelled" | "market_closed" | "market_full" | "liquidity_exhausted"
  | "category_blocked" | "mode_blocked"
  | "confidence_below_floor" | "payout_below_floor" | "position_cap"
  | "daily_cap" | "weekly_cap" | "open_exposure_cap" | "spend_permission_mismatch"
  | "loss_limit" | "simulation_failed";

export interface CopyExecutionContext {
  now: number;
  /** Caller-side stop. MIMIR_PAUSE_COPY_EXECUTION is checked regardless of this. */
  globalPaused: boolean;
  /** Env the incident switch is read from; defaults to process.env. */
  env?: Record<string, string | undefined>;
  usage: CopyUsage;
  existingClaimIds: ReadonlySet<number>;
  ancestryAgentIds: readonly string[];
  configuredUsdc: string;
  configuredSpender: string;
  onchainAllowanceAtomic: bigint;
  /**
   * Outcome of simulating the stake before signing it. `blockNumber` keeps its
   * name because `lib/db.ts` persists it under that column; on Stellar the value
   * is the LEDGER SEQUENCE the simulation was run against.
   */
  simulation: { ok: boolean; blockNumber: bigint; reason?: string };
}

/**
 * What the owner signs to grant (or re-grant) a copy permission.
 *
 * Bound to the action, a single-use nonce and a short expiry so a captured
 * request body cannot be replayed, and so a grant signature can never be
 * presented as a revocation or vice versa. The wallet is interpolated VERBATIM:
 * a Stellar strkey is case-sensitive base32.
 */
export function copyGrantMessage(args: {
  permissionId: string; ownerWallet: string; policyHash: string; nonce: string; expiresAt: number;
}): string {
  return [
    "Mimir copy permission",
    "action: grant",
    `permission: ${args.permissionId}`,
    `owner: ${args.ownerWallet}`,
    `policyHash: ${args.policyHash}`,
    `nonce: ${args.nonce}`,
    `expiresAt: ${new Date(args.expiresAt).toISOString()}`,
  ].join("\n");
}

/** What the owner signs to revoke a copy permission. See {@link copyGrantMessage}. */
export function copyRevokeMessage(args: {
  permissionId: string; ownerWallet: string; nonce: string; expiresAt: number;
}): string {
  return [
    "Mimir revoke copy permission",
    "action: revoke",
    `permission: ${args.permissionId}`,
    `owner: ${args.ownerWallet}`,
    `nonce: ${args.nonce}`,
    `expiresAt: ${new Date(args.expiresAt).toISOString()}`,
  ].join("\n");
}

export function copyPolicyHash(input: Omit<CopyPermission, "signedPolicyHash">): string {
  return sha256Hex(JSON.stringify(input, (_, value) => typeof value === "bigint" ? value.toString() : value));
}

function parseAtomicString(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("invalid atomic amount");
  return BigInt(value);
}

/** Validate the externally supplied, owner-signed policy before storing it. */
export function validateCopyPermission(input: Omit<CopyPermission, "signedPolicyHash">, now = Date.now()): string | null {
  if (!input.permissionId.trim() || input.permissionId.length > 128) return "invalid_permission_id";
  if (!isStellarAddress(input.ownerWallet) || !isStellarAddress(input.spendPermission.token) || !isStellarAddress(input.spendPermission.spender)) return "invalid_address";
  if (!input.executionAgentId.trim() || !input.signalAgentId.trim() || input.executionAgentId === input.signalAgentId) return "invalid_agent_pair";
  try {
    const position = parseUsdcAtomic(input.maxPerPositionUsdc);
    const daily = parseUsdcAtomic(input.dailyCapUsdc);
    const weekly = parseUsdcAtomic(input.weeklyCapUsdc);
    const exposure = parseUsdcAtomic(input.totalOpenExposureUsdc);
    const loss = parseAtomicString(input.maxRealizedLossAtomic);
    if (position <= 0n || daily < position || weekly < daily || exposure < position || loss <= 0n) return "invalid_budget";
  } catch { return "invalid_budget"; }
  if (input.spendPermission.allowanceAtomic <= 0n || !Number.isSafeInteger(input.spendPermission.periodSeconds) || input.spendPermission.periodSeconds <= 0) return "invalid_spend_permission";
  if (input.depth !== 1 || input.status !== "active" || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) return "invalid_lifecycle";
  if (!Number.isInteger(input.minConfidenceBps) || input.minConfidenceBps < 0 || input.minConfidenceBps > 10_000 ||
      !Number.isInteger(input.minPayoutBps) || input.minPayoutBps < 0) return "invalid_threshold";
  if (!Array.isArray(input.allowedCategories) || !Array.isArray(input.allowedModes) ||
      input.allowedCategories.length > 100 || input.allowedModes.length > 10) return "invalid_allowlist";
  return null;
}

export function worstCaseCopySpend(permission: CopyPermission): { perPositionUsdc: number; dailyUsdc: number; weeklyUsdc: number; totalOpenUsdc: number } {
  return { perPositionUsdc: permission.maxPerPositionUsdc, dailyUsdc: permission.dailyCapUsdc,
    weeklyUsdc: permission.weeklyCapUsdc, totalOpenUsdc: permission.totalOpenExposureUsdc };
}

export function evaluateCopy(permission: CopyPermission, signal: CopySignal, context: CopyExecutionContext):
  { allowed: true; stakeUsdc: number } | { allowed: false; reason: CopySkipReason } {
  // The switch is read here, not left to the caller: an executor that forgot to
  // map it into `globalPaused` would otherwise keep copying through an incident.
  if (context.globalPaused || isPaused("copy_execution", context.env)) return { allowed: false, reason: "global_paused" };
  if (permission.status === "revoked") return { allowed: false, reason: "permission_revoked" };
  if (permission.status === "paused") return { allowed: false, reason: "permission_paused" };
  if (!Number.isSafeInteger(context.now) || !context.usage ||
      typeof context.usage.usedTodayUsdc !== "number" ||
      typeof context.usage.usedThisWeekUsdc !== "number" ||
      typeof context.usage.openExposureUsdc !== "number" ||
      !Number.isSafeInteger(context.usage.usedTodayUsdc * 10_000_000) ||
      !Number.isSafeInteger(context.usage.usedThisWeekUsdc * 10_000_000) ||
      !Number.isSafeInteger(context.usage.openExposureUsdc * 10_000_000) ||
      typeof context.usage.realizedLossAtomic !== "string" ||
      !/^(0|[1-9]\d*)$/.test(context.usage.realizedLossAtomic) ||
      typeof context.usage.principalAtRiskAtomic !== "string" ||
      !/^(0|[1-9]\d*)$/.test(context.usage.principalAtRiskAtomic) ||
      typeof context.onchainAllowanceAtomic !== "bigint" || context.onchainAllowanceAtomic < 0n ||
      typeof context.existingClaimIds?.has !== "function" || !Array.isArray(context.ancestryAgentIds) ||
      !context.ancestryAgentIds.every((id) => typeof id === "string") ||
      typeof context.configuredUsdc !== "string" || typeof context.configuredSpender !== "string" ||
      !context.simulation || typeof context.simulation.ok !== "boolean" ||
      typeof context.simulation.blockNumber !== "bigint" || context.simulation.blockNumber < 0n) {
    return { allowed: false, reason: "malformed_context" };
  }
  try {
    parseUsdcAtomic(context.usage.usedTodayUsdc);
    parseUsdcAtomic(context.usage.usedThisWeekUsdc);
    parseUsdcAtomic(context.usage.openExposureUsdc);
  } catch { return { allowed: false, reason: "malformed_context" }; }
  if (context.now >= permission.expiresAt) return { allowed: false, reason: "permission_expired" };
  if (typeof signal.sourcePositionId !== "string" || !signal.sourcePositionId || signal.sourcePositionId.length > 128 ||
      typeof signal.sourceAttributionId !== "string" || !signal.sourceAttributionId || signal.sourceAttributionId.length > 128 ||
      typeof signal.signalAgentId !== "string" || !signal.signalAgentId ||
      !Number.isSafeInteger(signal.claimId) || signal.claimId < 0 ||
      !Number.isSafeInteger(signal.sourceDepth) || signal.sourceDepth < 0 ||
      !Number.isSafeInteger(signal.deadline) ||
      !Number.isSafeInteger(signal.remainingSlots) ||
      !Number.isInteger(signal.confidenceBps) || signal.confidenceBps < 0 || signal.confidenceBps > 10_000 ||
      !Number.isInteger(signal.payoutBps) || signal.payoutBps < 0 ||
      typeof signal.category !== "string" || typeof signal.mode !== "string" ||
      !signal.category || !signal.mode ||
      !Number.isFinite(signal.stakeUsdc) || signal.stakeUsdc < 0 ||
      !Number.isFinite(signal.availableLiquidityUsdc) || signal.availableLiquidityUsdc < 0 ||
      !Number.isFinite(signal.requiredLiquidityUsdc) || signal.requiredLiquidityUsdc < 0 ||
      (signal.marketState !== undefined && !["open", "active", "resolved", "cancelled"].includes(signal.marketState))) {
    return { allowed: false, reason: "malformed_signal" };
  }
  try {
    parseUsdcAtomic(signal.stakeUsdc);
    parseUsdcAtomic(signal.availableLiquidityUsdc);
    parseUsdcAtomic(signal.requiredLiquidityUsdc);
  } catch { return { allowed: false, reason: "malformed_signal" }; }
  if (signal.signalAgentId === permission.executionAgentId) return { allowed: false, reason: "self_copy" };
  if (signal.signalAgentId !== permission.signalAgentId) return { allowed: false, reason: "signal_agent_mismatch" };
  if (signal.marketState === "cancelled") return { allowed: false, reason: "market_cancelled" };
  if (signal.marketState === "resolved") return { allowed: false, reason: "market_closed" };
  if (signal.sourceDepth >= permission.depth) return { allowed: false, reason: "copy_depth" };
  if (context.ancestryAgentIds.map((id) => id.toLowerCase()).includes(permission.executionAgentId.toLowerCase())) {
    return { allowed: false, reason: "cycle" };
  }
  if (context.existingClaimIds.has(signal.claimId)) return { allowed: false, reason: "duplicate_position" };
  if (signal.deadline <= context.now) return { allowed: false, reason: "stale_signal" };
  if (signal.remainingSlots <= 0) return { allowed: false, reason: "market_full" };
  if (parseUsdcAtomic(signal.requiredLiquidityUsdc) > parseUsdcAtomic(signal.availableLiquidityUsdc)) return { allowed: false, reason: "liquidity_exhausted" };
  if (permission.allowedCategories.length && !permission.allowedCategories.includes(signal.category)) return { allowed: false, reason: "category_blocked" };
  if (permission.allowedModes.length && !permission.allowedModes.includes(signal.mode)) return { allowed: false, reason: "mode_blocked" };
  if (signal.confidenceBps < permission.minConfidenceBps) return { allowed: false, reason: "confidence_below_floor" };
  if (signal.payoutBps < permission.minPayoutBps) return { allowed: false, reason: "payout_below_floor" };
  const stake = signal.stakeUsdc;
  const stakeAtomic = parseUsdcAtomic(stake);
  if (stakeAtomic <= 0n || stakeAtomic > parseUsdcAtomic(permission.maxPerPositionUsdc)) return { allowed: false, reason: "position_cap" };
  if (parseUsdcAtomic(context.usage.usedTodayUsdc) + stakeAtomic > parseUsdcAtomic(permission.dailyCapUsdc)) return { allowed: false, reason: "daily_cap" };
  if (parseUsdcAtomic(context.usage.usedThisWeekUsdc) + stakeAtomic > parseUsdcAtomic(permission.weeklyCapUsdc)) return { allowed: false, reason: "weekly_cap" };
  if (parseUsdcAtomic(context.usage.openExposureUsdc) + stakeAtomic > parseUsdcAtomic(permission.totalOpenExposureUsdc)) return { allowed: false, reason: "open_exposure_cap" };
  if (parseAtomicString(context.usage.realizedLossAtomic) + parseAtomicString(context.usage.principalAtRiskAtomic) + stakeAtomic > parseAtomicString(permission.maxRealizedLossAtomic)) return { allowed: false, reason: "loss_limit" };
  const spend = permission.spendPermission;
  const requiredAtomic = stakeAtomic;
  // Exact comparison: a Stellar contract id / account is case-sensitive base32,
  // so the EVM `toLowerCase()` pairing here would never match a real address.
  if (spend.token.trim() !== context.configuredUsdc.trim() ||
      spend.spender.trim() !== context.configuredSpender.trim() ||
      spend.allowanceAtomic < requiredAtomic || context.onchainAllowanceAtomic < requiredAtomic) {
    return { allowed: false, reason: "spend_permission_mismatch" };
  }
  if (!context.simulation.ok) return { allowed: false, reason: "simulation_failed" };
  return { allowed: true, stakeUsdc: stake };
}

/** A `copy_executions` row as delivered by GET /api/copy/permissions (raw
 *  snake_case columns) or after client-side camel mapping. */
export interface CopyUsageExecutionRow {
  status?: unknown;
  stake_atomic?: unknown;
  stakeAtomic?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
}

export interface CopyExecutionUsage {
  usedTodayUsdc: number;
  usedThisWeekUsdc: number;
  openExposureUsdc: number;
  /** Atomic USDC at 7 decimals, as decimal strings for exact display math. */
  dailyUsedAtomic: string;
  weeklyUsedAtomic: string;
  openExposureAtomic: string;
  /** Epoch ms when the current UTC day / Monday-anchored UTC week ends. */
  nextDailyResetAtMs: number;
  nextWeeklyResetAtMs: number;
  /** Rows actually counted; malformed rows are skipped silently. */
  countedExecutions: number;
}

/** Epoch-ms length of a UTC calendar day, the base of both usage windows. */
const MS_PER_DAY = 86_400_000;

function toAtomicString(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

function toCreatedMs(value: unknown): number | null {
  let n: number | null = null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) n = value;
  else if (typeof value === "string" && /^\d+$/.test(value.trim())) n = Number(value.trim());
  if (n === null) return null;
  // Horizon-era rows may carry seconds; audit rows are written with Date.now().
  return n < 1e11 ? n * 1000 : n;
}

/** Convert 7-decimal atomic units to the display number `CopyUsage` carries. */
function atomicToDisplayUsdc(atomic: bigint): number {
  const whole = atomic / 10_000_000n;
  const fraction = atomic % 10_000_000n;
  const usdc = Number(whole) + Number(fraction) / 1e7;
  if (!Number.isSafeInteger(usdc * 10_000_000)) throw new Error("usage overflow");
  return usdc;
}

/**
 * Usage against the daily/weekly/open-exposure caps, computed from audit rows
 * with the same view `evaluateCopy` checks: only `executed` stakes count, and
 * each `CopyUsage` number is exactly what the gate compares against the caps.
 *
 * Windows are UTC-aligned — the day from 00:00 UTC, the week from Monday
 * 00:00 UTC — so the reset instants are deterministic.
 *
 * Realized loss is NOT part of this result: audit rows carry spend, not
 * settlement outcomes, so feeding the loss ceiling from here would understate
 * risk. Callers building a `CopyUsage` from this must supply
 * `realizedLossAtomic` from the settlement source and `principalAtRiskAtomic`
 * as the sum of stakes still in open positions.
 *
 * Throws only if a window total exceeds display precision.
 */
export function computeCopyUsageFromExecutions(
  executions: readonly CopyUsageExecutionRow[],
  now = Date.now(),
): CopyExecutionUsage {
  const epochDay = Math.floor(now / MS_PER_DAY);
  const dayStartMs = epochDay * MS_PER_DAY;
  // Unix day 0 was a Thursday: shift by 4 for getUTCDay(), then back to Monday.
  const weekStartMs = dayStartMs - (((epochDay + 4) % 7 + 6) % 7) * MS_PER_DAY;
  let daily = 0n;
  let weekly = 0n;
  let open = 0n;
  let counted = 0;
  for (const row of executions) {
    if (!row || row.status !== "executed") continue;
    const stakeAtomic = toAtomicString(row.stake_atomic ?? row.stakeAtomic);
    const createdAt = toCreatedMs(row.created_at ?? row.createdAt);
    if (stakeAtomic === null || createdAt === null) continue;
    counted++;
    open += stakeAtomic;
    if (createdAt >= dayStartMs) daily += stakeAtomic;
    if (createdAt >= weekStartMs) weekly += stakeAtomic;
  }
  return {
    usedTodayUsdc: atomicToDisplayUsdc(daily),
    usedThisWeekUsdc: atomicToDisplayUsdc(weekly),
    openExposureUsdc: atomicToDisplayUsdc(open),
    dailyUsedAtomic: daily.toString(),
    weeklyUsedAtomic: weekly.toString(),
    openExposureAtomic: open.toString(),
    nextDailyResetAtMs: dayStartMs + 86_400_000,
    nextWeeklyResetAtMs: weekStartMs + 7 * 86_400_000,
    countedExecutions: counted,
  };
}

export interface CopyAuditRecord {
  executionId: string;
  permissionId: string;
  sourcePositionId: string;
  signalAgentId: string;
  executionAgentId: string;
  sourceAttributionId: string;
  status: "executed" | "skipped" | "failed" | "expired";
  /** Atomic USDC at 7 decimals. */
  stakeAtomic: bigint;
  /** Ledger sequence the pre-flight simulation ran against. */
  simulationBlock: bigint;
  txHash?: string;
  platformFeeAtomic: bigint;
  ownerFeeAtomic: bigint;
  skipReason?: CopySkipReason;
  createdAt: number;
}

/**
 * Human-readable explanation for copy-trading permission states and constraints.
 *
 * This module provides deterministic, contract-backed feedback for UI components
 * to explain why a copy action was allowed, skipped, or failed. It ensures that
 * sensitive fields (wallet addresses, money amounts) are handled explicitly and
 * that loading, invalid, stale, disconnected, and dependency-failure behaviors
 * are clearly defined for the user.
 */

export interface CopyPermissionExplanation {
  /** Unique identifier for the permission being explained. */
  permissionId: string;
  /** The wallet address of the permission owner. */
  ownerWallet: string;
  /** Current status of the permission. */
  status: "active" | "revoked" | "paused" | "expired";
  /** Detailed reason for the current status or action outcome. */
  reason: string;
  /** Whether the permission is currently valid for execution. */
  isValid: boolean;
  /** The maximum stake allowed per position in USDC (display format). */
  maxPerPositionUsdc: number;
  /** The daily spending cap in USDC (display format). */
  dailyCapUsdc: number;
  /** The weekly spending cap in USDC (display format). */
  weeklyCapUsdc: number;
  /** The maximum open exposure allowed in USDC (display format). */
  totalOpenExposureUsdc: number;
  /** The maximum realized loss limit in atomic USDC (7 decimals). */
  maxRealizedLossAtomic: string;
  /** The allowed categories for copy signals. */
  allowedCategories: string[];
  /** The allowed modes for copy signals. */
  allowedModes: string[];
  /** The minimum confidence required in basis points. */
  minConfidenceBps: number;
  /** The minimum payout required in basis points. */
  minPayoutBps: number;
  /** The expiration timestamp of the permission. */
  expiresAt: number;
  /** The token address for spend permission. */
  spendToken: string;
  /** The spender address for spend permission. */
  spendSpender: string;
  /** The allowance amount in atomic USDC. */
  spendAllowanceAtomic: bigint;
  /** The period in seconds for the spend permission. */
  spendPeriodSeconds: number;
}

/**
 * Generates a human-readable explanation for a copy permission.
 *
 * This function takes a `CopyPermission` and an optional `CopyExecutionContext`
 * to provide context-aware feedback. It ensures that all sensitive fields are
 * handled explicitly and that the explanation is clear and contract-backed.
 *
 * @param permission - The copy permission to explain.
 * @param context - Optional execution context for dynamic feedback.
 * @returns A `CopyPermissionExplanation` object with detailed feedback.
 */
export function explainCopyPermission(
  permission: CopyPermission,
  context?: CopyExecutionContext
): CopyPermissionExplanation {
  const now = context?.now ?? Date.now();
  let status: "active" | "revoked" | "paused" | "expired" = permission.status;
  let reason = "Permission is active and valid.";

  if (permission.status === "revoked") {
    status = "revoked";
    reason = "This permission has been revoked by the owner.";
  } else if (permission.status === "paused") {
    status = "paused";
    reason = "This permission is currently paused by the owner.";
  } else if (now >= permission.expiresAt) {
    status = "expired";
    reason = "This permission has expired.";
  } else if (context?.globalPaused) {
    status = "paused";
    reason = "Copy trading is globally paused.";
  }

  return {
    permissionId: permission.permissionId,
    ownerWallet: permission.ownerWallet,
    status,
    reason,
    isValid: status === "active" && !context?.globalPaused,
    maxPerPositionUsdc: permission.maxPerPositionUsdc,
    dailyCapUsdc: permission.dailyCapUsdc,
    weeklyCapUsdc: permission.weeklyCapUsdc,
    totalOpenExposureUsdc: permission.totalOpenExposureUsdc,
    maxRealizedLossAtomic: permission.maxRealizedLossAtomic,
    allowedCategories: permission.allowedCategories,
    allowedModes: permission.allowedModes,
    minConfidenceBps: permission.minConfidenceBps,
    minPayoutBps: permission.minPayoutBps,
    expiresAt: permission.expiresAt,
    spendToken: permission.spendPermission.token,
    spendSpender: permission.spendPermission.spender,
    spendAllowanceAtomic: permission.spendPermission.allowanceAtomic,
    spendPeriodSeconds: permission.spendPermission.periodSeconds,
  };
}

/**
 * Generates a human-readable explanation for a copy skip reason.
 *
 * This function maps a `CopySkipReason` to a user-friendly message.
 *
 * @param reason - The skip reason to explain.
 * @returns A human-readable string explaining the skip reason.
 */
export function explainCopySkipReason(reason: CopySkipReason): string {
  switch (reason) {
    case "global_paused":
      return "Copy trading is currently paused globally.";
    case "permission_revoked":
      return "The copy permission has been revoked.";
    case "permission_paused":
      return "The copy permission is currently paused.";
    case "permission_expired":
      return "The copy permission has expired.";
    case "self_copy":
      return "You cannot copy your own signals.";
    case "copy_depth":
      return "Copy depth limit reached.";
    case "cycle":
      return "Copying this signal would create a cycle.";
    case "duplicate_position":
      return "This position has already been copied.";
    case "stale_signal":
      return "The signal has expired.";
    case "market_full":
      return "The market is full.";
    case "liquidity_exhausted":
      return "Insufficient liquidity available.";
    case "category_blocked":
      return "This category is not allowed by your permission.";
    case "mode_blocked":
      return "This mode is not allowed by your permission.";
    case "confidence_below_floor":
      return "The signal confidence is below the minimum required.";
    case "payout_below_floor":
      return "The signal payout is below the minimum required.";
    case "position_cap":
      return "The stake exceeds the maximum per position limit.";
    case "daily_cap":
      return "The stake exceeds the daily spending cap.";
    case "weekly_cap":
      return "The stake exceeds the weekly spending cap.";
    case "open_exposure_cap":
      return "The stake exceeds the maximum open exposure limit.";
    case "spend_permission_mismatch":
      return "The spend permission does not match the required token or spender.";
    case "loss_limit":
      return "The stake would exceed the maximum realized loss limit.";
    case "simulation_failed":
      return "The pre-flight simulation failed.";
    default:
      return "Unknown skip reason.";
  }
}
// ── Copy execution recovery (#885) ──────────────────────────────────────────
//
// After a submission whose result is unknown (timeout, crash, dropped
// connection), the executor must not resubmit the same stake. Instead it
// records a durable intent, reconciles it against on-chain position identity,
// and holds it until the outcome is known. A `pending` or `unknown` intent for
// the same `(policyId, member, stakeAtomic)` blocks a new submission; the same
// intent's stake counts toward the caller's `spentThisPeriodAtomic` exactly
// once, before and after it reconciles.

/** Lifecycle of a copy execution intent. */
export type CopyExecutionIntentStatus = "pending" | "confirmed" | "unknown";

/**
 * A durable record of a copy stake the executor has decided to submit.
 *
 * Written **before** the submission so a crash or timeout leaves a recoverable
 * record rather than a lost one. `idempotencyKey` is the executor's stable key
 * for "this stake of this policy for this member"; `stakeAtomic` is 7-decimal
 * USDC, matching every other atomic figure in this module.
 */
export interface CopyExecutionIntent {
  id: string;
  policyId: string;
  member: string;
  /** 7-decimal atomic USDC. */
  stakeAtomic: bigint;
  idempotencyKey: string;
  status: CopyExecutionIntentStatus;
  /** Populated once the executor sees a transaction hash. */
  txHash?: string;
  /** Populated once a chain position is matched. */
  positionId?: string;
  /** Epoch ms when the intent was first persisted. */
  createdAt: number;
  /** Epoch ms of the submission attempt (when one was made). */
  submittedAt?: number;
  /** Epoch ms when the intent became `confirmed` or was held past the window. */
  resolvedAt?: number;
  /** Last error observed during submission, bounded upstream by `safeErrorMessage`. */
  lastError?: string;
}

/** One on-chain position as the reconciler sees it. */
export interface CopyChainPosition {
  txHash: string;
  positionId: string;
  /** 7-decimal atomic USDC actually staked. */
  stakeAtomic: bigint;
}

/** Outcome of reconciling one batch of intents against one batch of positions. */
export interface CopyIntentReconcileResult {
  /** Intents whose on-chain position matched; already marked `confirmed`. */
  confirmed: CopyExecutionIntent[];
  /** Intents still inside the reconcile window with no match yet. */
  stillUnknown: CopyExecutionIntent[];
  /** Intents past the window with no match; held forever, never resubmitted. */
  held: CopyExecutionIntent[];
}

/** Default reconcile window before an unmatched intent is held. */
export const COPY_INTENT_RECONCILE_WINDOW_MS = 15 * 60 * 1000;

function indexByTxHash(positions: readonly CopyChainPosition[]): Map<string, CopyChainPosition> {
  const byTx = new Map<string, CopyChainPosition>();
  for (const p of positions) {
    if (!p || typeof p.txHash !== "string" || !p.txHash) continue;
    if (typeof p.positionId !== "string" || !p.positionId) continue;
    if (typeof p.stakeAtomic !== "bigint" || p.stakeAtomic <= 0n) continue;
    byTx.set(p.txHash, p);
  }
  return byTx;
}

/**
 * Reconcile `unknown` intents against on-chain positions.
 *
 * - A match on `txHash` (or an already-recorded `positionId`) marks the intent
 *   `confirmed` and copies the position id + stake onto it.
 * - No match, inside the window: returned as `stillUnknown` (status unchanged)
 *   so a later pass can reconcile again.
 * - No match, past the window: returned as `held` (status stays `unknown`) so
 *   the caller can surface the record without ever resubmitting.
 *
 * `pending` and `confirmed` intents are not returned; this is a no-op for them.
 */
export function reconcileUnknownIntents(
  intents: readonly CopyExecutionIntent[],
  chainPositions: readonly CopyChainPosition[],
  now: number,
  windowMs: number = COPY_INTENT_RECONCILE_WINDOW_MS,
): CopyIntentReconcileResult {
  const byTx = indexByTxHash(chainPositions);
  const confirmed: CopyExecutionIntent[] = [];
  const stillUnknown: CopyExecutionIntent[] = [];
  const held: CopyExecutionIntent[] = [];
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : COPY_INTENT_RECONCILE_WINDOW_MS;

  for (const intent of intents) {
    if (!intent || intent.status !== "unknown") continue;
    const match = intent.txHash ? byTx.get(intent.txHash) : undefined;
    if (match) {
      confirmed.push({
        ...intent,
        status: "confirmed",
        positionId: match.positionId,
        stakeAtomic: match.stakeAtomic,
        resolvedAt: now,
      });
      continue;
    }
    const submitted = typeof intent.submittedAt === "number" ? intent.submittedAt : intent.createdAt;
    const past = now - submitted >= window;
    if (past) {
      held.push({ ...intent, resolvedAt: now });
    } else {
      stillUnknown.push(intent);
    }
  }

  return { confirmed, stillUnknown, held };
}

/** Result of checking whether a new submission should be allowed. */
export type CopyResubmissionDecision =
  | { allowed: true }
  | { allowed: false; reason: "pending_intent" | "unknown_intent"; existing: CopyExecutionIntent };

/**
 * Decide whether a new submission for `(policyId, member, stakeAtomic)` may
 * proceed. Any existing intent in `pending` or `unknown` state for that exact
 * triple blocks the new submission — this is the "no automatic repeated stakes
 * for an unknown result" rule.
 *
 * Matching is on `policyId`, `member` and `stakeAtomic`. A different stake, a
 * different policy, or a different member is a different intent.
 */
export function gateResubmission(
  candidate: Pick<CopyExecutionIntent, "policyId" | "member" | "stakeAtomic">,
  existingIntents: readonly CopyExecutionIntent[],
  _now: number,
): CopyResubmissionDecision {
  for (const intent of existingIntents) {
    if (!intent) continue;
    if (intent.status === "confirmed") continue;
    if (intent.policyId !== candidate.policyId) continue;
    if (intent.member !== candidate.member) continue;
    if (intent.stakeAtomic !== candidate.stakeAtomic) continue;
    if (intent.status === "pending") {
      return { allowed: false, reason: "pending_intent", existing: intent };
    }
    if (intent.status === "unknown") {
      return { allowed: false, reason: "unknown_intent", existing: intent };
    }
  }
  return { allowed: true };
}

/**
 * Sum of stakes across `pending` and `unknown` intents — the amount the caller
 * must add to `spentThisPeriodAtomic` before calling `evaluateSpend`, so a held
 * intent is counted exactly once while it is in flight, and not again after it
 * confirms (the caller drops it from the reserved set on `confirmed`).
 */
export function reservedSpendAtomic(intents: readonly CopyExecutionIntent[]): bigint {
  let total = 0n;
  for (const intent of intents) {
    if (!intent || typeof intent.stakeAtomic !== "bigint" || intent.stakeAtomic <= 0n) continue;
    if (intent.status === "pending" || intent.status === "unknown") total += intent.stakeAtomic;
  }
  return total;
}

// ── Copy execution recovery (#885) ──────────────────────────────────────────
//
// After a submission whose result is unknown (timeout, crash, dropped
// connection), the executor must not resubmit the same stake. Instead it
// records a durable intent, reconciles it against on-chain position identity,
// and holds it until the outcome is known. A `pending` or `unknown` intent for
// the same `(policyId, member, stakeAtomic)` blocks a new submission; the same
// intent's stake counts toward the caller's `spentThisPeriodAtomic` exactly
// once, before and after it reconciles.

/** Lifecycle of a copy execution intent. */
export type CopyExecutionIntentStatus = "pending" | "confirmed" | "unknown";

/**
 * A durable record of a copy stake the executor has decided to submit.
 *
 * Written **before** the submission so a crash or timeout leaves a recoverable
 * record rather than a lost one. `idempotencyKey` is the executor's stable key
 * for "this stake of this policy for this member"; `stakeAtomic` is 7-decimal
 * USDC, matching every other atomic figure in this module.
 */
export interface CopyExecutionIntent {
  id: string;
  policyId: string;
  member: string;
  /** 7-decimal atomic USDC. */
  stakeAtomic: bigint;
  idempotencyKey: string;
  status: CopyExecutionIntentStatus;
  /** Populated once the executor sees a transaction hash. */
  txHash?: string;
  /** Populated once a chain position is matched. */
  positionId?: string;
  /** Epoch ms when the intent was first persisted. */
  createdAt: number;
  /** Epoch ms of the submission attempt (when one was made). */
  submittedAt?: number;
  /** Epoch ms when the intent became `confirmed` or was held past the window. */
  resolvedAt?: number;
  /** Last error observed during submission, bounded upstream by `safeErrorMessage`. */
  lastError?: string;
}

/** One on-chain position as the reconciler sees it. */
export interface CopyChainPosition {
  txHash: string;
  positionId: string;
  /** 7-decimal atomic USDC actually staked. */
  stakeAtomic: bigint;
}

/** Outcome of reconciling one batch of intents against one batch of positions. */
export interface CopyIntentReconcileResult {
  /** Intents whose on-chain position matched; already marked `confirmed`. */
  confirmed: CopyExecutionIntent[];
  /** Intents still inside the reconcile window with no match yet. */
  stillUnknown: CopyExecutionIntent[];
  /** Intents past the window with no match; held forever, never resubmitted. */
  held: CopyExecutionIntent[];
}

/** Default reconcile window before an unmatched intent is held. */
export const COPY_INTENT_RECONCILE_WINDOW_MS = 15 * 60 * 1000;

function indexByTxHash(positions: readonly CopyChainPosition[]): Map<string, CopyChainPosition> {
  const byTx = new Map<string, CopyChainPosition>();
  for (const p of positions) {
    if (!p || typeof p.txHash !== "string" || !p.txHash) continue;
    if (typeof p.positionId !== "string" || !p.positionId) continue;
    if (typeof p.stakeAtomic !== "bigint" || p.stakeAtomic <= 0n) continue;
    byTx.set(p.txHash, p);
  }
  return byTx;
}

/**
 * Reconcile `unknown` intents against on-chain positions.
 *
 * - A match on `txHash` (or an already-recorded `positionId`) marks the intent
 *   `confirmed` and copies the position id + stake onto it.
 * - No match, inside the window: returned as `stillUnknown` (status unchanged)
 *   so a later pass can reconcile again.
 * - No match, past the window: returned as `held` (status stays `unknown`) so
 *   the caller can surface the record without ever resubmitting.
 *
 * `pending` and `confirmed` intents are not returned; this is a no-op for them.
 */
export function reconcileUnknownIntents(
  intents: readonly CopyExecutionIntent[],
  chainPositions: readonly CopyChainPosition[],
  now: number,
  windowMs: number = COPY_INTENT_RECONCILE_WINDOW_MS,
): CopyIntentReconcileResult {
  const byTx = indexByTxHash(chainPositions);
  const confirmed: CopyExecutionIntent[] = [];
  const stillUnknown: CopyExecutionIntent[] = [];
  const held: CopyExecutionIntent[] = [];
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : COPY_INTENT_RECONCILE_WINDOW_MS;

  for (const intent of intents) {
    if (!intent || intent.status !== "unknown") continue;
    const match = intent.txHash ? byTx.get(intent.txHash) : undefined;
    if (match) {
      confirmed.push({
        ...intent,
        status: "confirmed",
        positionId: match.positionId,
        stakeAtomic: match.stakeAtomic,
        resolvedAt: now,
      });
      continue;
    }
    const submitted = typeof intent.submittedAt === "number" ? intent.submittedAt : intent.createdAt;
    const past = now - submitted >= window;
    if (past) {
      held.push({ ...intent, resolvedAt: now });
    } else {
      stillUnknown.push(intent);
    }
  }

  return { confirmed, stillUnknown, held };
}

/** Result of checking whether a new submission should be allowed. */
export type CopyResubmissionDecision =
  | { allowed: true }
  | { allowed: false; reason: "pending_intent" | "unknown_intent"; existing: CopyExecutionIntent };

/**
 * Decide whether a new submission for `(policyId, member, stakeAtomic)` may
 * proceed. Any existing intent in `pending` or `unknown` state for that exact
 * triple blocks the new submission — this is the "no automatic repeated stakes
 * for an unknown result" rule.
 *
 * Matching is on `policyId`, `member` and `stakeAtomic`. A different stake, a
 * different policy, or a different member is a different intent.
 */
export function gateResubmission(
  candidate: Pick<CopyExecutionIntent, "policyId" | "member" | "stakeAtomic">,
  existingIntents: readonly CopyExecutionIntent[],
  _now: number,
): CopyResubmissionDecision {
  for (const intent of existingIntents) {
    if (!intent) continue;
    if (intent.status === "confirmed") continue;
    if (intent.policyId !== candidate.policyId) continue;
    if (intent.member !== candidate.member) continue;
    if (intent.stakeAtomic !== candidate.stakeAtomic) continue;
    if (intent.status === "pending") {
      return { allowed: false, reason: "pending_intent", existing: intent };
    }
    if (intent.status === "unknown") {
      return { allowed: false, reason: "unknown_intent", existing: intent };
    }
  }
  return { allowed: true };
}

/**
 * Sum of stakes across `pending` and `unknown` intents — the amount the caller
 * must add to `spentThisPeriodAtomic` before calling `evaluateSpend`, so a held
 * intent is counted exactly once while it is in flight, and not again after it
 * confirms (the caller drops it from the reserved set on `confirmed`).
 */
export function reservedSpendAtomic(intents: readonly CopyExecutionIntent[]): bigint {
  let total = 0n;
  for (const intent of intents) {
    if (!intent || typeof intent.stakeAtomic !== "bigint" || intent.stakeAtomic <= 0n) continue;
    if (intent.status === "pending" || intent.status === "unknown") total += intent.stakeAtomic;
  }
  return total;
}

// ── Copy execution recovery (#885) ──────────────────────────────────────────
//
// After a submission whose result is unknown (timeout, crash, dropped
// connection), the executor must not resubmit the same stake. Instead it
// records a durable intent, reconciles it against on-chain position identity,
// and holds it until the outcome is known. A `pending` or `unknown` intent for
// the same `(policyId, member, stakeAtomic)` blocks a new submission; the same
// intent's stake counts toward the caller's `spentThisPeriodAtomic` exactly
// once, before and after it reconciles.

/** Lifecycle of a copy execution intent. */
export type CopyExecutionIntentStatus = "pending" | "confirmed" | "unknown";

/** A durable record of a copy stake the executor has decided to submit. */
export interface CopyExecutionIntent {
  id: string;
  policyId: string;
  member: string;
  /** 7-decimal atomic USDC. */
  stakeAtomic: bigint;
  idempotencyKey: string;
  status: CopyExecutionIntentStatus;
  txHash?: string;
  positionId?: string;
  createdAt: number;
  submittedAt?: number;
  resolvedAt?: number;
  lastError?: string;
}

/** One on-chain position as the reconciler sees it. */
export interface CopyChainPosition {
  txHash: string;
  positionId: string;
  stakeAtomic: bigint;
}

export interface CopyIntentReconcileResult {
  confirmed: CopyExecutionIntent[];
  stillUnknown: CopyExecutionIntent[];
  held: CopyExecutionIntent[];
}

export const COPY_INTENT_RECONCILE_WINDOW_MS = 15 * 60 * 1000;

function indexByTxHash(positions: readonly CopyChainPosition[]): Map<string, CopyChainPosition> {
  const byTx = new Map<string, CopyChainPosition>();
  for (const p of positions) {
    if (!p || typeof p.txHash !== "string" || !p.txHash) continue;
    if (typeof p.positionId !== "string" || !p.positionId) continue;
    if (typeof p.stakeAtomic !== "bigint" || p.stakeAtomic <= 0n) continue;
    byTx.set(p.txHash, p);
  }
  return byTx;
}

export function reconcileUnknownIntents(
  intents: readonly CopyExecutionIntent[],
  chainPositions: readonly CopyChainPosition[],
  now: number,
  windowMs: number = COPY_INTENT_RECONCILE_WINDOW_MS,
): CopyIntentReconcileResult {
  const byTx = indexByTxHash(chainPositions);
  const confirmed: CopyExecutionIntent[] = [];
  const stillUnknown: CopyExecutionIntent[] = [];
  const held: CopyExecutionIntent[] = [];
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : COPY_INTENT_RECONCILE_WINDOW_MS;

  for (const intent of intents) {
    if (!intent || intent.status !== "unknown") continue;
    const match = intent.txHash ? byTx.get(intent.txHash) : undefined;
    if (match) {
      confirmed.push({ ...intent, status: "confirmed", positionId: match.positionId, stakeAtomic: match.stakeAtomic, resolvedAt: now });
      continue;
    }
    const submitted = typeof intent.submittedAt === "number" ? intent.submittedAt : intent.createdAt;
    if (now - submitted >= window) held.push({ ...intent, resolvedAt: now });
    else stillUnknown.push(intent);
  }
  return { confirmed, stillUnknown, held };
}

export type CopyResubmissionDecision =
  | { allowed: true }
  | { allowed: false; reason: "pending_intent" | "unknown_intent"; existing: CopyExecutionIntent };

export function gateResubmission(
  candidate: Pick<CopyExecutionIntent, "policyId" | "member" | "stakeAtomic">,
  existingIntents: readonly CopyExecutionIntent[],
  _now: number,
): CopyResubmissionDecision {
  for (const intent of existingIntents) {
    if (!intent || intent.status === "confirmed") continue;
    if (intent.policyId !== candidate.policyId) continue;
    if (intent.member !== candidate.member) continue;
    if (intent.stakeAtomic !== candidate.stakeAtomic) continue;
    if (intent.status === "pending") return { allowed: false, reason: "pending_intent", existing: intent };
    if (intent.status === "unknown") return { allowed: false, reason: "unknown_intent", existing: intent };
  }
  return { allowed: true };
}

export function reservedSpendAtomic(intents: readonly CopyExecutionIntent[]): bigint {
  let total = 0n;
  for (const intent of intents) {
    if (!intent || typeof intent.stakeAtomic !== "bigint" || intent.stakeAtomic <= 0n) continue;
    if (intent.status === "pending" || intent.status === "unknown") total += intent.stakeAtomic;
  }
  return total;
}
