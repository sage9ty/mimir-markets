import { NextRequest } from "next/server";

import { handlePerformanceGet } from "@/lib/server/performance-route-handler";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  const cursor = request.nextUrl.searchParams.get("cursor") ?? undefined;
  return handlePerformanceGet(address, {
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
    cursor,
  });
}
