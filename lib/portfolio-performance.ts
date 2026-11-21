import type { PnlPoint } from "@/lib/agents/performance";
import type { VSCacheFreshness } from "@/lib/vs-freshness";

export interface PortfolioPerformanceResponse {
  points: PnlPoint[];
  settled: number;
  cache: VSCacheFreshness;
}

function isCacheFreshness(value: unknown): value is VSCacheFreshness {
  if (!value || typeof value !== "object") return false;
  const cache = value as Record<string, unknown>;
  return (
    (cache.source === "index" || cache.source === "contract") &&
    (cache.status === "live" || cache.status === "cached" || cache.status === "stale") &&
    (cache.lastUpdatedAt === null || typeof cache.lastUpdatedAt === "string") &&
    (cache.ageMs === null ||
      (typeof cache.ageMs === "number" && Number.isFinite(cache.ageMs) && cache.ageMs >= 0)) &&
    typeof cache.freshnessWindowMs === "number" &&
    Number.isFinite(cache.freshnessWindowMs) &&
    cache.freshnessWindowMs > 0
  );
}

/**
 * Browser boundary guard for the portfolio performance endpoint.
 *
 * A malformed monetary point must fail closed rather than become an SVG NaN or
 * look like a legitimate zero. The server still performs all accounting in
 * atomic USDC; only the display series crosses this boundary as canonical
 * numeric floats.
 *
 * Invariant:
 * Localized display strings are strictly presentation-only and must never be
 * accepted as performance inputs or parsed back into money arithmetic. Canonical
 * numeric values are preserved across locale switches.
 */
export function isPortfolioPerformanceResponse(
  value: unknown,
): value is PortfolioPerformanceResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  if (
    typeof response.settled !== "number" ||
    !Number.isInteger(response.settled) ||
    response.settled < 0
  ) return false;
  if (!Array.isArray(response.points) || !isCacheFreshness(response.cache)) return false;

  return response.points.every((point) => {
    if (!point || typeof point !== "object") return false;
    const item = point as Record<string, unknown>;
    return (
      typeof item.timestamp === "number" &&
      Number.isFinite(item.timestamp) &&
      item.timestamp > 0 &&
      typeof item.value === "number" &&
      Number.isFinite(item.value)
    );
  });
}
