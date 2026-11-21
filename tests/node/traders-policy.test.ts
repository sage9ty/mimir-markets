/**
 * tests/node/traders-policy.test.ts
 *
 * Unit tests for pure trader policy predicates in agents/traders/policy.ts:
 * 1. shouldBuySecondOpinion predicate (BUY_SECOND_OPINION, MIMIR_URL, DRY_RUN, claim fields)
 *    ensuring TRADER_DRY_RUN=1 spends nothing.
 * 2. filterJoinableClaims filtering logic.
 * 3. computeStakeSizing atomic rounding, remainder and policy metadata.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  computeStakeSizing,
  filterJoinableClaims,
  shouldBuySecondOpinion,
  STAKE_ROUNDING_POLICY,
  type JoinableClaimCandidate,
  type SecondOpinionClaimFields,
} from "../../agents/traders/policy";

const VALID_CLAIM: SecondOpinionClaimFields = {
  question: "Will Stellar exceed 100k daily operations?",
  creator_position: "Yes",
  counter_position: "No",
  resolution_url: "https://stellar.expert/explorer/public",
  settlement_rule: "Based on StellarExpert ledger data.",
};

const TRADER_WALLET = "GDYJ7GZ4WDGYFE6R3HFBUK2GYMFIFP3JHFYSYAME6XISG5BEKZDJVGHN";
const OTHER_WALLET = "GB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E";

test("shouldBuySecondOpinion: returns true when all conditions are satisfied in non-dry-run mode", () => {
  const result = shouldBuySecondOpinion({
    buySecondOpinion: true,
    mimirUrl: "https://mimir.example.com",
    dryRun: false,
    claim: VALID_CLAIM,
  });
  assert.equal(result, true);
});

test("shouldBuySecondOpinion: returns false when dryRun is true (never spends in dry-run)", () => {
  const result = shouldBuySecondOpinion({
    buySecondOpinion: true,
    mimirUrl: "https://mimir.example.com",
    dryRun: true,
    claim: VALID_CLAIM,
  });
  assert.equal(result, false);
});

test("shouldBuySecondOpinion: returns false when buySecondOpinion is false", () => {
  const result = shouldBuySecondOpinion({
    buySecondOpinion: false,
    mimirUrl: "https://mimir.example.com",
    dryRun: false,
    claim: VALID_CLAIM,
  });
  assert.equal(result, false);
});

test("shouldBuySecondOpinion: returns false when mimirUrl is unset or empty", () => {
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "",
      dryRun: false,
      claim: VALID_CLAIM,
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "   ",
      dryRun: false,
      claim: VALID_CLAIM,
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: null,
      dryRun: false,
      claim: VALID_CLAIM,
    }),
    false,
  );
});

test("shouldBuySecondOpinion: returns false when claim or required claim fields are missing", () => {
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: null,
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: { ...VALID_CLAIM, question: null },
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: { ...VALID_CLAIM, question: "" },
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: { ...VALID_CLAIM, resolution_url: null },
    }),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion({
      buySecondOpinion: true,
      mimirUrl: "https://mimir.example.com",
      dryRun: false,
      claim: { ...VALID_CLAIM, resolution_url: "  " },
    }),
    false,
  );
});

test("shouldBuySecondOpinion: supports positional argument signature", () => {
  assert.equal(
    shouldBuySecondOpinion(true, "https://mimir.example.com", false, VALID_CLAIM),
    true,
  );
  assert.equal(
    shouldBuySecondOpinion(true, "https://mimir.example.com", true, VALID_CLAIM),
    false,
  );
  assert.equal(
    shouldBuySecondOpinion(false, "https://mimir.example.com", false, VALID_CLAIM),
    false,
  );
});

test("filterJoinableClaims: filters out claims too close to deadline (<= 300s)", () => {
  const now = 1_000_000;
  const claims: JoinableClaimCandidate[] = [
    { id: 1, deadline: now + 300, creator: OTHER_WALLET, visibility: "public" },
    { id: 2, deadline: now + 299, creator: OTHER_WALLET, visibility: "public" },
    { id: 3, deadline: now + 301, creator: OTHER_WALLET, visibility: "public" },
  ];
  const challengers = new Map<number, { address: string }[]>();

  const filtered = filterJoinableClaims(claims, challengers, TRADER_WALLET, now);
  assert.deepEqual(filtered.map((c) => c.id), [3]);
});

test("filterJoinableClaims: filters out claims created by the trader", () => {
  const now = 1_000_000;
  const claims: JoinableClaimCandidate[] = [
    { id: 1, deadline: now + 1000, creator: TRADER_WALLET, visibility: "public" },
    { id: 2, deadline: now + 1000, creator: OTHER_WALLET, visibility: "public" },
  ];
  const challengers = new Map<number, { address: string }[]>();

  const filtered = filterJoinableClaims(claims, challengers, TRADER_WALLET, now);
  assert.deepEqual(filtered.map((c) => c.id), [2]);
});

test("filterJoinableClaims: filters out non-public claims", () => {
  const now = 1_000_000;
  const claims: JoinableClaimCandidate[] = [
    { id: 1, deadline: now + 1000, creator: OTHER_WALLET, visibility: "private" },
    { id: 2, deadline: now + 1000, creator: OTHER_WALLET, visibility: "public" },
  ];
  const challengers = new Map<number, { address: string }[]>();

  const filtered = filterJoinableClaims(claims, challengers, TRADER_WALLET, now);
  assert.deepEqual(filtered.map((c) => c.id), [2]);
});

test("filterJoinableClaims: filters out claims already challenged by this trader", () => {
  const now = 1_000_000;
  const claims: JoinableClaimCandidate[] = [
    { id: 1, deadline: now + 1000, creator: OTHER_WALLET, visibility: "public" },
    { id: 2, deadline: now + 1000, creator: OTHER_WALLET, visibility: "public" },
  ];
  const challengers = new Map<number, { address: string }[]>([
    [1, [{ address: TRADER_WALLET }]],
    [2, [{ address: "SOME_OTHER_CHALLENGER" }]],
  ]);

  const filtered = filterJoinableClaims(claims, challengers, TRADER_WALLET, now);
  assert.deepEqual(filtered.map((c) => c.id), [2]);
});

test("computeStakeSizing: returns integer atomic stake and remainder", () => {
  // 1000.0000000 USDC budget = 10_000_000_000 atomic; 25% stake
  const result = computeStakeSizing(10_000_000_000n, 2500);
  assert.equal(result.stakeAtomic, 2_500_000_000n);
  assert.equal(result.remainderAtomic, 7_500_000_000n);
  assert.equal(result.stakeAtomic + result.remainderAtomic, 10_000_000_000n);
});

test("computeStakeSizing: floors fractional atomic units (remainder absorbs the dust)", () => {
  // 1 atomic unit at 33.33% floors to 0 stake; the whole unit remains.
  const result = computeStakeSizing(1n, 3333);
  assert.equal(result.stakeAtomic, 0n);
  assert.equal(result.remainderAtomic, 1n);

  // 10 atomic units at 33.33%: 10 * 3333 / 10000 = 3.333 -> 3 stake, 7 remainder
  const odd = computeStakeSizing(10n, 3333);
  assert.equal(odd.stakeAtomic, 3n);
  assert.equal(odd.remainderAtomic, 7n);
});

test("computeStakeSizing: records policy version and rounding in output", () => {
  const result = computeStakeSizing(100n, 5000);
  assert.equal(result.policyVersion, STAKE_ROUNDING_POLICY.policyVersion);
  assert.equal(result.rounding, "floor");
});

test("computeStakeSizing: boundary fractions 0 and 10000", () => {
  const none = computeStakeSizing(500n, 0);
  assert.equal(none.stakeAtomic, 0n);
  assert.equal(none.remainderAtomic, 500n);

  const all = computeStakeSizing(500n, 10000);
  assert.equal(all.stakeAtomic, 500n);
  assert.equal(all.remainderAtomic, 0n);
});

test("computeStakeSizing: rejects invalid inputs", () => {
  assert.throws(() => computeStakeSizing(-1n, 100));
  assert.throws(() => computeStakeSizing(100n, -1));
  assert.throws(() => computeStakeSizing(100n, 10001));
  assert.throws(() => computeStakeSizing(100n, 1.5));
});
