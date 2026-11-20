import assert from "node:assert/strict";
import test from "node:test";
import { COPY_INTENT_RECONCILE_WINDOW_MS, gateResubmission, reconcileUnknownIntents, reservedSpendAtomic, type CopyChainPosition, type CopyExecutionIntent } from "./copy-trading";

const UNIT = 10_000_000n;
const POLICY = "perm-1";
const MEMBER = "agent-b";
const NOW = 1_780_000_000_000;

function intent(overrides: Partial<CopyExecutionIntent> = {}): CopyExecutionIntent {
  return { id: "intent-1", policyId: POLICY, member: MEMBER, stakeAtomic: 3n * UNIT, idempotencyKey: "idem-1", status: "pending", createdAt: NOW, ...overrides };
}
function position(overrides: Partial<CopyChainPosition> = {}): CopyChainPosition {
  return { txHash: "aa".repeat(32), positionId: "pos-1", stakeAtomic: 3n * UNIT, ...overrides };
}

test("timeout leaves intent unknown and refuses resubmit", () => {
  const afterTimeout: CopyExecutionIntent = { ...intent(), status: "unknown", submittedAt: NOW, txHash: "aa".repeat(32) };
  const decision = gateResubmission({ policyId: POLICY, member: MEMBER, stakeAtomic: 3n * UNIT }, [afterTimeout], NOW + 1000);
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.reason, "unknown_intent");
});

test("reconcile against matching chain position marks confirmed", () => {
  const afterTimeout: CopyExecutionIntent = { ...intent(), status: "unknown", submittedAt: NOW, txHash: "aa".repeat(32) };
  const result = reconcileUnknownIntents([afterTimeout], [position()], NOW + 2000);
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.confirmed[0]!.status, "confirmed");
  assert.equal(result.confirmed[0]!.positionId, "pos-1");
});

test("reconcile past the window with no match holds intent, still refuses resubmit", () => {
  const afterTimeout: CopyExecutionIntent = { ...intent(), status: "unknown", submittedAt: NOW, txHash: "aa".repeat(32) };
  const result = reconcileUnknownIntents([afterTimeout], [], NOW + COPY_INTENT_RECONCILE_WINDOW_MS + 1);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0]!.status, "unknown");
  const decision = gateResubmission({ policyId: POLICY, member: MEMBER, stakeAtomic: 3n * UNIT }, result.held, NOW + COPY_INTENT_RECONCILE_WINDOW_MS + 2);
  assert.equal(decision.allowed, false);
});

test("different stake, member or policy is not blocked", () => {
  const existing: CopyExecutionIntent = { ...intent(), status: "unknown", submittedAt: NOW, txHash: "aa".repeat(32) };
  assert.equal(gateResubmission({ policyId: POLICY, member: MEMBER, stakeAtomic: 4n * UNIT }, [existing], NOW).allowed, true);
  assert.equal(gateResubmission({ policyId: POLICY, member: "agent-c", stakeAtomic: 3n * UNIT }, [existing], NOW).allowed, true);
  assert.equal(gateResubmission({ policyId: "perm-2", member: MEMBER, stakeAtomic: 3n * UNIT }, [existing], NOW).allowed, true);
});

test("reservedSpendAtomic counts pending/unknown once, drops on confirm", () => {
  const pending = intent({ status: "pending" });
  const unknown: CopyExecutionIntent = { ...intent({ id: "intent-2" }), status: "unknown", txHash: "bb".repeat(32) };
  const confirmed: CopyExecutionIntent = { ...intent({ id: "intent-3", stakeAtomic: 5n * UNIT }), status: "confirmed" };
  assert.equal(reservedSpendAtomic([pending]), 3n * UNIT);
  assert.equal(reservedSpendAtomic([pending, unknown]), 6n * UNIT);
  assert.equal(reservedSpendAtomic([pending, unknown, confirmed]), 6n * UNIT);
  assert.equal(reservedSpendAtomic([confirmed]), 0n);
});

test("empty / malformed input is a no-op", () => {
  assert.deepEqual(reconcileUnknownIntents([], [], NOW), { confirmed: [], stillUnknown: [], held: [] });
  assert.equal(reservedSpendAtomic([]), 0n);
  assert.equal(gateResubmission({ policyId: POLICY, member: MEMBER, stakeAtomic: 3n * UNIT }, [], NOW).allowed, true);
});
