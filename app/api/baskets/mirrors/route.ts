/**
 * GET /api/baskets/mirrors?subscriber=G… — positions a follower has not copied yet.
 *
 * Read-only and unauthenticated: it reports what is already public (open markets
 * and who staked on them) filtered by a subscription the caller names. Nothing
 * here can move funds, and requiring a signature to read your own queue would buy
 * privacy that the chain does not offer anyway.
 *
 * Monetary fields (`memberStakeAtomic`, `mirrorAmountAtomic`) are returned as
 * exact 7-decimal atomic USDC base-10 integer strings; consumers apply display
 * formatting at the UI boundary.
 */

import { NextResponse, type NextRequest } from "next/server";

import { apiError } from "@/lib/api/errors";
import { clientIpFrom } from "@/lib/api/origin";
import { authorizeRequest } from "@/lib/api/policy";
import { listBasketSubscriptions } from "@/lib/db";
import { pendingMirrorsFor } from "@/lib/server/mirror-queue";
import { parseAddressParam } from "@/lib/server/api-validation";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rawSubscriber = req.nextUrl.searchParams.get("subscriber") ?? "";
  const ip = clientIpFrom(req.headers);
  const gate = await authorizeRequest("public_read", { route: "/api/baskets/mirrors", ip });
  if (!gate.allowed && gate.error) {
    return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
  }

  // Stellar str111, checked with StrKey and used verbatim. The
  // `/^0x[0-9a-fA-F]{40}$/` this used to carry did not just skip normalisation —
  // it rejected every real Stellar address, so this endpoint 400'd for all callers.
  const subscriber = parseAddressParam(rawSubscriber);
  if (!subscriber) {
    const err = apiError("invalid_request", "subscriber must be a Stellar address");
    return NextResponse.json(err.body, { status: err.status });
  }

  const [mirrors, subscriptions] = await Promise.all([
    pendingMirrorsFor(subscriber).catch(() => []),
    listBasketSubscriptions(subscriber).catch(() => []),
  ]);

  return NextResponse.json(
    { mirrors, following: subscriptions },
    { headers: { "cache-control": "no-store" } },
  );
}