/**
 * tests/node/challenge-recovery.test.ts
 *
 * Unit tests for the pure recovery state machine and localStorage store in
 * lib/challenge-recovery.ts (issue #919).
 * Coverage: positive, negative, boundary, and fail-closed regression.
 * No DOM or React renderer required — localStorage is faked per test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHALLENGE_RECOVERY_CHECK_INTERVAL_MS,
  CHALLENGE_RECOVERY_MAX_AGE_MS,
  CHALLENGE_RECOVERY_MAX_STATUS_CHECKS,
  applyChallengeStatusOutcome,
  challengeRecoveryTxHashFromError,
  clearChallengeRecoveryRecord,
  createChallengeRecoveryRecord,
  hasChallengeStatusBudget,
  isChallengeRecoveryBlocking,
  isChallengeRecoveryExpired,
  readChallengeRecoveryRecord,
  saveChallengeRecoveryRecord,
  type ChallengeRecoveryRecord,
} from "../../lib/challenge-recovery";
import { StellarTransactionError } from "../../lib/settlement-retry";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TX_HASH = "a".repeat(64);
const OTHER_HASH = "b1".repeat(32);
const WALLET = "GABC2345678901234567890123456789012345678901234567890123";

function makeRecord(
  overrides: Partial<ChallengeRecoveryRecord> = {},
): ChallengeRecoveryRecord {
  return {
    vsId: 42,
    txHash: TX_HASH,
    address: WALLET.toLowerCase(),
    stakeAmount: 5,
    submittedAtMs: 1_000_000,
    status: "unknown",
    statusChecks: 0,
    ...overrides,
  };
}

/** Minimal in-memory localStorage + window stub; restores globals on cleanup. */
function withFakeStorage<T>(
  initial: Record<string, string> | null,
  run: () => T,
): T {
  const store = new Map<string, string>(
    initial ? Object.entries(initial) : [],
  );
  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
  const hadWindow = "window" in globalThis;
  const prevWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = fakeWindow;
  try {
    return run();
  } finally {
    if (hadWindow) {
      (globalThis as Record<string, unknown>).window = prevWindow;
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

test("constants: bounded checks (5), ledger-close interval (5 s), 30-min expiry", () => {
  assert.equal(CHALLENGE_RECOVERY_MAX_STATUS_CHECKS, 5);
  assert.equal(CHALLENGE_RECOVERY_CHECK_INTERVAL_MS, 5_000);
  assert.equal(CHALLENGE_RECOVERY_MAX_AGE_MS, 30 * 60 * 1000);
});

// ── createChallengeRecoveryRecord ─────────────────────────────────────────────

test("positive: a new record starts unknown with zero checks consumed", () => {
  const record = makeRecord();
  assert.equal(record.status, "unknown");
  assert.equal(record.statusChecks, 0);
  assert.equal(record.txHash, TX_HASH);
  assert.equal(record.vsId, 42);
  assert.equal(record.stakeAmount, 5);
});

test("positive: the signing address is normalized for stable matching", () => {
  const record = createChallengeRecoveryRecord({
    vsId: 7,
    txHash: TX_HASH,
    address: `  ${WALLET}  `,
    stakeAmount: 2,
    now: 5,
  });
  assert.equal(record.address, WALLET.toLowerCase());
  assert.equal(record.submittedAtMs, 5);
});

// ── applyChallengeStatusOutcome ───────────────────────────────────────────────

test("positive: a SUCCESS observation resolves the record as succeeded", () => {
  const next = applyChallengeStatusOutcome(makeRecord(), {
    succeeded: true,
    failed: false,
  });
  assert.equal(next.status, "succeeded");
  assert.equal(next.statusChecks, 1);
});

test("positive: a FAILED observation resolves the record as failed", () => {
  const next = applyChallengeStatusOutcome(makeRecord(), {
    succeeded: false,
    failed: true,
  });
  assert.equal(next.status, "failed");
  assert.equal(next.statusChecks, 1);
});

test("positive: an inconclusive check stays unknown and consumes budget", () => {
  let record = makeRecord();
  for (let i = 1; i <= 3; i++) {
    record = applyChallengeStatusOutcome(record, {
      succeeded: false,
      failed: false,
    });
    assert.equal(record.status, "unknown");
    assert.equal(record.statusChecks, i);
  }
});

test("boundary: a resolved record never regresses to unknown", () => {
  const succeeded = applyChallengeStatusOutcome(makeRecord(), {
    succeeded: true,
    failed: false,
  });
  const after = applyChallengeStatusOutcome(succeeded, {
    succeeded: false,
    failed: false,
  });
  assert.equal(after.status, "succeeded");
  assert.equal(after.statusChecks, 2);
});

// ── Budget ────────────────────────────────────────────────────────────────────

test("boundary: budget holds at max-1 checks and is gone at max", () => {
  assert.equal(
    hasChallengeStatusBudget(makeRecord({ statusChecks: CHALLENGE_RECOVERY_MAX_STATUS_CHECKS - 1 })),
    true,
  );
  assert.equal(
    hasChallengeStatusBudget(makeRecord({ statusChecks: CHALLENGE_RECOVERY_MAX_STATUS_CHECKS })),
    false,
  );
  assert.equal(
    hasChallengeStatusBudget(makeRecord({ statusChecks: CHALLENGE_RECOVERY_MAX_STATUS_CHECKS + 3 })),
    false,
  );
});

// ── Blocking gate ─────────────────────────────────────────────────────────────

test("positive: an unknown, unexpired record blocks a second stake", () => {
  const record = makeRecord();
  assert.equal(isChallengeRecoveryBlocking(record, 1_000_000), true);
});

test("negative: resolved records (succeeded / failed) do not block", () => {
  assert.equal(
    isChallengeRecoveryBlocking(makeRecord({ status: "succeeded" }), 1_000_000),
    false,
  );
  assert.equal(
    isChallengeRecoveryBlocking(makeRecord({ status: "failed" }), 1_000_000),
    false,
  );
});

test("negative: no record never blocks", () => {
  assert.equal(isChallengeRecoveryBlocking(null), false);
});

test("boundary: expiry at exactly MAX_AGE unblocks a stale unknown record", () => {
  const record = makeRecord();
  const expiry = record.submittedAtMs + CHALLENGE_RECOVERY_MAX_AGE_MS;
  assert.equal(isChallengeRecoveryBlocking(record, expiry - 1), true);
  assert.equal(isChallengeRecoveryExpired(record, expiry - 1), false);
  assert.equal(isChallengeRecoveryBlocking(record, expiry), false);
  assert.equal(isChallengeRecoveryExpired(record, expiry), true);
});

test("regression (fail closed): exhausting the check budget does NOT unblock", () => {
  const record = makeRecord({
    statusChecks: CHALLENGE_RECOVERY_MAX_STATUS_CHECKS,
  });
  assert.equal(isChallengeRecoveryBlocking(record, 1_000_000), true);
});

// ── txHash extraction from errors ─────────────────────────────────────────────

test("positive: hash is recovered from a StellarTransactionError", () => {
  const err = new StellarTransactionError("challenge_claim: unwrap failed", {
    txHash: TX_HASH,
    phase: "result",
  });
  assert.equal(challengeRecoveryTxHashFromError(err), TX_HASH);
});

test("positive: hash is recovered from a plain object carrying txHash", () => {
  assert.equal(challengeRecoveryTxHashFromError({ txHash: OTHER_HASH }), OTHER_HASH);
});

test("negative: a submit-phase error without a hash yields null (nothing to recover)", () => {
  const err = new StellarTransactionError("challenge_claim: wallet rejected", {
    phase: "submit",
  });
  assert.equal(challengeRecoveryTxHashFromError(err), null);
});

test("negative: malformed, short, or non-object values yield null", () => {
  assert.equal(challengeRecoveryTxHashFromError({ txHash: "0x123" }), null);
  assert.equal(challengeRecoveryTxHashFromError({ txHash: "z".repeat(64) }), null);
  assert.equal(challengeRecoveryTxHashFromError(new Error("boom")), null);
  assert.equal(challengeRecoveryTxHashFromError(null), null);
  assert.equal(challengeRecoveryTxHashFromError(undefined), null);
});

// ── Persistence ───────────────────────────────────────────────────────────────

test("positive: save/read round-trips a record for the same market+wallet", () => {
  withFakeStorage(null, () => {
    const record = makeRecord();
    saveChallengeRecoveryRecord(record);
    const read = readChallengeRecoveryRecord(42, WALLET);
    assert.ok(read);
    assert.deepEqual(read, { ...record, address: WALLET.toLowerCase() });
  });
});

test("negative: another wallet or another market does not see the record", () => {
  withFakeStorage(null, () => {
    saveChallengeRecoveryRecord(makeRecord());
    assert.equal(readChallengeRecoveryRecord(43, WALLET), null);
    assert.equal(readChallengeRecoveryRecord(42, "GOTHER".padEnd(56, "A")), null);
    assert.equal(readChallengeRecoveryRecord(42, null), null);
  });
});

test("boundary: saving a newer record for the same market+wallet replaces it", () => {
  withFakeStorage(null, () => {
    saveChallengeRecoveryRecord(makeRecord({ txHash: TX_HASH }));
    saveChallengeRecoveryRecord(makeRecord({ txHash: OTHER_HASH, statusChecks: 2 }));
    const read = readChallengeRecoveryRecord(42, WALLET);
    assert.ok(read);
    assert.equal(read.txHash, OTHER_HASH);
    assert.equal(read.statusChecks, 2);
  });
});

test("boundary: an expired record is dropped on read and stops blocking", () => {
  withFakeStorage(null, () => {
    const expired = makeRecord({
      submittedAtMs: Date.now() - CHALLENGE_RECOVERY_MAX_AGE_MS - 1,
    });
    saveChallengeRecoveryRecord(expired);
    assert.equal(readChallengeRecoveryRecord(42, WALLET), null);
    assert.equal(isChallengeRecoveryBlocking(expired), false);
  });
});

test("negative: corrupt storage JSON is discarded without throwing", () => {
  withFakeStorage({ proven_challenge_recovery: "{not json" }, () => {
    assert.equal(readChallengeRecoveryRecord(42, WALLET), null);
  });
});

test("negative: malformed entries are dropped, valid siblings survive", () => {
  const good = makeRecord();
  const payload = JSON.stringify([
    { vsId: 99, txHash: "nope" }, // bad shape
    { ...good, address: WALLET.toLowerCase() },
    null,
  ]);
  withFakeStorage({ proven_challenge_recovery: payload }, () => {
    const read = readChallengeRecoveryRecord(42, WALLET);
    assert.ok(read);
    assert.equal(read.txHash, TX_HASH);
    assert.equal(readChallengeRecoveryRecord(99, WALLET), null);
  });
});

test("positive: a resolved record is still returned so the panel can show the outcome", () => {
  withFakeStorage(null, () => {
    saveChallengeRecoveryRecord(makeRecord({ status: "succeeded", statusChecks: 1 }));
    const read = readChallengeRecoveryRecord(42, WALLET);
    assert.ok(read);
    assert.equal(read.status, "succeeded");
    assert.equal(isChallengeRecoveryBlocking(read), false);
  });
});

test("positive: clear removes only the matching market+wallet record", () => {
  withFakeStorage(null, () => {
    saveChallengeRecoveryRecord(makeRecord());
    saveChallengeRecoveryRecord(
      makeRecord({ vsId: 43, txHash: OTHER_HASH }),
    );
    clearChallengeRecoveryRecord(42, WALLET);
    assert.equal(readChallengeRecoveryRecord(42, WALLET), null);
    assert.ok(readChallengeRecoveryRecord(43, WALLET));
  });
});

test("negative: without a window (SSR) reads are null and writes never throw", () => {
  const hadWindow = "window" in globalThis;
  assert.equal(hadWindow, false, "node test env must not define window");
  assert.equal(readChallengeRecoveryRecord(42, WALLET), null);
  assert.doesNotThrow(() => saveChallengeRecoveryRecord(makeRecord()));
  assert.doesNotThrow(() => clearChallengeRecoveryRecord(42, WALLET));
});
