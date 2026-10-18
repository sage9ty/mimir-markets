import type { CategoryId } from "@/lib/constants";

/**
 * Demo dashboard holdings (Canelo / Colapinto / Álvarez) used to seed the UI
 * before real on-chain data existed. Now empty — the dashboard only renders
 * the user's actual on-chain claims.
 *
 * The type stays a non-empty string literal so existing consumers compile;
 * `DASHBOARD_STAKE_HOLDING_IDS` is an empty array so nothing actually renders.
 */
export type DashboardStakeHoldingId = "canelo" | "colapinto" | "alvarez";

export const DASHBOARD_STAKE_HOLDING_IDS = [] as ReadonlyArray<DashboardStakeHoldingId>;

export type DashboardHoldingStatus = "open" | "accepted" | "resolved";

export type DashboardHoldingVisibility = "public" | "private";

/** Types aligned with `vsDetail.marketTypes` (i18n). */
export type DashboardHoldingMarketType =
  | "binary"
  | "moneyline"
  | "spread"
  | "total"
  | "prop"
  | "custom";

/** Market metadata per row (mock; with real data will come from VS). */
export const DASHBOARD_STAKE_HOLDING_META: Record<
  DashboardStakeHoldingId,
  {
    categoryId: CategoryId;
    status: DashboardHoldingStatus;
    /** Visible arena-style code (`#xxxx-X`). */
    idCode: string;
    marketType: DashboardHoldingMarketType;
    oddsMode: "pool" | "fixed";
    /** Public or private (bounded match/duel). */
    visibility: DashboardHoldingVisibility;
    /** Current participants in the pool / market. */
    participantCount: number;
    /**
     * Slot cap (e.g. 1v1 duel = 2). `null` = open pool with no cap in UI.
     */
    maxParticipants: number | null;
  }
> = {
  canelo: {
    categoryId: "sports",
    status: "accepted",
    idCode: "#0482-P",
    marketType: "total",
    oddsMode: "pool",
    visibility: "public",
    participantCount: 24,
    maxParticipants: null,
  },
  colapinto: {
    categoryId: "sports",
    status: "open",
    idCode: "#0611-F",
    marketType: "prop",
    oddsMode: "pool",
    visibility: "public",
    participantCount: 2,
    maxParticipants: 2,
  },
  alvarez: {
    categoryId: "sports",
    status: "accepted",
    idCode: "#0339-A",
    marketType: "prop",
    oddsMode: "fixed",
    visibility: "public",
    participantCount: 156,
    maxParticipants: null,
  },
};

/** Destination for the "view details" CTA per row (replace with `/vs/:id` when real data exists). */
export const dashboardStakeHoldingDetailHref: Record<
  DashboardStakeHoldingId,
  string
> = {
  canelo: "/explorer",
  colapinto: "/explorer",
  alvarez: "/explorer",
};

/** Footer pill (LIVE / OPEN / CLOSED / Settled): consistent with visibility and quota. */
export type DashboardFooterPoolPill = "live" | "open" | "closed" | "settled";

export function getDashboardHoldingFooterPoolPill(
  meta: (typeof DASHBOARD_STAKE_HOLDING_META)[DashboardStakeHoldingId]
): DashboardFooterPoolPill {
  if (meta.status === "resolved") return "settled";
  if (meta.status === "accepted") return "live";
  if (
    meta.status === "open" &&
    meta.visibility === "private" &&
    meta.maxParticipants != null &&
    meta.participantCount >= meta.maxParticipants
  ) {
    return "closed";
  }
  return "open";
}

/** Mock risk profile (sum ≈ 100 for UI). */
export const DASHBOARD_RISK_PROFILE_MOCK = [
  { key: "conservative", pct: 45 },
  { key: "moderate", pct: 34 },
  { key: "aggressive", pct: 21 },
] as const;
