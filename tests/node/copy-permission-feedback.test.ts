import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCopyPermissionFeedback,
  type CopyPermissionFeedbackInput,
  type CopyPermissionFeedbackView,
} from "../../lib/copy-permission-feedback";
import {
  copyPolicyHash,
  type CopyPermission,
} from "../../lib/copy-trading";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const MIMIR = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const OWNER = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const OTHER_WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const NOW = 1_800_000_000_000;
const UNIT = 10_000_000n; // 1 USDC at 7 decimals

function makePermission(overrides: Partial<CopyPermission> = {}): CopyPermission {
  const base: Omit<CopyPermission, "signedPolicyHash"> = {
    permissionId: "perm-copy-test-1",
    ownerWallet: OWNER,
    executionAgentId: "agent-exec",
    signalAgentId: "agent-signal",
    maxPerPositionUsdc: 5,
    dailyCapUsdc: 20,
    weeklyCapUsdc: 100,
    totalOpenExposureUsdc: 50,
    maxRealizedLossAtomic: "100000000", // 10 USDC
    allowedCategories: ["crypto", "macro"],
    allowedModes: ["pool", "direct"],
    minConfidenceBps: 7000,
    minPayoutBps: 12000,
    expiresAt: NOW + 86_400_000,
    depth: 1,
    status: "active",
    spendPermission: {
      token: USDC,
      spender: MIMIR,
      allowanceAtomic: 100n * UNIT,
      periodSeconds: 86400,
    },
    ...overrides,
  };
  return { ...base, signedPolicyHash: copyPolicyHash(base) };
}

test("positive: valid active permission with on-chain allowance builds ready feedback", () => {
  const p = makePermission();
  const feedback = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 100n * UNIT,
    onchainBalanceAtomic: 200n * UNIT,
    spentInPeriodAtomic: 10n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });

  assert.equal(feedback.status, "ready");
  assert.equal(feedback.statusMessageKey, "ready");
  assert.equal(feedback.hasSufficientAllowance, true);
  assert.equal(feedback.hasSufficientBalance, true);
  assert.equal(feedback.isTokenConfigured, true);
  assert.equal(feedback.isSpenderConfigured, true);
  assert.equal(feedback.isExpired, false);
  assert.equal(feedback.isRevoked, false);
  assert.equal(feedback.isPaused, false);
  assert.equal(feedback.isStale, false);
  assert.equal(feedback.maxPerPositionAtomic, (5n * UNIT).toString());
  assert.equal(feedback.dailyCapAtomic, (20n * UNIT).toString());
  assert.equal(feedback.signedAllowanceAtomic, (100n * UNIT).toString());
  assert.equal(feedback.onchainAllowanceAtomic, (100n * UNIT).toString());
  assert.equal(feedback.remainingAllowanceAtomic, (90n * UNIT).toString());
});

test("loading state: reports loading when loading flag set or permission undefined", () => {
  const loading1 = buildCopyPermissionFeedback({ loading: true });
  assert.equal(loading1.status, "loading");
  assert.equal(loading1.permissionId, null);

  const loading2 = buildCopyPermissionFeedback({ permission: undefined });
  assert.equal(loading2.status, "loading");
});

test("disconnected state: reports disconnected when flag set or wallet address mismatches", () => {
  const p = makePermission();

  const disc1 = buildCopyPermissionFeedback({ permission: p, disconnected: true });
  assert.equal(disc1.status, "disconnected");

  const disc2 = buildCopyPermissionFeedback({ permission: p, connectedWallet: OTHER_WALLET, now: NOW });
  assert.equal(disc2.status, "disconnected");
  assert.match(disc2.detail, /does not match/i);
});

test("invalid state: reports invalid when token, spender, or budget bounds fail", () => {
  const p = makePermission();

  // Wrong token
  const wrongToken = buildCopyPermissionFeedback({
    permission: p,
    configuredUsdc: "CAAAAAAAAAAAAAAANOTUSDC",
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(wrongToken.status, "invalid");
  assert.equal(wrongToken.isTokenConfigured, false);

  // Wrong spender
  const wrongSpender = buildCopyPermissionFeedback({
    permission: p,
    configuredUsdc: USDC,
    configuredSpender: "CDDDDDDDDDDDDDNOTMIMIR",
    now: NOW,
  });
  assert.equal(wrongSpender.status, "invalid");
  assert.equal(wrongSpender.isSpenderConfigured, false);

  // Not found (null permission)
  const notFound = buildCopyPermissionFeedback({ permission: null });
  assert.equal(notFound.status, "invalid");
});

test("contract feedback: detects insufficient on-chain allowance and insufficient balance", () => {
  const p = makePermission({ maxPerPositionUsdc: 10 }); // 10 USDC cap = 100_000_000 atomic

  // Zero allowance on chain
  const zeroAllowance = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 0n,
    onchainBalanceAtomic: 100n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(zeroAllowance.status, "invalid");
  assert.equal(zeroAllowance.hasSufficientAllowance, false);
  assert.match(zeroAllowance.detail, /zero|exhausted/i);

  // Partial allowance below per-position cap (9 USDC < 10 USDC cap)
  const partialAllowance = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 9n * UNIT,
    onchainBalanceAtomic: 100n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(partialAllowance.status, "invalid");
  assert.equal(partialAllowance.hasSufficientAllowance, false);
  assert.match(partialAllowance.detail, /less than the per-position stake cap/i);

  // Sufficient allowance but insufficient balance
  const lowBalance = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 50n * UNIT,
    onchainBalanceAtomic: 2n * UNIT, // only 2 USDC balance
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(lowBalance.status, "ready");
  assert.equal(lowBalance.hasSufficientAllowance, true);
  assert.equal(lowBalance.hasSufficientBalance, false);
  assert.match(lowBalance.detail, /balance is below/i);
});

test("lifecycle states: revoked, paused, and expired take precedence", () => {
  const p = makePermission();

  // Revoked
  const revoked = buildCopyPermissionFeedback({
    permission: { ...p, status: "revoked" },
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 50n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.isRevoked, true);

  // Paused (permission status)
  const pausedPerm = buildCopyPermissionFeedback({
    permission: { ...p, status: "paused" },
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 50n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(pausedPerm.status, "paused");
  assert.equal(pausedPerm.isPaused, true);

  // Paused (global pause)
  const pausedGlobal = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    globalPaused: true,
    onchainAllowanceAtomic: 50n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(pausedGlobal.status, "paused");
  assert.equal(pausedGlobal.isPaused, true);

  // Expired
  const expired = buildCopyPermissionFeedback({
    permission: { ...p, expiresAt: NOW },
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 50n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(expired.status, "expired");
  assert.equal(expired.isExpired, true);
});

test("stale and dependency failure states", () => {
  const p = makePermission();

  // Dependency failure: RPC read failed (onchainAllowanceAtomic === null)
  const depFail1 = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    onchainAllowanceAtomic: null,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(depFail1.status, "dependency_failure");

  // Explicit dependencyFailure flag
  const depFail2 = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    dependencyFailure: true,
    onchainAllowanceAtomic: 50n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(depFail2.status, "dependency_failure");

  // Stale cache: TTL exceeded
  const stale1 = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 50n * UNIT,
    freshness: { timestamp: NOW - 60_000, ttlMs: 30_000 },
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(stale1.status, "stale");
  assert.equal(stale1.isStale, true);

  // Stale cache: isStale explicit flag
  const stale2 = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 50n * UNIT,
    freshness: { timestamp: NOW, isStale: true },
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(stale2.status, "stale");
  assert.equal(stale2.isStale, true);
});

test("boundary: exact allowance equality and case-sensitive address verification", () => {
  const p = makePermission({ maxPerPositionUsdc: 5 }); // 50_000_000 atomic

  // Exact equality
  const exact = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 5n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(exact.status, "ready");
  assert.equal(exact.hasSufficientAllowance, true);

  // Address fidelity: lowercased address does NOT match (base32 is case-sensitive)
  const lowerOwner = OWNER.toLowerCase();
  const lowercasedMatch = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: lowerOwner,
    onchainAllowanceAtomic: 5n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(lowercasedMatch.status, "disconnected");
});

test("principal-at-risk is exposed separately from realized loss in feedback view", () => {
  const p = makePermission();

  // When principalAtRiskAtomic is supplied, it appears in the view.
  const withOpenPrincipal = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 100n * UNIT,
    onchainBalanceAtomic: 200n * UNIT,
    principalAtRiskAtomic: 7n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(withOpenPrincipal.status, "ready");
  assert.equal(withOpenPrincipal.principalAtRiskAtomic, (7n * UNIT).toString());
  // maxRealizedLossAtomic comes from the permission record, not a stale display-unit field.
  assert.equal(withOpenPrincipal.maxRealizedLossAtomic, p.maxRealizedLossAtomic);

  // When principalAtRiskAtomic is omitted, the field is null — not fabricated.
  const withoutOpenPrincipal = buildCopyPermissionFeedback({
    permission: p,
    connectedWallet: OWNER,
    onchainAllowanceAtomic: 100n * UNIT,
    configuredUsdc: USDC,
    configuredSpender: MIMIR,
    now: NOW,
  });
  assert.equal(withoutOpenPrincipal.principalAtRiskAtomic, null);
  // signedAllowanceAtomic is set from the actual spendPermission allowance.
  assert.equal(withoutOpenPrincipal.signedAllowanceAtomic, (100n * UNIT).toString());
});
