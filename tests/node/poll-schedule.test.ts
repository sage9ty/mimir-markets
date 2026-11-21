/**
 * tests/node/poll-schedule.test.ts
 *
 * Unit tests for the shared client poll-delay schedule (lib/poll-schedule.ts)
 * consumed by hooks/useVsDetail.ts. Coverage: positive, negative, boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { getNextPollDelay } from "../../lib/poll-schedule";
import { MAX_POLL_INTERVAL_MS } from "../../lib/pollingSchedule";

test("positive: no failures keeps the base interval", () => {
  assert.equal(getNextPollDelay(10_000, 0), 10_000);
});

test("positive: consecutive failures back off exponentially", () => {
  assert.equal(getNextPollDelay(10_000, 1), 20_000);
  assert.equal(getNextPollDelay(10_000, 2), 40_000);
});

test("boundary: backoff is clamped at MAX_POLL_INTERVAL_MS", () => {
  assert.equal(getNextPollDelay(10_000, 3), MAX_POLL_INTERVAL_MS);
  assert.equal(getNextPollDelay(10_000, 50), MAX_POLL_INTERVAL_MS);
  assert.equal(getNextPollDelay(10_000, Number.MAX_SAFE_INTEGER), MAX_POLL_INTERVAL_MS);
});

test("boundary: a base above the clamp never shrinks below itself", () => {
  assert.equal(getNextPollDelay(120_000, 0), 120_000);
  assert.equal(getNextPollDelay(120_000, 4), 120_000);
});

test("negative: negative or fractional failure counts are clamped to the base", () => {
  assert.equal(getNextPollDelay(10_000, -3), 10_000);
  assert.equal(getNextPollDelay(10_000, 0.7), 10_000);
  assert.equal(getNextPollDelay(10_000, NaN), 10_000);
});

test("negative: a non-positive base falls back to the max interval", () => {
  assert.equal(getNextPollDelay(0, 2), MAX_POLL_INTERVAL_MS);
  assert.equal(getNextPollDelay(-500, 2), MAX_POLL_INTERVAL_MS);
  assert.equal(getNextPollDelay(Infinity, 2), MAX_POLL_INTERVAL_MS);
});
