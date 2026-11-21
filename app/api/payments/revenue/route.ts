/**
 * GET /api/payments/revenue — live payment earnings across Mimir's paid
 * endpoints (premium price oracle, oracle-as-a-service, council reasoning).
 *
 * Powers the /revenue dashboard. Durable: reads the Neon payments_v2 ledger
 * (falls back to an in-memory buffer when no DB is configured). The x402
 * settlements on Stellar remain the ultimate record.
 */

import { getRevenueSummary } from "@/lib/paid-revenue";
import { authorizeRequest } from "@/lib/api/policy";

export const dynamic = "force-dynamic";

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawOffset = parseInt(url.searchParams.get("offset") || "0", 10);
  const rawLimit = parseInt(url.searchParams.get("limit") || "25", 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(rawOffset, 10_000) : 0;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 25;

  const auth = await authorizeRequest("public_read", {
    route: "/api/payments/revenue",
    ip: clientIp(req),
  });
  if (auth) {
    // Over-limit callers get the tier's 429 (including its rate-limit
    // headers) straight from the policy layer.
    return auth;
  }

  const summary = await getRevenueSummary(limit, offset);
  return new Response(JSON.stringify(summary), {
    headers: {
      "content-type": "application/json",
      // Served from the edge between refreshes: the dashboard polls this every few
      // seconds and every uncached hit was a function invocation running four
      // aggregates over payments_v2. 10s of staleness on a counter is invisible.
      "cache-control": "s-maxage=10, stale-while-revalidate=30",
    },
  });
}
