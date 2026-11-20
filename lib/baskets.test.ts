/**
 * Focused tests for #894 — duplicate basket members with conflicting weights.
 */
import { describe, expect, it } from "node:test";
import assert from "node:assert/strict";
import {
  BasketValidationError,
  basketMessage,
  canonicalizeMembers,
  validateBasketComposition,
} from "./baskets";

const baseArgs = {
  name: "Tech",
  creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  nonce: "00000000-0000-4000-8000-000000000000",
  expiresAt: 1_700_000_000_000,
};

describe("validateBasketComposition", () => {
  it("accepts distinct members", () => {
    validateBasketComposition([
      { agentId: "agent-a", weightBps: 5000 },
      { agentId: "agent-b", weightBps: 5000 },
    ]);
  });

  it("accepts identical-weight duplicates (collapses cleanly)", () => {
    validateBasketComposition([
      { agentId: "agent-a", weightBps: 5000 },
      { agentId: "agent-a", weightBps: 5000 },
    ]);
  });

  it("rejects conflicting-weight duplicates, naming the agentId", () => {
    assert.throws(
      () =>
        validateBasketComposition([
          { agentId: "agent-a", weightBps: 5000 },
          { agentId: "agent-a", weightBps: 6000 },
        ]),
      (err: unknown) => {
        assert.ok(err instanceof BasketValidationError);
        assert.equal(err.agentId, "agent-a");
        assert.match(err.message, /agent-a/);
        assert.match(err.message, /5000/);
        assert.match(err.message, /6000/);
        return true;
      },
    );
  });

  it("rejects empty agentId and non-positive weights", () => {
    assert.throws(
      () => validateBasketComposition([{ agentId: "", weightBps: 100 }]),
      BasketValidationError,
    );
    assert.throws(
      () => validateBasketComposition([{ agentId: "a", weightBps: 0 }]),
      BasketValidationError,
    );
  });
});

describe("canonicalizeMembers", () => {
  it("produces deterministic order regardless of input order", () => {
    const a = canonicalizeMembers([
      { agentId: "agent-b", weightBps: 3000 },
      { agentId: "agent-a", weightBps: 7000 },
    ]);
    const b = canonicalizeMembers([
      { agentId: "agent-a", weightBps: 7000 },
      { agentId: "agent-b", weightBps: 3000 },
    ]);
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((m) => m.agentId), ["agent-a", "agent-b"]);
  });

  it("collapses identical-weight duplicates", () => {
    const out = canonicalizeMembers([
      { agentId: "agent-a", weightBps: 5000 },
      { agentId: "agent-a", weightBps: 5000 },
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { agentId: "agent-a", weightBps: 5000 });
  });
});

describe("basketMessage — validation before serialization", () => {
  it("rejects a contradictory composition", () => {
    assert.throws(
      () =>
        basketMessage({
          ...baseArgs,
          members: [
            { agentId: "agent-a", weightBps: 5000 },
            { agentId: "agent-a", weightBps: 6000 },
          ],
        }),
      BasketValidationError,
    );
  });

  it("is byte-identical across input orderings", () => {
    const msgA = basketMessage({
      ...baseArgs,
      members: [
        { agentId: "agent-b", weightBps: 3000 },
        { agentId: "agent-a", weightBps: 7000 },
      ],
    });
    const msgB = basketMessage({
      ...baseArgs,
      members: [
        { agentId: "agent-a", weightBps: 7000 },
        { agentId: "agent-b", weightBps: 3000 },
      ],
    });
    assert.equal(msgA, msgB);
  });

  it("still produces a valid message for a clean basket", () => {
    const msg = basketMessage({
      ...baseArgs,
      members: [{ agentId: "agent-a", weightBps: 10000 }],
    });
    assert.match(msg, /^Mimir basket\n/);
    assert.match(msg, /members: agent-a:10000/);
  });
});
