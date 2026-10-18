/**
 * Dashboard surfaces — aligned with `ArenaCard` in Explorer: gray panel `pv-surface`
 * against the `pv-bg` background, `white/[0.12]` border, hover behavior as in Arena (`#242323` + emerald border).
 *
 * Avoid overly transparent backgrounds that blend into the page background.
 */

/** Standard card: list rows, VS container, KPI (`ArenaCard` parity). */
export const DASHBOARD_CARD_SURFACE =
  "rounded-xl border border-pv-ink/[0.12] bg-pv-surface";

/** Hover for KPI and interactive flat blocks (`ArenaCard` parity). */
export const DASHBOARD_CARD_HOVER =
  "transition-[border-color,background-color] duration-200 hover:border-pv-emerald/40 hover:bg-pv-surface2";

/** Panel with padding (filters, risk profile, quick actions). */
export const DASHBOARD_PANEL_SURFACE = `${DASHBOARD_CARD_SURFACE} p-4 sm:p-5`;

/** Empty states / no matches (same gray fill, dashed border). */
export const DASHBOARD_SURFACE_DASHED =
  "rounded-xl border border-dashed border-pv-ink/[0.12] bg-pv-surface";

/** Summary bar, "load more" (intermediate gray tone, same chromatic family). */
export const DASHBOARD_SURFACE_MUTED =
  "rounded-xl border border-pv-ink/[0.1] bg-pv-surface2/35";

/** Loading placeholder for rows. */
export const DASHBOARD_SKELETON_ROW =
  "rounded-xl border border-pv-ink/[0.12] bg-pv-surface2/50";

/** Stat cells inside rows (same pattern as `ArenaCard`). */
export const DASHBOARD_STAT_CELL_SURFACE =
  "rounded border border-pv-ink/[0.1] bg-pv-ink/[0.03] px-3 py-2.5 sm:px-3.5 sm:py-3";

/**
 * Dashboard pagination — UI contract for batch loading positions.
 *
 * The dashboard loads positions from the chain (chain-as-source-of-truth); the
 * client only paginates what is already loaded and never invalidates chain state.
 */

/** Default page size for dashboard positions. */
export const DASHBOARD_PAGE_SIZE = 10 as const;

/** Maximum allowed page size (contract input boundary). */
export const DASHBOARD_MAX_PAGE_SIZE = 100 as const;

/** Minimum allowed page size. */
export const DASHBOARD_MIN_PAGE_SIZE = 1 as const;

/** Loading status for the pagination factory. */
export type DashboardPaginationStatus =
  | "idle"
  | "loading"
  | "ready"
  | "invalid"
  | "stale"
  | "disconnected"
  | "dependency-failure";

/** Reason for pagination failure to report to the UI. */
export type DashboardPaginationFailure =
  | "none"
  | "invalid-page"
  | "invalid-page-size"
  | "out-of-range"
  | "stale-source"
  | "wallet-disconnected"
  | "data-source-unavailable";

/** Normalized and safe pagination input. */
export interface DashboardPaginationInput {
  page: number;
  pageSize: number;
}

/** Result of normalizing a pagination input. */
export interface DashboardPaginationResolved {
  page: number;
  pageSize: number;
  offset: number;
  failure: DashboardPaginationFailure;
}

/** Pagination metadata for summary bar and page control. */
export interface DashboardPaginationMeta {
  totalItems: number;
  totalPages: number;
  page: number;
  pageSize: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/** Pagination state exposed to the dashboard UI. */
export interface DashboardPaginationState {
  status: DashboardPaginationStatus;
  failure: DashboardPaginationFailure;
  page: number;
  pageSize: number;
  meta: DashboardPaginationMeta;
}

/** Initial state for the pagination factory. */
export const DASHBOARD_PAGINATION_INITIAL: DashboardPaginationState = {
  status: "idle",
  failure: "none",
  page: 1,
  pageSize: DASHBOARD_PAGE_SIZE,
  meta: {
    totalItems: 0,
    totalPages: 0,
    page: 1,
    pageSize: DASHBOARD_PAGE_SIZE,
    hasPrevious: false,
    hasNext: false,
  },
};

/** Status messages for the pagination UI. */
export const DASHBOARD_PAGINATION_MESSAGES: Record<DashboardPaginationStatus, string> = {
  idle: "",
  loading: "Cargando posiciones…",
  ready: "",
  invalid: "La página solicitada no es válida.",
  stale: "Los datos de la cadena cambiaron; refrescá para ver la versión actual.",
  disconnected: "Conectá tu cartera para ver tus posiciones.",
  "dependency-failure": "No pudimos cargar las posiciones. Intentá de nuevo.",
};

/** Specific pagination failure messages. */
export const DASHBOARD_PAGINATION_FAILURE_MESSAGES: Record<
  DashboardPaginationFailure,
  string
> = {
  none: "",
  "invalid-page": "El número de página debe ser un entero positivo.",
  "invalid-page-size": "El tamaño de página debe ser un entero entre 1 y 100.",
  "out-of-range": "Esa página no tiene posiciones.",
  "stale-source": "La cadena devolvió números distintos a los mostrados.",
  "wallet-disconnected": "La cartera se desconectó mientras cargabas.",
  "data-source-unavailable": "El origen de datos de la cadena no está disponible.",
};

/** Input contract for the pagination factory. */
export interface DashboardPaginationContract {
  pageSize: number;
  maxPageSize: number;
  minPageSize: number;
}

/** Pagination contract exposed to dashboard loaders. */
export const DASHBOARD_PAGINATION_CONTRACT: DashboardPaginationContract = {
  pageSize: DASHBOARD_PAGE_SIZE,
  maxPageSize: DASHBOARD_MAX_PAGE_SIZE,
  minPageSize: DASHBOARD_MIN_PAGE_SIZE,
};

/** Checks if a value is a finite integer. */
function isFiniteInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value);
}

/** Normalizes the page size within the contract bounds. */
function normalizePageSize(pageSize: number): number {
  if (!isFiniteInteger(pageSize)) {
    return DASHBOARD_PAGINATION_CONTRACT.pageSize;
  }
  if (pageSize < DASHBOARD_PAGINATION_CONTRACT.minPageSize) {
    return DASHBOARD_PAGINATION_CONTRACT.minPageSize;
  }
  if (pageSize > DASHBOARD_PAGINATION_CONTRACT.maxPageSize) {
    return DASHBOARD_PAGINATION_CONTRACT.maxPageSize;
  }
  return pageSize;
}

/** Normalizes the page number to a positive integer. */
function normalizePage(page: number): number {
  if (!isFiniteInteger(page) || page < 1) {
    return 1;
  }
  return page;
}

/**
 * Resolves a pagination input into a normalized and deterministic result.
 *
 * The reported failure is the most relevant reason for the UI: an invalid
 * value is considered invalid even though it normalizes to a safe value.
 */
export function resolveDashboardPaginationInput(
  input: DashboardPaginationInput,
): DashboardPaginationResolved {
  const pageInvalid = !isFiniteInteger(input.page) || input.page < 1;
  const pageSizeInvalid =
    !isFiniteInteger(input.pageSize) ||
    input.pageSize < DASHBOARD_PAGINATION_CONTRACT.minPageSize ||
    input.pageSize > DASHBOARD_PAGINATION_CONTRACT.maxPageSize;

  const page = normalizePage(input.page);
  const pageSize = normalizePageSize(input.pageSize);

  const failure: DashboardPaginationFailure = pageInvalid
    ? "invalid-page"
    : pageSizeInvalid
      ? "invalid-page-size"
      : "none";

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    failure,
  };
}

/** Builds pagination metadata from total items. */
export function buildDashboardPaginationMeta(
  totalItems: number,
  page: number,
  pageSize: number,
): DashboardPaginationMeta {
  const safeTotal = isFiniteInteger(totalItems) && totalItems > 0 ? totalItems : 0;
  const safePageSize = normalizePageSize(pageSize);
  const totalPages = Math.ceil(safeTotal / safePageSize);
  const safePage = totalPages === 0 ? 1 : Math.min(normalizePage(page), totalPages);

  return {
    totalItems: safeTotal,
    totalPages,
    page: safePage,
    pageSize: safePageSize,
    hasPrevious: safePage > 1,
    hasNext: totalPages > 0 && safePage < totalPages,
  };
}

/** Builds pagination state for the dashboard UI. */
export function buildDashboardPaginationState(params: {
  totalItems: number;
  page: number;
  pageSize: number;
  isLoading?: boolean;
  isDisconnected?: boolean;
  isStale?: boolean;
  isDependencyUnavailable?: boolean;
}): DashboardPaginationState {
  const resolved = resolveDashboardPaginationInput({
    page: params.page,
    pageSize: params.pageSize,
  });

  const meta = buildDashboardPaginationMeta(
    params.totalItems,
    resolved.page,
    resolved.pageSize,
  );

  let status: DashboardPaginationStatus;
  if (params.isDisconnected) {
    status = "disconnected";
  } else if (params.isDependencyUnavailable) {
    status = "dependency-failure";
  } else if (params.isStale) {
    status = "stale";
  } else if (params.isLoading) {
    status = "loading";
  } else if (resolved.failure !== "none") {
    status = "invalid";
  } else if (meta.totalPages > 0 && resolved.page > meta.totalPages) {
    status = "invalid";
  } else {
    status = "ready";
  }

  const failure: DashboardPaginationFailure =
    status === "disconnected"
      ? "wallet-disconnected"
      : status === "dependency-failure"
        ? "data-source-unavailable"
        : status === "stale"
          ? "stale-source"
          : resolved.failure !== "none"
            ? resolved.failure
            : meta.totalPages > 0 && resolved.page > meta.totalPages
              ? "out-of-range"
              : "none";

  return {
    status,
    failure,
    page: meta.page,
    pageSize: meta.pageSize,
    meta,
  };
}

/** Safely slices a page of positions without mutating the source. */
export function paginateDashboardPositions<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): { items: T[]; meta: DashboardPaginationMeta } {
  const resolved = resolveDashboardPaginationInput({ page, pageSize });
  const meta = buildDashboardPaginationMeta(
    items.length,
    resolved.page,
    resolved.pageSize,
  );
  const start = (meta.page - 1) * meta.pageSize;
  const end = start + meta.pageSize;

  return {
    items: items.slice(start, end),
    meta,
  };
}

/** Pagination bar classes (consistent with surfaces). */
export const DASHBOARD_PAGINATION_BAR = `${DASHBOARD_SURFACE_MUTED} flex flex-wrap items-center justify-between gap-3 px-3 sm:px-4`;

/** Pagination button classes. */
export const DASHBOARD_PAGINATION_BUTTON =
  "rounded-lg border border-pv-ink/[0.12] bg-pv-surface px-3 py-1.5 text-sm font-medium transition-[border-color,background-color] duration-200 hover:border-pv-emerald/40 hover:bg-pv-surface2 disabled:cursor-not-allowed disabled:opacity-50";
