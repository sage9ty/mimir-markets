/**
 * Poll-delay schedule shared by client polling loops.
 *
 * Pure and framework-free: given a base interval and the number of consecutive
 * failures, it returns the delay before the next attempt. Failures back off
 * exponentially but are clamped so a degraded dependency can never turn into a
 * retry storm, and a recovered loop always returns to the base interval.
 */

import { MAX_POLL_INTERVAL_MS } from "./pollingSchedule";

/**
 * Delay before the next poll attempt.
 *
 * `consecutiveFailures = 0` returns the base interval unchanged; each failure
 * doubles the delay up to {@link MAX_POLL_INTERVAL_MS}. The result never drops
 * below the base interval, so callers with a slow cadence keep it.
 */
export function getNextPollDelay(
  baseIntervalMs: number,
  consecutiveFailures: number,
): number {
  if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) {
    return MAX_POLL_INTERVAL_MS;
  }
  const failures = Number.isFinite(consecutiveFailures)
    ? Math.max(0, Math.trunc(consecutiveFailures))
    : 0;
  // Cap the exponent: beyond ~10 doublings the value is clamped anyway, and
  // huge exponents would overflow to Infinity before the clamp.
  const backoff = baseIntervalMs * Math.pow(2, Math.min(failures, 10));
  return Math.max(baseIntervalMs, Math.min(backoff, MAX_POLL_INTERVAL_MS));
}
