import { NextResponse } from "next/server";

import { apiError } from "@/lib/api/errors";
import { CATEGORIES } from "@/lib/constants";
import { getVsFeedSnapshot, type VsFeedOptions, type VsSort } from "@/lib/server/vs-index";
import { VS_CACHE_HEADERS } from "@/lib/server/vs-cache";
import { decodeCursor, encodeCursor, type CursorFilters } from "@/lib/api/cursor";

export const dynamic = "force-dynamic";

export function computeVsEtag(updatedAt: string | number | null | undefined, count: number): string {
  const maxUpdatedAt = updatedAt == null ? "0" : String(updatedAt);
  return `W/"${maxUpdatedAt}-${count}"`;
}

export function isEtagMatch(ifNoneMatch: string | null, ifNoneMatchWeak: string | null, etag: string): boolean {
  const header = ifNoneMatch ?? ifNoneMatchWeak;
  if (!header) return false;
  const tokens = header.split(",").map((t) => t.trim());
  if (tokens.includes("*")) return true;
  const normalize = (value: string) => value.replace(/^W\//, "");
  const target = normalize(etag);
  return tokens.some((t) => normalize(t) === target);
}

function resolveMaxUpdatedAt(items: Array<Record<string, unknown>>): string | number | null {
  let max: string | number | null = null;
  for (const item of items) {
    const value = item.updated_at as string | number | null | undefined;
    if (value == null) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

export async function GET(request: Request) {
  try {
    const { authorizeRequest } = await import("@/lib/api/policy");
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
    const gate = await authorizeRequest("public_read", { route: "/api/vs", ip });
    if (!gate.allowed && gate.error) {
      return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
    }
    const { searchParams } = new URL(request.url);
    const parsed = parseVsListParams(searchParams);
    if (parsed.kind === "error") {
      return NextResponse.json(parsed.body, { status: parsed.status, headers: parsed.headers });
    }
    const { forceRefresh, cursor, limit, category, states, creator, sort } = parsed.params;

    // Bind the cursor to the normalized filter selection: a cursor issued for one
    // sort or filter set cannot be replayed against another.
    const filters: CursorFilters = { category, states, creator, sort };
    const decoded = decodeCursor(cursor, filters);
    if (decoded.kind === "error") {
      return NextResponse.json(decoded.error.body, { status: decoded.error.status, headers: decoded.error.headers });
    }

    const { items, cache, nextCursor } = await getVsFeedSnapshot({
      forceRefresh,
      cursor,
      limit,
      category,
      states,
      creator,
      sort,
    });

    const maxUpdatedAt = resolveMaxUpdatedAt(items as Array<Record<string, unknown>>);
    const etag = computeVsEtag(maxUpdatedAt, items.length);
    const ifNoneMatch = request.headers.get("if-none-match");

    if (isEtagMatch(ifNoneMatch, null, etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: { ...VS_CACHE_HEADERS, ETag: etag },
      });
    }

    const boundNextCursor =
      nextCursor && items.length > 0
        ? encodeCursor(
            {
              key: (items[items.length - 1] as { id: number }).id,
              id: (items[items.length - 1] as { id: number }).id,
            },
            filters,
          )
        : nextCursor;

    return NextResponse.json(
      {
        items,
        count: items.length,
        cache,
        nextCursor: boundNextCursor,
      },
      {
        headers: { ...VS_CACHE_HEADERS, ETag: etag },
      }
    );
  } catch {
    const err = apiError("internal_error", "Unable to load VS feed");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
