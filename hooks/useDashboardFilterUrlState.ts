"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  DEFAULT_DASHBOARD_FILTER_URL_STATE,
  parseDashboardUrlSearchParams,
  serializeDashboardUrlState,
  type DashboardFilterUrlState,
  type DashboardUrlTab,
} from "@/lib/dashboardUrlState";
import { clampDashboardPage } from "@/lib/dashboardUiPolicy";

/**
 * Dashboard filters in client + URL via `history.replaceState` (same approach as Explore:
 * without `router.replace` to avoid RSC re-fetch).
 *
 * - Full URL navigation / back-forward: `useSearchParams` or `popstate` align state.
 * - Page (`page`) is 1-based and clamped to the valid range when writing the URL.
 */
export function useDashboardFilterUrlState() {
  const searchParams = useSearchParams();
  const querySignature = searchParams.toString();

  const [state, setState] = useState<DashboardFilterUrlState>(() =>
    parseDashboardUrlSearchParams(new URLSearchParams(querySignature))
  );

  useEffect(() => {
    setState(parseDashboardUrlSearchParams(new URLSearchParams(querySignature)));
  }, [querySignature]);

  const commitUrl = useCallback((next: DashboardFilterUrlState) => {
    if (typeof window === "undefined") return;
    const qs = serializeDashboardUrlState(next);
    const search = qs ? `?${qs}` : "";
    const url = `${window.location.pathname}${search}`;
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const setTab = useCallback(
    (tab: DashboardUrlTab) => {
      setState((prev) => {
        // Tab switch resets the page to avoid losing rows in the new set.
        const next = { ...prev, tab, page: 1 };
        commitUrl(next);
        return next;
      });
    },
    [commitUrl]
  );

  const setSearchQuery = useCallback(
    (search: string) => {
      setState((prev) => {
        const next = { ...prev, search, page: 1 };
        commitUrl(next);
        return next;
      });
    },
    [commitUrl]
  );

  const setCategoryFilter = useCallback(
    (cat: string) => {
      setState((prev) => {
        const next = { ...prev, cat, page: 1 };
        commitUrl(next);
        return next;
      });
    },
    [commitUrl]
  );

  const setMinStakeFilter = useCallback(
    (minStake: number) => {
      setState((prev) => {
        const next = { ...prev, minStake, page: 1 };
        commitUrl(next);
        return next;
      });
    },
    [commitUrl]
  );

  /**
   * Updates list page. Accepts number or reducer function so callers
   * can step prev/next without knowing current state.
   */
  const setPage = useCallback(
    (next: number | ((prev: number) => number)) => {
      setState((prev) => {
        const raw = typeof next === "function" ? next(prev.page) : next;
        const page = clampDashboardPage(raw);
        if (page === prev.page) return prev;
        const updated = { ...prev, page };
        commitUrl(updated);
        return updated;
      });
    },
    [commitUrl]
  );

  const resetFilters = useCallback(() => {
    setState(DEFAULT_DASHBOARD_FILTER_URL_STATE);
    if (typeof window !== "undefined") {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname
      );
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setState(
        parseDashboardUrlSearchParams(new URLSearchParams(window.location.search))
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return {
    tab: state.tab,
    setTab,
    searchQuery: state.search,
    setSearchQuery,
    categoryFilter: state.cat,
    setCategoryFilter,
    minStakeFilter: state.minStake,
    setMinStakeFilter,
    page: state.page,
    setPage,
    resetFilters,
  };
}
