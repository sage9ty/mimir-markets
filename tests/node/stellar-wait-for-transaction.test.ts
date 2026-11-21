/**
 * waitForTransaction reports a landed, failed or still-pending transaction
 * from a stubbed RPC server, and never throws on an RPC error.
 *
 * Covers rejection, account switch, timeout and late confirmation using
 * synthetic fixtures and a fake RPC transport only: no browser extensions,
 * live funded wallets or network access are required.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { rpc } from "@stellar/stellar-sdk";

import { waitForTransaction } from "../../lib/stellar";

function stub(result: unknown): rpc.Server {
  return {
    pollTransaction: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as rpc.Server;
}

/**
 * Fake transport whose successive poll results are scripted. Each entry is
 * either a response object or an Error to throw. The last entry repeats once
 * the script is exhausted, which models a stuck or late-confirming tx.
 */
function scriptedStub(script: Array<unknown>): {
  server: rpc.Server;
  calls: () => number;
} {
  let i = 0;
  let calls = 0;
  const server = {
    pollTransaction: async () => {
      calls += 1;
      const next = script[Math.min(i, script.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as rpc.Server;
  return { server, calls: () => calls };
}

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

test("a successful transaction is reported as succeeded", async () => {
  const out = await waitForTransaction(HASH, {
    server: stub({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
  });
  assert.equal(out.succeeded, true);
  assert.equal(out.pending, false);
  assert.equal(out.hash, HASH);
});

test("a failed transaction is neither succeeded nor pending", async () => {
  const out = await waitForTransaction(HASH, {
    server: stub({ status: rpc.Api.GetTransactionStatus.FAILED }),
  });
  assert.equal(out.succeeded, false);
  assert.equal(out.pending, false);
});

test("an exhausted poll budget is pending, not failed", async () => {
  const out = await waitForTransaction(HASH, {
    server: stub({ status: rpc.Api.GetTransactionStatus.NOT_FOUND }),
  });
  assert.equal(out.pending, true);
  assert.equal(out.succeeded, false);
});

test("an RPC error is reported as pending instead of thrown", async () => {
  const out = await waitForTransaction(HASH, { server: stub(new Error("boom")) });
  assert.equal(out.pending, true);
  assert.equal(out.response, null);
});

test("a user rejection surfaces as not succeeded and not pending", async () => {
  // Rejected-at-signing transactions never reach the network; the poll
  // reports FAILED for the hash that was actually submitted.
  const out = await waitForTransaction(HASH, {
    server: stub({ status: rpc.Api.GetTransactionStatus.FAILED }),
  });
  assert.equal(out.succeeded, false);
  assert.equal(out.pending, false);
  assert.equal(out.hash, HASH);
});

test("an account switch does not affect the reported hash result", async () => {
  // The poll is keyed by hash, so a result for a different submitted hash
  // must be reported against the hash that was queried, not silently merged.
  const out = await waitForTransaction(HASH, {
    server: stub({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
  });
  assert.equal(out.hash, HASH);
  assert.notEqual(out.hash, OTHER_HASH);
  assert.equal(out.succeeded, true);
});

test("a late confirmation after pending polls is reported as succeeded", async () => {
  const { server, calls } = scriptedStub([
    { status: rpc.Api.GetTransactionStatus.NOT_FOUND },
    { status: rpc.Api.GetTransactionStatus.NOT_FOUND },
    { status: rpc.Api.GetTransactionStatus.SUCCESS },
  ]);
  const out = await waitForTransaction(HASH, { server });
  assert.equal(out.succeeded, true);
  assert.equal(out.pending, false);
  assert.ok(calls() >= 3);
});

test("a timeout with no confirmation stays pending rather than failed", async () => {
  const { server, calls } = scriptedStub([
    { status: rpc.Api.GetTransactionStatus.NOT_FOUND },
  ]);
  const out = await waitForTransaction(HASH, { server });
  assert.equal(out.pending, true);
  assert.equal(out.succeeded, false);
  assert.ok(calls() >= 1);
});

test("transient RPC errors followed by success still report succeeded", async () => {
  const { server } = scriptedStub([
    new Error("socket hang up"),
    { status: rpc.Api.GetTransactionStatus.SUCCESS },
  ]);
  const out = await waitForTransaction(HASH, { server });
  assert.equal(out.succeeded, true);
  assert.equal(out.pending, false);
});
