import assert from "node:assert/strict";
import test from "node:test";
import { permissionKey, type SpendPermissionRecord } from "../../lib/agents/spend-permissions";
import {
  buildDelegatedAllowanceReconciliationReport,
  summarizeDelegatedAllowanceReconciliation,
  type DelegatedAllowanceReconciliationInput,
} from "../../lib/copy-allowance-reconciliation";
import { copyPolicyHash, type CopyPermission } from "../../lib/copy-trading";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const MIMIR = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const OWNER = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const OTHER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
/** 1 USDC in 7-decimal atomic units. */
const UNIT = 10_000_000n;
const DAY = 86_400;
const NOW_MS = 1_780_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const SIGNATURE = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw";

function makePermission(overrides: Partial<CopyPermission> = {}): CopyPermission {
  const base = {
    permissionId: "perm-1",
    ownerWallet: OWNER,
    executionAgentId: "agent-b",
    signalAgentId: "agent-a",
    maxPerPositionUsdc: 5,
    dailyCapUsdc: 10,
    weeklyCapUsdc: 30,
    totalOpenExposureUsdc: 20,
    maxRealizedLossAtomic: String(15n * UNIT),
    allowedCategories: ["crypto"],
    allowedModes: ["pool"],
    minConfidenceBps: 7000,
    minPayoutBps: 12000,
    expiresAt: NOW_MS + 60_000,
    depth: 1 as const,
    status: "active" as const,
    spendPermission: { token: USDC, spender: MIMIR, allowanceAtomic: 10n * UNIT, periodSeconds: DAY },
  };
  return { ...base, signedPolicyHash: copyPolicyHash(base), ...overrides };
}

function makeSpendRecord(overrides: Partial<SpendPermissionRecord> = {}): SpendPermissionRecord {
  const fields = {
    account: OWNER,
    spender: MIMIR,
    token: USDC,
    allowanceAtomic: 10n * UNIT,
    periodSeconds: DAY,
    startAt: NOW_SEC - 3600,
    endAt: NOW_SEC + 7 * DAY,
    salt: "0",
    ...overrides,
  };
  return {
    agentId: "agent-b",
    extraData: "",
    signature: SIGNATURE,
    permissionJson: "{}",
    createdAt: NOW_MS - 3_600_000,
    ...overrides,
    ...fields,
    permissionHash: permissionKey(fields),
  };
}

function makeInput(
  overrides: Partial<DelegatedAllowanceReconciliationInput> = {},
): DelegatedAllowanceReconciliationInput {
  return {
    now: NOW_MS,
    permission: makePermission(),
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    onchainAllowanceAtomic: 7n * UNIT,
    usage: {
      usedTodayUsdc: 3,
      usedThisWeekUsdc: 3,
      openExposureUsdc: 3,
      realizedLossAtomic: "0",
    },
    spentThisPeriodAtomic: 3n * UNIT,
    spendPermissionRecord: makeSpendRecord(),
    ...overrides,
  };
}

test("reconciled policy, authorized allowance, and consumption produce a clean read-only report", () => {
  const report = buildDelegatedAllowanceReconciliationReport(makeInput());
  assert.equal(report.mode, "read_only");
  assert.equal(report.remediationApplied, false);
  assert.equal(report.reconciled, true);
  assert.equal(report.remediationRequired, false);
  assert.equal(report.highestSeverity, "none");
  assert.deepEqual(report.discrepancies, []);
  assert.equal(report.observed.remainingPeriodBudgetAtomic, String(7n * UNIT));
  assert.equal(report.observed.effectiveRemainingAtomic, String(7n * UNIT));
  // Report must be directly JSON-serializable without BigInt errors.
  assert.doesNotThrow(() => JSON.stringify(report));
});

test("identity and binding mismatches are flagged as critical, including case-folded strkeys", () => {
  const report = buildDelegatedAllowanceReconciliationReport(makeInput({
    configuredUsdc: USDC.toLowerCase(),
    configuredSpender: OTHER,
    spendPermissionRecord: makeSpendRecord({ account: OTHER, agentId: "agent-x" }),
  }));
  const codes = new Set(report.discrepancies.map((d) => d.code));
  assert.equal(report.reconciled, false);
  assert.equal(report.highestSeverity, "critical");
  assert.equal(codes.has("token_mismatch"), true);
  assert.equal(codes.has("spender_mismatch"), true);
  assert.equal(codes.has("owner_account_mismatch"), true);
  assert.equal(codes.has("agent_mismatch"), true);
});

test("on-chain allowance drift and stale allowance on inactive policies are reported", () => {
  const drained = buildDelegatedAllowanceReconciliationReport(makeInput({
    onchainAllowanceAtomic: 2n * UNIT,
  }));
  assert.equal(drained.reconciled, false);
  assert.equal(drained.discrepancies.some((d) => d.code === "onchain_allowance_below_remaining_period_budget"), true);
  assert.equal(drained.observed.effectiveRemainingAtomic, String(2n * UNIT));

  const wider = buildDelegatedAllowanceReconciliationReport(makeInput({
    onchainAllowanceAtomic: 25n * UNIT,
  }));
  assert.equal(wider.discrepancies.some((d) => d.code === "onchain_allowance_exceeds_policy_allowance"), true);
  assert.equal(wider.observed.effectiveRemainingAtomic, String(7n * UNIT));

  const staleRevoked = buildDelegatedAllowanceReconciliationReport(makeInput({
    permission: makePermission({ status: "revoked" }),
    onchainAllowanceAtomic: 5n * UNIT,
  }));
  assert.equal(staleRevoked.discrepancies.some((d) => d.code === "stale_onchain_allowance"), true);
});

test("spend permission record mismatches and ledger expiration are detected", () => {
  const report = buildDelegatedAllowanceReconciliationReport(makeInput({
    spendPermissionRecord: makeSpendRecord({
      allowanceAtomic: 8n * UNIT,
      periodSeconds: 2 * DAY,
      revokedAt: NOW_MS - 1000,
      expirationLedger: 500,
    }),
    currentLedger: 501,
  }));
  const codes = new Set(report.discrepancies.map((d) => d.code));
  assert.equal(codes.has("spend_record_allowance_mismatch"), true);
  assert.equal(codes.has("spend_record_period_mismatch"), true);
  assert.equal(codes.has("spend_record_revoked_with_active_policy"), true);
  assert.equal(codes.has("spend_record_lifecycle_mismatch"), true);
});

test("observed consumption exceeding policy limits is flagged at exact 7-decimal boundaries", () => {
  // Exact boundary: all at limit -> still reconciled.
  const atBoundary = buildDelegatedAllowanceReconciliationReport(makeInput({
    onchainAllowanceAtomic: 0n,
    spentThisPeriodAtomic: 10n * UNIT,
    usage: {
      usedTodayUsdc: 10,
      usedThisWeekUsdc: 30,
      openExposureUsdc: 20,
      realizedLossAtomic: String(15n * UNIT),
    },
  }));
  assert.equal(atBoundary.reconciled, true);

  // Over limit by minimal increments -> critical discrepancies for each breached cap.
  const breached = buildDelegatedAllowanceReconciliationReport(makeInput({
    onchainAllowanceAtomic: 0n,
    spentThisPeriodAtomic: 10n * UNIT + 1n,
    usage: {
      usedTodayUsdc: 10.0000001,
      usedThisWeekUsdc: 30.0000001,
      openExposureUsdc: 20.0000001,
      realizedLossAtomic: String(15n * UNIT + 1n),
    },
  }));
  const codes = new Set(breached.discrepancies.map((d) => d.code));
  assert.equal(breached.highestSeverity, "critical");
  assert.equal(codes.has("consumption_exceeds_period_allowance"), true);
  assert.equal(codes.has("consumption_exceeds_daily_cap"), true);
  assert.equal(codes.has("consumption_exceeds_weekly_cap"), true);
  assert.equal(codes.has("open_exposure_exceeds_cap"), true);
  assert.equal(codes.has("realized_loss_exceeds_limit"), true);
});

test("malformed inputs fail closed without throwing", () => {
  const negativeAllowance = buildDelegatedAllowanceReconciliationReport(makeInput({
    onchainAllowanceAtomic: -1n,
  }));
  assert.equal(negativeAllowance.reconciled, false);
  assert.equal(negativeAllowance.highestSeverity, "critical");
  assert.equal(negativeAllowance.discrepancies[0]?.code, "malformed_input");

  const nanUsage = buildDelegatedAllowanceReconciliationReport(makeInput({
    usage: {
      usedTodayUsdc: Number.NaN,
      usedThisWeekUsdc: 0,
      openExposureUsdc: 0,
      realizedLossAtomic: "0",
    },
  }));
  assert.equal(nanUsage.discrepancies[0]?.code, "malformed_input");
});

test("summary aggregates multiple read-only reports", () => {
  const clean = buildDelegatedAllowanceReconciliationReport(makeInput());
  const drifted = buildDelegatedAllowanceReconciliationReport(makeInput({
    onchainAllowanceAtomic: 1n * UNIT,
  }));
  const summary = summarizeDelegatedAllowanceReconciliation([clean, drifted]);
  assert.equal(summary.mode, "read_only");
  assert.equal(summary.remediationApplied, false);
  assert.equal(summary.total, 2);
  assert.equal(summary.reconciled, 1);
  assert.equal(summary.withDiscrepancies, 1);
  assert.equal(summary.remediationRequired, 1);
  assert.equal(summary.warningCount, 1);
  assert.equal(summary.criticalCount, 0);
  assert.equal(summary.byCode.onchain_allowance_below_remaining_period_budget, 1);
});
