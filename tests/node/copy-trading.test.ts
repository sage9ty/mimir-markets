import assert from "node:assert/strict";
import test from "node:test";
import { copyPolicyHash, evaluateCopy, validateCopyPermission, worstCaseCopySpend, computeCopyUsageFromExecutions, type CopyExecutionContext, type CopyPermission, type CopySignal, type CopyUsageExecutionRow } from "../../lib/copy-trading";
import { buildCopyExecutionDryRun } from "../../lib/copy-execution-dry-run";

// ── Every atomic figure here is 7 decimals ──────────────────────────────────
// These fixtures were written for 6-decimal ERC-20 USDC. Stellar USDC's SAC
// exposes 7 (lib/usdc.ts), so each atomic literal below was one order of
// magnitude too small: `maxRealizedLossAtomic: "15000000"` read as 1.5 USDC
// against a 15-USDC intent, and `allowanceAtomic: 10_000_000n` read as 1 USDC —
// less than the 3-USDC stake in `signal()`, so the happy-path test would have
// failed with `spend_permission_mismatch` rather than passing for the right
// reason.
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const MIMIR = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const OWNER = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
/** 1 USDC in atomic units at 7 decimals. */
const UNIT = 10_000_000n;
const NOW = 1_780_000_000_000;
function permission(overrides: Partial<CopyPermission> = {}): CopyPermission {
  const base = { permissionId: "perm-1", ownerWallet: OWNER,
    executionAgentId: "agent-b", signalAgentId: "agent-a", maxPerPositionUsdc: 5,
    dailyCapUsdc: 10, weeklyCapUsdc: 30, totalOpenExposureUsdc: 20,
    maxRealizedLossAtomic: String(15n * UNIT),
    allowedCategories: ["crypto"], allowedModes: ["pool"], minConfidenceBps: 7000,
    minPayoutBps: 12000, expiresAt: NOW + 60_000, depth: 1 as const, status: "active" as const,
    spendPermission: { token: USDC, spender: MIMIR, allowanceAtomic: 10n * UNIT, periodSeconds: 86400 } };
  return { ...base, signedPolicyHash: copyPolicyHash(base), ...overrides };
}
function signal(overrides: Partial<CopySignal> = {}): CopySignal { return {
  sourcePositionId: "pos-a-1", signalAgentId: "agent-a", sourceDepth: 0, claimId: 7,
  category: "crypto", mode: "pool", confidenceBps: 8000, payoutBps: 15000,
  stakeUsdc: 3, deadline: NOW + 30_000, remainingSlots: 2, availableLiquidityUsdc: 10,
  requiredLiquidityUsdc: 3, sourceAttributionId: "attr-a-1", ...overrides }; }
function context(overrides: Partial<CopyExecutionContext> = {}): CopyExecutionContext { return {
  now: NOW, globalPaused: false, usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0, realizedLossAtomic: "0", principalAtRiskAtomic: "0" },
  existingClaimIds: new Set(), ancestryAgentIds: ["agent-a"], configuredUsdc: USDC,
  configuredSpender: MIMIR, onchainAllowanceAtomic: 10n * UNIT,
  simulation: { ok: true, blockNumber: 100n }, ...overrides }; }
const reason = (v: ReturnType<typeof evaluateCopy>) => "reason" in v ? v.reason : null;

test("follow is absent from permission: social state cannot spend", () => {
  assert.equal("followed" in permission(), false);
  assert.deepEqual(worstCaseCopySpend(permission()), { perPositionUsdc: 5, dailyUsdc: 10, weeklyUsdc: 30, totalOpenUsdc: 20 });
});
test("a fully admitted fresh signal executes", () => assert.deepEqual(evaluateCopy(permission(), signal(), context()), { allowed: true, stakeUsdc: 3 }));
test("revoke and global pause are immediate", () => {
  assert.equal(reason(evaluateCopy(permission({ status: "revoked" }), signal(), context())), "permission_revoked");
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ globalPaused: true }))), "global_paused");
});
test("depth, self-copy and A-to-B-to-A cycles are blocked", () => {
  assert.equal(reason(evaluateCopy(permission(), signal({ sourceDepth: 1 }), context())), "copy_depth");
  assert.equal(reason(evaluateCopy(permission(), signal({ signalAgentId: "agent-b" }), context())), "self_copy");
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ ancestryAgentIds: ["agent-b", "agent-a"] }))), "cycle");
});
test("duplicate, stale, full and exhausted markets skip before signing", () => {
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ existingClaimIds: new Set([7]) }))), "duplicate_position");
  assert.equal(reason(evaluateCopy(permission(), signal({ deadline: NOW }), context())), "stale_signal");
  assert.equal(reason(evaluateCopy(permission(), signal({ remainingSlots: 0 }), context())), "market_full");
  assert.equal(reason(evaluateCopy(permission(), signal({ availableLiquidityUsdc: 2 }), context())), "liquidity_exhausted");
});
test("confidence, payout, position and rolling budgets are hard floors/caps", () => {
  assert.equal(reason(evaluateCopy(permission(), signal({ confidenceBps: 6999 }), context())), "confidence_below_floor");
  assert.equal(reason(evaluateCopy(permission(), signal({ payoutBps: 11999 }), context())), "payout_below_floor");
  assert.equal(reason(evaluateCopy(permission(), signal({ stakeUsdc: 6 }), context())), "position_cap");
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ usage: { usedTodayUsdc: 8, usedThisWeekUsdc: 0, openExposureUsdc: 0, realizedLossAtomic: "0", principalAtRiskAtomic: "0" } }))), "daily_cap");
});
test("the signed realized-loss limit reserves the full next principal", () => {
  // Limit 15 USDC. With zero open principal, 12 USDC of prior settled loss is
  // the exact edge before a 3 USDC stake triggers the limit.
  const priorLoss = (atomic: bigint) => context({
    usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0, realizedLossAtomic: String(atomic), principalAtRiskAtomic: "0" },
  });
  assert.equal(reason(evaluateCopy(permission(), signal(), priorLoss(12n * UNIT + 1n))), "loss_limit");
  assert.equal(evaluateCopy(permission(), signal(), priorLoss(12n * UNIT)).allowed, true);
});

test("open principal at risk is counted separately from realized (settled) loss", () => {
  // Before: a single realizedLossAtomic field conflated settled loss with open
  // principal — a position still open would be counted as already realized.
  // After: principalAtRiskAtomic is a separate field; both are summed in the gate.

  // 9 USDC settled loss + 3 USDC open principal + 3 USDC next stake = 15 USDC = limit. Exactly at edge.
  const atEdge = context({
    usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0,
      realizedLossAtomic: String(9n * UNIT), principalAtRiskAtomic: String(3n * UNIT) },
  });
  assert.deepEqual(evaluateCopy(permission(), signal(), atEdge), { allowed: true, stakeUsdc: 3 });

  // 9 USDC settled + 3 USDC open + 3 USDC stake = 15 USDC = limit — allowed.
  // Pushing open principal 1 atom over tips it past the ceiling.
  const oneOver = context({
    usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0,
      realizedLossAtomic: String(9n * UNIT), principalAtRiskAtomic: String(3n * UNIT + 1n) },
  });
  assert.equal(reason(evaluateCopy(permission(), signal(), oneOver)), "loss_limit");

  // All open principal, zero settled loss: open positions must NOT be shown as realized.
  const allOpen = context({
    usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0,
      realizedLossAtomic: "0", principalAtRiskAtomic: String(12n * UNIT) },
  });
  assert.deepEqual(evaluateCopy(permission(), signal(), allOpen), { allowed: true, stakeUsdc: 3 });

  // All open, 1 atom over: still blocked correctly even with zero realized loss.
  const allOpenBlocked = context({
    usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0,
      realizedLossAtomic: "0", principalAtRiskAtomic: String(12n * UNIT + 1n) },
  });
  assert.equal(reason(evaluateCopy(permission(), signal(), allOpenBlocked)), "loss_limit");
});

test("malformed principalAtRiskAtomic is rejected as malformed_context", () => {
  const bad = (principalAtRiskAtomic: unknown) => context({
    usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0,
      realizedLossAtomic: "0", principalAtRiskAtomic: principalAtRiskAtomic as string },
  });
  assert.equal(reason(evaluateCopy(permission(), signal(), bad("1e7"))), "malformed_context");
  assert.equal(reason(evaluateCopy(permission(), signal(), bad("-1"))), "malformed_context");
  assert.equal(reason(evaluateCopy(permission(), signal(), bad(undefined))), "malformed_context");
  assert.equal(reason(evaluateCopy(permission(), signal(), bad(1n))), "malformed_context");
  // "0" is valid.
  assert.equal(reason(evaluateCopy(permission(), signal(), bad("0"))), null);
});
test("malformed or unsafe copy policies are rejected before persistence", () => {
  const { signedPolicyHash: _, ...valid } = permission();
  assert.equal(validateCopyPermission(valid, NOW), null);
  assert.equal(validateCopyPermission({ ...valid, maxRealizedLossAtomic: "1e7" }, NOW), "invalid_budget");
  // Not a strkey. A lowercased strkey is also rejected — case-sensitive base32.
  assert.equal(validateCopyPermission({ ...valid, ownerWallet: "0xnope" }, NOW), "invalid_address");
  assert.equal(validateCopyPermission({ ...valid, ownerWallet: OWNER.toLowerCase() }, NOW), "invalid_address");
  assert.equal(validateCopyPermission({ ...valid, expiresAt: NOW }, NOW), "invalid_lifecycle");
});
test("on-chain token, spender and allowance are verified, then simulation must pass", () => {
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ onchainAllowanceAtomic: 0n }))), "spend_permission_mismatch");
  // And a case-folded token id must not match the configured one.
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ configuredUsdc: USDC.toLowerCase() }))), "spend_permission_mismatch");
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ simulation: { ok: false, blockNumber: 101n } }))), "simulation_failed");
});

test("dry-run reports a policy-eligible atomic stake without claiming execution", () => {
  const { globalPaused: _, simulation: _simulation, ...snapshot } = context();
  const result = buildCopyExecutionDryRun({ permission: permission(), signal: signal(), context: snapshot,
    env: { MIMIR_FEATURE_COPY_TRADING: "0" } });
  assert.equal(result.policyEligible, true);
  assert.equal(result.stakeAtomic, "30000000");
  assert.equal(result.fundedGateOpen, false);
  assert.equal(result.fundedGateBlock, "feature_disabled");
  assert.equal(result.simulation, "not_run");
  assert.equal(result.executionReady, false);
  assert.equal(result.transactionSubmitted, false);
  assert.equal(result.feeQuote, null);
});

test("dry-run respects pause, stale, duplicate, cancelled and dependency inputs", () => {
  const { globalPaused: _, simulation: _simulation, ...snapshot } = context();
  const preview = (candidate: CopySignal, overrides: Partial<typeof snapshot> = {}, env: Record<string, string> = { MIMIR_FEATURE_COPY_TRADING: "1" }) =>
    buildCopyExecutionDryRun({ permission: permission(), signal: candidate, context: { ...snapshot, ...overrides }, env });
  assert.equal(preview(signal(), {}, { MIMIR_FEATURE_COPY_TRADING: "1", MIMIR_PAUSE_COPY_EXECUTION: "1" }).reason, "global_paused");
  assert.equal(preview(signal({ deadline: NOW })).reason, "stale_signal");
  assert.equal(preview(signal(), { existingClaimIds: new Set([7]) }).reason, "duplicate_position");
  assert.equal(preview(signal({ marketState: "cancelled" })).reason, "market_cancelled");
  assert.equal(preview(signal(), { onchainAllowanceAtomic: 0n }).reason, "spend_permission_mismatch");
  assert.equal(preview(signal(), {}, { MIMIR_FEATURE_COPY_TRADING: "1", MIMIR_DISABLE_CATEGORY_CRYPTO: "1" }).reason, "category_disabled");
});

test("malformed and mismatched signals fail closed without throwing", () => {
  assert.equal(reason(evaluateCopy(permission(), signal({ signalAgentId: "agent-c" }), context())), "signal_agent_mismatch");
  assert.equal(reason(evaluateCopy(permission(), signal({ marketState: "resolved" }), context())), "market_closed");
  assert.equal(reason(evaluateCopy(permission(), signal({ stakeUsdc: Number.NaN }), context())), "malformed_signal");
  assert.equal(reason(evaluateCopy(permission(), signal({ remainingSlots: Number.NaN }), context())), "malformed_signal");
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ usage: { usedTodayUsdc: Number.NaN, usedThisWeekUsdc: 0,
    openExposureUsdc: 0, realizedLossAtomic: "0", principalAtRiskAtomic: "0" } }))), "malformed_context");
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ usage: { usedTodayUsdc: 1n as unknown as number,
    usedThisWeekUsdc: 0, openExposureUsdc: 0, realizedLossAtomic: "0", principalAtRiskAtomic: "0" } }))), "malformed_context");
});

// ── Usage from executions (permission-card budget bars) ──────────────────────
// NOW is 2026-05-28T20:26:40Z (Thursday). Windows are UTC-aligned: the day
// from 00:00 UTC, the week from Monday 2026-05-25T00:00:00Z.
const DAY_START = 1_779_926_400_000; // 2026-05-28T00:00:00.000Z
const WEEK_START = 1_779_667_200_000; // 2026-05-25T00:00:00.000Z
const execution = (overrides: Partial<CopyUsageExecutionRow> = {}): CopyUsageExecutionRow => ({
  status: "executed", stake_atomic: String(UNIT), created_at: NOW, ...overrides });

test("executed stakes land in the UTC day/week/open buckets", () => {
  const usage = computeCopyUsageFromExecutions([
    execution(),
    execution({ stake_atomic: String(2n * UNIT) }),
    execution({ created_at: DAY_START - 1 }),              // yesterday: week + open only
    execution({ created_at: WEEK_START - 1 }),             // last week: open only
  ], NOW);
  assert.equal(usage.usedTodayUsdc, 3);
  assert.equal(usage.usedThisWeekUsdc, 4);
  assert.equal(usage.openExposureUsdc, 5);
  assert.equal(usage.dailyUsedAtomic, "30000000");
  assert.equal(usage.weeklyUsedAtomic, "40000000");
  assert.equal(usage.openExposureAtomic, "50000000");
  assert.equal(usage.countedExecutions, 4);
  // Window-open rows belong to the window they open.
  const boundary = computeCopyUsageFromExecutions([
    execution({ created_at: DAY_START }), execution({ created_at: WEEK_START })], NOW);
  assert.equal(boundary.usedTodayUsdc, 1);
  assert.equal(boundary.usedThisWeekUsdc, 2);
  assert.equal(boundary.openExposureUsdc, 2);
});

test("only executed rows count and spend never fabricates realized loss", () => {
  const usage = computeCopyUsageFromExecutions([
    execution(),
    execution({ status: "skipped", stake_atomic: String(9n * UNIT) }),
    execution({ status: "failed", stake_atomic: String(9n * UNIT) }),
    execution({ status: "expired", stake_atomic: String(9n * UNIT) }),
  ], NOW);
  assert.equal(usage.usedTodayUsdc, 1);
  assert.equal(usage.openExposureUsdc, 1);
  assert.equal(usage.countedExecutions, 1);
  // The loss ceiling needs settlement outcomes, which audit rows do not carry.
  assert.equal("realizedLossAtomic" in usage, false);
});

test("usage totals feed evaluateCopy with the gate's own view of the caps", () => {
  const rows = [execution({ stake_atomic: String(4n * UNIT) }), execution({ stake_atomic: String(3n * UNIT) }),
    execution({ stake_atomic: String(2n * UNIT) }), execution({ created_at: DAY_START - 1, stake_atomic: String(9n * UNIT) })];
  const usage = computeCopyUsageFromExecutions(rows, NOW);
  const derived = { usedTodayUsdc: usage.usedTodayUsdc, usedThisWeekUsdc: usage.usedThisWeekUsdc,
    openExposureUsdc: usage.openExposureUsdc, realizedLossAtomic: "0", principalAtRiskAtomic: "0" };
  // daily 9 + 3 USDC stake exceeds the 10 USDC cap.
  assert.equal(reason(evaluateCopy(permission(), signal(), context({ now: NOW, usage: derived }))), "daily_cap");
  // The helper's display numbers pass the gate's malformed-context screen and
  // 9 + 0.5 stays under the cap — usage is admitted exactly as computed.
  assert.deepEqual(evaluateCopy(permission(), signal({ stakeUsdc: 0.5 }), context({ now: NOW, usage: derived })),
    { allowed: true, stakeUsdc: 0.5 });
  // Open exposure 18 (daily/weekly emptied) blocks the 3 USDC stake on its own cap.
  assert.equal(reason(evaluateCopy(permission(), signal(),
    context({ now: NOW, usage: { ...derived, usedTodayUsdc: 0, usedThisWeekUsdc: 0 } }))), "open_exposure_cap");
});

test("malformed execution rows are skipped without throwing", () => {
  const usage = computeCopyUsageFromExecutions([
    execution(),
    execution({ stake_atomic: "-1" }),
    execution({ stake_atomic: "1e7" }),
    execution({ stake_atomic: 1.5 }),
    execution({ created_at: "not-a-time" }),
    execution({ created_at: undefined, stake_atomic: undefined }),
    null as unknown as CopyUsageExecutionRow,
  ], NOW);
  assert.equal(usage.usedTodayUsdc, 1);
  assert.equal(usage.countedExecutions, 1);
});

test("seconds-epoch and camelCase rows are accepted", () => {
  const usage = computeCopyUsageFromExecutions([
    { status: "executed", stakeAtomic: "10000000", createdAt: Math.floor(NOW / 1000) },
  ], NOW);
  assert.equal(usage.usedTodayUsdc, 1);
  assert.equal(usage.openExposureUsdc, 1);
});

test("reset stamps are the next UTC midnight and next Monday", () => {
  const usage = computeCopyUsageFromExecutions([], NOW);
  assert.equal(usage.nextDailyResetAtMs, DAY_START + 86_400_000);
  assert.equal(usage.nextWeeklyResetAtMs, WEEK_START + 7 * 86_400_000);
  assert.equal(new Date(usage.nextDailyResetAtMs).toISOString(), "2026-05-29T00:00:00.000Z");
  assert.equal(new Date(usage.nextWeeklyResetAtMs).toISOString(), "2026-06-01T00:00:00.000Z");
});
