import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateUsdcTrustlineGate,
  usdcTrustlineGateFixture,
} from "../../lib/usdcTrustlineGate";

// Deterministic multi-connector transaction-state fixtures: rejection,
// account switch, timeout and late confirmation, exercised against the
// trustline gate with synthetic fixtures only (no extensions, no live wallets).

test("positive: a connected signer with a ready trustline can act", () => {
  const result = evaluateUsdcTrustlineGate(usdcTrustlineGateFixture());

  assert.equal(result.allowed, true);
  assert.equal(result.status, "ready");
  assert.equal(result.messageKey, "trustlineReady");
  assert.equal(result.action, "create");
});

test("negative: a missing trustline blocks and requests setup", () => {
  const result = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ status: "missing" }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.status, "missing");
  assert.equal(result.messageKey, "trustlineMissing");
});

test("negative: an unfunded account is distinct from a missing trustline", () => {
  const result = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ status: "unfunded" }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.status, "unfunded");
  assert.equal(result.messageKey, "trustlineUnfunded");
});

test("negative: disconnected and signerless wallets are blocked", () => {
  const disconnected = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ isConnected: false }),
  );
  const cannotSign = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ hasSigner: false }),
  );

  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.messageKey, "connectWalletFirst");
  assert.equal(cannotSign.status, "cannot_sign");
  assert.equal(cannotSign.messageKey, "cannotSign");
});

test("boundary: loading and stale reads block even when the last status was ready", () => {
  const loading = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ loading: true }),
  );
  const stale = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ stale: true }),
  );

  assert.equal(loading.allowed, false);
  assert.equal(loading.status, "loading");
  assert.equal(stale.allowed, false);
  assert.equal(stale.status, "stale");
});

test("dependency failure: unknown trustline reads never become a setup prompt", () => {
  const result = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ status: "unknown" }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.status, "dependency_failure");
  assert.equal(result.messageKey, "trustlineCheckFailed");
});

test("transaction state: a rejected signature blocks the action without a setup prompt", () => {
  const result = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ status: "ready", txState: "rejected" }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.status, "transaction_rejected");
  assert.notEqual(result.messageKey, "trustlineMissing");
});

test("transaction state: switching accounts mid-flow re-evaluates against the new signer", () => {
  const before = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ status: "ready", account: "GAAA" }),
  );
  const after = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ status: "missing", account: "GBBB" }),
  );

  assert.equal(before.allowed, true);
  assert.equal(after.allowed, false);
  assert.equal(after.status, "missing");
});

test("transaction state: a timed-out confirmation is treated as unknown, not ready", () => {
  const result = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ txState: "timeout" }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.status, "dependency_failure");
});

test("transaction state: a late confirmation after timeout unblocks only on re-read", () => {
  const timedOut = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ txState: "timeout" }),
  );
  const confirmed = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ status: "ready", txState: "confirmed_late" }),
  );

  assert.equal(timedOut.allowed, false);
  assert.equal(confirmed.allowed, true);
  assert.equal(confirmed.status, "ready");
});

test("regression: every funded action keeps the same ready policy", () => {
  const actions = [
    "create",
    "rematch",
    "accept",
    "mirror",
    "payout",
    "withdraw",
    "fees",
  ] as const;

  for (const action of actions) {
    const result = evaluateUsdcTrustlineGate(usdcTrustlineGateFixture({ action }));
    assert.equal(result.allowed, true);
    assert.equal(result.action, action);
  }
});
