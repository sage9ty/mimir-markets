import assert from "node:assert/strict";
import test from "node:test";

import {
  computeMirrorAmountAtomic,
  formatMirrorAtomicUsdc,
  toUsdcAtomic,
} from "../../lib/baskets";
import {
  pendingMirrorsFor,
  type MirrorQueueDependencies,
} from "../../lib/server/mirror-queue";

const SUBSCRIBER = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const MEMBER_ADDRESS = "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D";
const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 3600;
const PAST_DEADLINE = Math.floor(Date.now() / 1000) - 60;

function makeDeps(opts: {
  subscriptions?: string[];
  definitions?: Array<{
    id: string;
    name: string;
    members: Array<{ agentId: string; weightBps: number }>;
  }>;
  agents?: Array<{ id: string; displayName: string; address: string }>;
  claims?: Array<{
    id: number;
    question?: string | null;
    deadline: number;
    creator?: string | null;
  }>;
  challengers?: Record<
    number,
    Array<{ address: string; stake: number; stakeAtomic?: string | bigint }>
  >;
}): MirrorQueueDependencies {
  return {
    listSubscriptions: async () => opts.subscriptions ?? [],
    listDefinitions: async () => opts.definitions ?? [],
    listAgents: async () => opts.agents ?? [],
    listOpenClaims: async () => opts.claims ?? [],
    listChallengers: async (claimId) => opts.challengers?.[claimId] ?? [],
  };
}

const AGENT = { id: "a1", displayName: "Agent One", address: MEMBER_ADDRESS };

test("computeMirrorAmountAtomic preserves exact 7-decimal atomic precision", () => {
  // 2 USDC (20_000_000 atomic) * 3333 / 10_000 = 6_666_000 atomic (0.6666 USDC),
  // whereas lossy cent rounding produced 0.67 USDC.
  assert.equal(computeMirrorAmountAtomic(2, 3333), 6_666_000n);
  // Sub-cent weighted stake (1 USDC * 33 bps = 0.0033 USDC = 33_000 atomic) is preserved.
  assert.equal(computeMirrorAmountAtomic(1, 33), 33_000n);
  // Exact 100% weight preserves the full atomic budget.
  assert.equal(computeMirrorAmountAtomic(25, 10_000), 250_000_000n);
  // Supports bigint atomic input directly.
  assert.equal(computeMirrorAmountAtomic(20_000_000n, 3333), 6_666_000n);
});

test("computeMirrorAmountAtomic returns 0n for invalid or non-positive inputs", () => {
  assert.equal(computeMirrorAmountAtomic(2, 0), 0n);
  assert.equal(computeMirrorAmountAtomic(2, -1), 0n);
  assert.equal(computeMirrorAmountAtomic(2, 10_001), 0n);
  assert.equal(computeMirrorAmountAtomic(2, 33.5), 0n);
  assert.equal(computeMirrorAmountAtomic(0, 5_000), 0n);
  assert.equal(computeMirrorAmountAtomic(-5, 5_000), 0n);
  assert.equal(computeMirrorAmountAtomic(Number.NaN, 5_000), 0n);
  assert.equal(computeMirrorAmountAtomic(Number.POSITIVE_INFINITY, 5_000), 0n);
});

test("formatMirrorAtomicUsdc formats atomic strings at the display boundary", () => {
  assert.equal(formatMirrorAtomicUsdc("6666000"), "0.6666");
  assert.equal(formatMirrorAtomicUsdc("6666000", 2), "0.66");
  assert.equal(formatMirrorAtomicUsdc("100000000", 2), "10.00");
  assert.equal(formatMirrorAtomicUsdc("33000"), "0.0033");
  assert.equal(formatMirrorAtomicUsdc(0n, 2), "0.00");
});

test("toUsdcAtomic normalizes numbers and rejects invalid values", () => {
  assert.equal(toUsdcAtomic(0.1 + 0.2), 3_000_000n);
  assert.equal(toUsdcAtomic("12.3456789"), 123_456_789n);
  assert.throws(() => toUsdcAtomic(-1));
  assert.throws(() => toUsdcAtomic("1.12345678"));
});

test("pendingMirrorsFor returns exact atomic string amounts without lossy float fields", async () => {
  const deps = makeDeps({
    subscriptions: ["b"],
    definitions: [
      {
        id: "b",
        name: "Basket",
        members: [{ agentId: "a1", weightBps: 3333 }],
      },
    ],
    agents: [AGENT],
    claims: [
      { id: 1, question: "Q1", deadline: FUTURE_DEADLINE },
      { id: 2, question: "Q2", deadline: FUTURE_DEADLINE + 600 },
    ],
    challengers: {
      1: [{ address: MEMBER_ADDRESS, stake: 10.1234567 }],
      2: [{ address: MEMBER_ADDRESS, stake: 25, stakeAtomic: "250000001" }],
    },
  });

  const result = await pendingMirrorsFor(SUBSCRIBER, { b: 2 }, deps);
  assert.equal(result.length, 2);

  assert.equal(result[0].claimId, 1);
  assert.equal(result[0].memberStakeAtomic, "101234567");
  assert.equal(result[0].mirrorAmountAtomic, "6666000");
  assert.equal("memberStakeUsdc" in result[0], false);
  assert.equal("mirrorUsdc" in result[0], false);

  assert.equal(result[1].claimId, 2);
  assert.equal(result[1].memberStakeAtomic, "250000001");
  assert.equal(result[1].mirrorAmountAtomic, "6666000");
});

test("pendingMirrorsFor skips invalid weights, expired claims, and already-mirrored positions", async () => {
  const deps = makeDeps({
    subscriptions: ["b-valid", "b-zero"],
    definitions: [
      { id: "b-valid", name: "Valid", members: [{ agentId: "a1", weightBps: 33 }] },
      { id: "b-zero", name: "Zero", members: [{ agentId: "a1", weightBps: 0 }] },
    ],
    agents: [AGENT],
    claims: [
      { id: 1, deadline: PAST_DEADLINE },
      { id: 2, deadline: FUTURE_DEADLINE },
      { id: 3, deadline: FUTURE_DEADLINE + 600 },
    ],
    challengers: {
      1: [{ address: MEMBER_ADDRESS, stake: 10 }],
      2: [
        { address: MEMBER_ADDRESS, stake: 10 },
        { address: SUBSCRIBER, stake: 2 },
      ],
      3: [{ address: MEMBER_ADDRESS, stake: 10 }],
    },
  });

  const result = await pendingMirrorsFor(SUBSCRIBER, { "b-valid": 1, "b-zero": 10 }, deps);
  assert.equal(result.length, 1);
  assert.equal(result[0].claimId, 3);
  assert.equal(result[0].mirrorAmountAtomic, "33000");
  assert.equal(result[0].memberStakeAtomic, "100000000");
});

test("pendingMirrorsFor returns an empty list for invalid subscriber or no subscriptions", async () => {
  const deps = makeDeps({
    subscriptions: [],
    definitions: [{ id: "b", name: "Basket", members: [{ agentId: "a1", weightBps: 10_000 }] }],
    agents: [AGENT],
    claims: [{ id: 1, deadline: FUTURE_DEADLINE }],
    challengers: { 1: [{ address: MEMBER_ADDRESS, stake: 10 }] },
  });

  assert.deepEqual(await pendingMirrorsFor("not-a-strkey", {}, deps), []);
  assert.deepEqual(await pendingMirrorsFor(SUBSCRIBER, {}, deps), []);
});
