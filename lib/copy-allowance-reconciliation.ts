/**
 * Read-only reconciliation report comparing owner copy policy, authorized
 * delegated spending allowance (Soroban SAC + optional spend-permission record),
 * and observed consumption.
 *
 * Produces a deterministic discrepancy report before any remediation. No chain
 * call, signature, ledger write, or allowance mutation is performed here.
 *
 * All atomic USDC figures use 7 decimals (`lib/usdc.ts`). Stellar `G…`/`C…`
 * strkeys are case-sensitive base32 and are always compared verbatim.
 */

import {
  currentPeriodStart,
  type SpendPermissionRecord,
} from "@/lib/agents/spend-permissions";
import type { CopyPermission, CopyUsage } from "@/lib/copy-trading";
import { parseUsdcAtomic } from "@/lib/usdc";

export type ReconciliationSeverity = "info" | "warning" | "critical";

export type AllowanceDiscrepancyCode =
  | "malformed_input"
  | "token_mismatch"
  | "spender_mismatch"
  | "owner_account_mismatch"
  | "agent_mismatch"
  | "stale_onchain_allowance"
  | "spend_record_revoked_with_active_policy"
  | "spend_record_lifecycle_mismatch"
  | "spend_record_allowance_mismatch"
  | "spend_record_period_mismatch"
  | "onchain_allowance_below_remaining_period_budget"
  | "onchain_allowance_exceeds_policy_allowance"
  | "policy_allowance_below_position_cap"
  | "consumption_exceeds_period_allowance"
  | "consumption_exceeds_daily_cap"
  | "consumption_exceeds_weekly_cap"
  | "open_exposure_exceeds_cap"
  | "realized_loss_exceeds_limit";

export interface AllowanceDiscrepancy {
  code: AllowanceDiscrepancyCode;
  severity: ReconciliationSeverity;
  message: string;
  expected?: string;
  observed?: string;
}

export interface DelegatedAllowanceReconciliationInput {
  /** Current timestamp in Unix milliseconds (matching `CopyPermission.expiresAt`). */
  now: number;
  /** Owner-signed copy trading policy. */
  permission: CopyPermission;
  /** Expected USDC SAC contract id for this deployment. */
  configuredUsdc: string;
  /** Expected Mimir spender address (`G…` or `C…`) for this deployment. */
  configuredSpender: string;
  /** Authoritative on-chain Soroban SAC `allowance(owner, spender)` in 7-decimal atomic USDC. */
  onchainAllowanceAtomic: bigint;
  /** Observed rolling copy-trading usage from Mimir's read index. */
  usage: CopyUsage;
  /** Observed consumption in the current spend-permission rolling period (7-decimal atomic USDC). */
  spentThisPeriodAtomic: bigint;
  /** Optional owner-signed spend permission record from `lib/agents/spend-permissions.ts`. */
  spendPermissionRecord?: SpendPermissionRecord;
  /** Optional current Stellar ledger sequence to check `spendPermissionRecord.expirationLedger`. */
  currentLedger?: number;
}

export interface DelegatedAllowanceReconciliationReport {
  mode: "read_only";
  remediationApplied: false;
  permissionId: string;
  ownerWallet: string;
  executionAgentId: string;
  evaluatedAt: number;
  reconciled: boolean;
  remediationRequired: boolean;
  highestSeverity: ReconciliationSeverity | "none";
  policy: {
    status: CopyPermission["status"];
    expired: boolean;
    token: string;
    spender: string;
    allowanceAtomic: string | null;
    periodSeconds: number;
    maxPerPositionAtomic: string | null;
    dailyCapAtomic: string | null;
    weeklyCapAtomic: string | null;
    totalOpenExposureAtomic: string | null;
    maxRealizedLossAtomic: string | null;
  };
  authorized: {
    configuredUsdc: string;
    configuredSpender: string;
    onchainAllowanceAtomic: string | null;
    spendPermissionHash: string | null;
    spendRecordAllowanceAtomic: string | null;
    spendRecordPeriodSeconds: number | null;
    periodStart: number | null;
    periodEndsAt: number | null;
  };
  observed: {
    spentThisPeriodAtomic: string | null;
    remainingPeriodBudgetAtomic: string | null;
    effectiveRemainingAtomic: string | null;
    usedTodayAtomic: string | null;
    usedThisWeekAtomic: string | null;
    openExposureAtomic: string | null;
    realizedLossAtomic: string | null;
  };
  discrepancies: AllowanceDiscrepancy[];
}

export interface DelegatedAllowanceReconciliationSummary {
  mode: "read_only";
  remediationApplied: false;
  total: number;
  reconciled: number;
  withDiscrepancies: number;
  remediationRequired: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  byCode: Partial<Record<AllowanceDiscrepancyCode, number>>;
}

function parseAtomicString(value: string): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  return BigInt(value);
}

function tryParseUsdcAtomic(value: number): bigint | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (!Number.isSafeInteger(Math.round(value * 10_000_000))) return null;
  try {
    return parseUsdcAtomic(value);
  } catch {
    return null;
  }
}

function severityRank(severity: ReconciliationSeverity | "none"): number {
  switch (severity) {
    case "critical": return 3;
    case "warning": return 2;
    case "info": return 1;
    default: return 0;
  }
}

function highestSeverityOf(discrepancies: readonly AllowanceDiscrepancy[]): ReconciliationSeverity | "none" {
  let highest: ReconciliationSeverity | "none" = "none";
  for (const d of discrepancies) {
    if (severityRank(d.severity) > severityRank(highest)) highest = d.severity;
  }
  return highest;
}

/**
 * Compare owner policy, authorized delegated allowance, and observed consumption
 * into a read-only discrepancy report.
 *
 * Fails closed on malformed inputs by recording a `malformed_input` critical
 * discrepancy rather than throwing.
 */
export function buildDelegatedAllowanceReconciliationReport(
  input: DelegatedAllowanceReconciliationInput,
): DelegatedAllowanceReconciliationReport {
  const {
    now,
    permission,
    configuredUsdc,
    configuredSpender,
    onchainAllowanceAtomic,
    usage,
    spentThisPeriodAtomic,
    spendPermissionRecord,
    currentLedger,
  } = input;

  const discrepancies: AllowanceDiscrepancy[] = [];
  const expired = Number.isSafeInteger(now) && Number.isSafeInteger(permission.expiresAt)
    ? now >= permission.expiresAt
    : false;

  const policyAllowance = typeof permission.spendPermission?.allowanceAtomic === "bigint" &&
    permission.spendPermission.allowanceAtomic >= 0n
    ? permission.spendPermission.allowanceAtomic
    : null;
  const maxPerPositionAtomic = tryParseUsdcAtomic(permission.maxPerPositionUsdc);
  const dailyCapAtomic = tryParseUsdcAtomic(permission.dailyCapUsdc);
  const weeklyCapAtomic = tryParseUsdcAtomic(permission.weeklyCapUsdc);
  const totalOpenExposureAtomic = tryParseUsdcAtomic(permission.totalOpenExposureUsdc);
  const maxRealizedLossAtomic = parseAtomicString(permission.maxRealizedLossAtomic);

  const validOnchain = typeof onchainAllowanceAtomic === "bigint" && onchainAllowanceAtomic >= 0n
    ? onchainAllowanceAtomic
    : null;
  const validSpentPeriod = typeof spentThisPeriodAtomic === "bigint" && spentThisPeriodAtomic >= 0n
    ? spentThisPeriodAtomic
    : null;

  const usedTodayAtomic = usage ? tryParseUsdcAtomic(usage.usedTodayUsdc) : null;
  const usedThisWeekAtomic = usage ? tryParseUsdcAtomic(usage.usedThisWeekUsdc) : null;
  const openExposureAtomic = usage ? tryParseUsdcAtomic(usage.openExposureUsdc) : null;
  const realizedLossAtomic = usage ? parseAtomicString(usage.realizedLossAtomic) : null;

  const nowSeconds = Number.isSafeInteger(now) ? Math.floor(now / 1000) : null;
  let periodStart: number | null = null;
  let periodEndsAt: number | null = null;
  if (
    spendPermissionRecord &&
    nowSeconds !== null &&
    Number.isInteger(spendPermissionRecord.periodSeconds) &&
    spendPermissionRecord.periodSeconds > 0
  ) {
    periodStart = currentPeriodStart(spendPermissionRecord, nowSeconds);
    periodEndsAt = Math.min(periodStart + spendPermissionRecord.periodSeconds, spendPermissionRecord.endAt);
  }

  const remainingPeriodBudget =
    policyAllowance !== null && validSpentPeriod !== null
      ? (policyAllowance > validSpentPeriod ? policyAllowance - validSpentPeriod : 0n)
      : null;

  const effectiveRemaining =
    remainingPeriodBudget !== null && validOnchain !== null
      ? (remainingPeriodBudget < validOnchain ? remainingPeriodBudget : validOnchain)
      : null;

  const malformed =
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(permission.expiresAt) ||
    typeof configuredUsdc !== "string" || !configuredUsdc.trim() ||
    typeof configuredSpender !== "string" || !configuredSpender.trim() ||
    policyAllowance === null ||
    maxPerPositionAtomic === null ||
    dailyCapAtomic === null ||
    weeklyCapAtomic === null ||
    totalOpenExposureAtomic === null ||
    maxRealizedLossAtomic === null ||
    validOnchain === null ||
    validSpentPeriod === null ||
    usedTodayAtomic === null ||
    usedThisWeekAtomic === null ||
    openExposureAtomic === null ||
    realizedLossAtomic === null ||
    (currentLedger !== undefined && (!Number.isSafeInteger(currentLedger) || currentLedger < 0));

  if (malformed) {
    discrepancies.push({
      code: "malformed_input",
      severity: "critical",
      message: "One or more reconciliation inputs are missing, negative, or non-atomic.",
    });
  } else {
    // 1. Identity & binding checks (exact case-sensitive Stellar strkey comparisons).
    if (permission.spendPermission.token.trim() !== configuredUsdc.trim()) {
      discrepancies.push({
        code: "token_mismatch",
        severity: "critical",
        message: "Policy spend permission token does not match configured USDC SAC.",
        expected: configuredUsdc.trim(),
        observed: permission.spendPermission.token.trim(),
      });
    }
    if (permission.spendPermission.spender.trim() !== configuredSpender.trim()) {
      discrepancies.push({
        code: "spender_mismatch",
        severity: "critical",
        message: "Policy spend permission spender does not match configured deployment spender.",
        expected: configuredSpender.trim(),
        observed: permission.spendPermission.spender.trim(),
      });
    }

    // 2. Optional SpendPermissionRecord alignment checks.
    if (spendPermissionRecord) {
      if (spendPermissionRecord.account.trim() !== permission.ownerWallet.trim()) {
        discrepancies.push({
          code: "owner_account_mismatch",
          severity: "critical",
          message: "Spend permission record account does not match copy policy owner wallet.",
          expected: permission.ownerWallet.trim(),
          observed: spendPermissionRecord.account.trim(),
        });
      }
      if (spendPermissionRecord.agentId !== permission.executionAgentId) {
        discrepancies.push({
          code: "agent_mismatch",
          severity: "critical",
          message: "Spend permission record agentId does not match copy policy executionAgentId.",
          expected: permission.executionAgentId,
          observed: spendPermissionRecord.agentId,
        });
      }
      if (spendPermissionRecord.token.trim() !== configuredUsdc.trim()) {
        discrepancies.push({
          code: "token_mismatch",
          severity: "critical",
          message: "Spend permission record token does not match configured USDC SAC.",
          expected: configuredUsdc.trim(),
          observed: spendPermissionRecord.token.trim(),
        });
      }
      if (spendPermissionRecord.spender.trim() !== configuredSpender.trim()) {
        discrepancies.push({
          code: "spender_mismatch",
          severity: "critical",
          message: "Spend permission record spender does not match configured deployment spender.",
          expected: configuredSpender.trim(),
          observed: spendPermissionRecord.spender.trim(),
        });
      }
      if (spendPermissionRecord.allowanceAtomic !== policyAllowance) {
        discrepancies.push({
          code: "spend_record_allowance_mismatch",
          severity: "critical",
          message: "Spend permission record allowance differs from copy policy allowance.",
          expected: policyAllowance.toString(),
          observed: spendPermissionRecord.allowanceAtomic.toString(),
        });
      }
      if (spendPermissionRecord.periodSeconds !== permission.spendPermission.periodSeconds) {
        discrepancies.push({
          code: "spend_record_period_mismatch",
          severity: "warning",
          message: "Spend permission record periodSeconds differs from copy policy periodSeconds.",
          expected: String(permission.spendPermission.periodSeconds),
          observed: String(spendPermissionRecord.periodSeconds),
        });
      }
      if (spendPermissionRecord.revokedAt && permission.status === "active") {
        discrepancies.push({
          code: "spend_record_revoked_with_active_policy",
          severity: "critical",
          message: "Spend permission record is revoked while copy policy is still marked active.",
          expected: "revoked",
          observed: permission.status,
        });
      }
      if (nowSeconds !== null) {
        const ledgerExpired =
          currentLedger !== undefined &&
          spendPermissionRecord.expirationLedger !== undefined &&
          currentLedger > spendPermissionRecord.expirationLedger;
        if (nowSeconds < spendPermissionRecord.startAt || nowSeconds >= spendPermissionRecord.endAt || ledgerExpired) {
          discrepancies.push({
            code: "spend_record_lifecycle_mismatch",
            severity: "warning",
            message: ledgerExpired
              ? "Spend permission record expirationLedger has passed."
              : nowSeconds < spendPermissionRecord.startAt
                ? "Spend permission record has not started yet."
                : "Spend permission record has expired.",
            expected: `${spendPermissionRecord.startAt}..${spendPermissionRecord.endAt}`,
            observed: String(nowSeconds),
          });
        }
      }
    }

    // 3. Inactive policy with lingering on-chain allowance.
    if ((permission.status !== "active" || expired) && validOnchain > 0n) {
      discrepancies.push({
        code: "stale_onchain_allowance",
        severity: "warning",
        message: "On-chain SAC allowance remains non-zero for a revoked, paused, or expired copy policy.",
        expected: "0",
        observed: validOnchain.toString(),
      });
    }

    // 4. Policy vs. authorized on-chain allowance comparison.
    if (policyAllowance < maxPerPositionAtomic) {
      discrepancies.push({
        code: "policy_allowance_below_position_cap",
        severity: "warning",
        message: "Policy spend allowance is smaller than maxPerPositionUsdc.",
        expected: maxPerPositionAtomic.toString(),
        observed: policyAllowance.toString(),
      });
    }
    if (remainingPeriodBudget !== null && validOnchain < remainingPeriodBudget) {
      discrepancies.push({
        code: "onchain_allowance_below_remaining_period_budget",
        severity: "warning",
        message: "Authoritative on-chain SAC allowance is lower than the remaining rolling-period budget.",
        expected: remainingPeriodBudget.toString(),
        observed: validOnchain.toString(),
      });
    }
    if (validOnchain > policyAllowance) {
      discrepancies.push({
        code: "onchain_allowance_exceeds_policy_allowance",
        severity: "warning",
        message: "On-chain SAC allowance exceeds the single-period copy policy allowance.",
        expected: policyAllowance.toString(),
        observed: validOnchain.toString(),
      });
    }

    // 5. Observed consumption vs. owner policy limits.
    if (validSpentPeriod > policyAllowance) {
      discrepancies.push({
        code: "consumption_exceeds_period_allowance",
        severity: "critical",
        message: "Observed period consumption exceeds the signed spend permission allowance.",
        expected: policyAllowance.toString(),
        observed: validSpentPeriod.toString(),
      });
    }
    if (usedTodayAtomic > dailyCapAtomic) {
      discrepancies.push({
        code: "consumption_exceeds_daily_cap",
        severity: "critical",
        message: "Observed daily consumption exceeds the owner policy dailyCapUsdc.",
        expected: dailyCapAtomic.toString(),
        observed: usedTodayAtomic.toString(),
      });
    }
    if (usedThisWeekAtomic > weeklyCapAtomic) {
      discrepancies.push({
        code: "consumption_exceeds_weekly_cap",
        severity: "critical",
        message: "Observed weekly consumption exceeds the owner policy weeklyCapUsdc.",
        expected: weeklyCapAtomic.toString(),
        observed: usedThisWeekAtomic.toString(),
      });
    }
    if (openExposureAtomic > totalOpenExposureAtomic) {
      discrepancies.push({
        code: "open_exposure_exceeds_cap",
        severity: "critical",
        message: "Observed open exposure exceeds the owner policy totalOpenExposureUsdc.",
        expected: totalOpenExposureAtomic.toString(),
        observed: openExposureAtomic.toString(),
      });
    }
    if (realizedLossAtomic > maxRealizedLossAtomic) {
      discrepancies.push({
        code: "realized_loss_exceeds_limit",
        severity: "critical",
        message: "Observed realized loss exceeds the owner policy maxRealizedLossAtomic.",
        expected: maxRealizedLossAtomic.toString(),
        observed: realizedLossAtomic.toString(),
      });
    }
  }

  const highestSeverity = highestSeverityOf(discrepancies);
  const reconciled = discrepancies.length === 0;
  const remediationRequired = discrepancies.some(
    (d) => d.severity === "critical" || d.severity === "warning",
  );

  return {
    mode: "read_only",
    remediationApplied: false,
    permissionId: permission.permissionId,
    ownerWallet: permission.ownerWallet,
    executionAgentId: permission.executionAgentId,
    evaluatedAt: now,
    reconciled,
    remediationRequired,
    highestSeverity,
    policy: {
      status: permission.status,
      expired,
      token: permission.spendPermission.token,
      spender: permission.spendPermission.spender,
      allowanceAtomic: policyAllowance !== null ? policyAllowance.toString() : null,
      periodSeconds: permission.spendPermission.periodSeconds,
      maxPerPositionAtomic: maxPerPositionAtomic !== null ? maxPerPositionAtomic.toString() : null,
      dailyCapAtomic: dailyCapAtomic !== null ? dailyCapAtomic.toString() : null,
      weeklyCapAtomic: weeklyCapAtomic !== null ? weeklyCapAtomic.toString() : null,
      totalOpenExposureAtomic: totalOpenExposureAtomic !== null ? totalOpenExposureAtomic.toString() : null,
      maxRealizedLossAtomic: maxRealizedLossAtomic !== null ? maxRealizedLossAtomic.toString() : null,
    },
    authorized: {
      configuredUsdc,
      configuredSpender,
      onchainAllowanceAtomic: validOnchain !== null ? validOnchain.toString() : null,
      spendPermissionHash: spendPermissionRecord?.permissionHash ?? null,
      spendRecordAllowanceAtomic: spendPermissionRecord ? spendPermissionRecord.allowanceAtomic.toString() : null,
      spendRecordPeriodSeconds: spendPermissionRecord?.periodSeconds ?? null,
      periodStart,
      periodEndsAt,
    },
    observed: {
      spentThisPeriodAtomic: validSpentPeriod !== null ? validSpentPeriod.toString() : null,
      remainingPeriodBudgetAtomic: remainingPeriodBudget !== null ? remainingPeriodBudget.toString() : null,
      effectiveRemainingAtomic: effectiveRemaining !== null ? effectiveRemaining.toString() : null,
      usedTodayAtomic: usedTodayAtomic !== null ? usedTodayAtomic.toString() : null,
      usedThisWeekAtomic: usedThisWeekAtomic !== null ? usedThisWeekAtomic.toString() : null,
      openExposureAtomic: openExposureAtomic !== null ? openExposureAtomic.toString() : null,
      realizedLossAtomic: realizedLossAtomic !== null ? realizedLossAtomic.toString() : null,
    },
    discrepancies,
  };
}

/**
 * Aggregate multiple read-only reconciliation reports into a summary for operator
 * review before any remediation is taken.
 */
export function summarizeDelegatedAllowanceReconciliation(
  reports: readonly DelegatedAllowanceReconciliationReport[],
): DelegatedAllowanceReconciliationSummary {
  const byCode: Partial<Record<AllowanceDiscrepancyCode, number>> = {};
  let reconciled = 0;
  let remediationRequired = 0;
  let criticalCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const report of reports) {
    if (report.reconciled) reconciled += 1;
    if (report.remediationRequired) remediationRequired += 1;
    for (const d of report.discrepancies) {
      byCode[d.code] = (byCode[d.code] ?? 0) + 1;
      if (d.severity === "critical") criticalCount += 1;
      else if (d.severity === "warning") warningCount += 1;
      else infoCount += 1;
    }
  }

  return {
    mode: "read_only",
    remediationApplied: false,
    total: reports.length,
    reconciled,
    withDiscrepancies: reports.length - reconciled,
    remediationRequired,
    criticalCount,
    warningCount,
    infoCount,
    byCode,
  };
}
