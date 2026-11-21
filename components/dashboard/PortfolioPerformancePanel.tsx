"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import CacheFreshnessPill from "@/components/CacheFreshnessPill";
import { PerformanceChart } from "@/components/charts/PerformanceChart";
import {
  isPortfolioPerformanceResponse,
  type PortfolioPerformanceResponse,
} from "@/lib/portfolio-performance";

export default function PortfolioPerformancePanel({
  address,
}: {
  address: string;
}) {
  const t = useTranslations("dashboard");
  const [data, setData] = useState<PortfolioPerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    // Deterministic comparison fixtures are exercised through the performance
    // payload validator; partial settlements, refunds, fees and incomplete
    // history are represented by the points supplied in the response.
    setLoading(true);
    try {
      const response = await fetch(
        `/api/performance/${encodeURIComponent(address)}`,
        { cache: "no-store", signal },
      );
      if (!response.ok) throw new Error(`performance endpoint returned ${response.status}`);

      const payload: unknown = await response.json();
      if (!isPortfolioPerformanceResponse(payload)) {
        throw new Error("invalid portfolio performance payload");
      }

      setData(payload);
      setError(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    // Never carry performance from one wallet into another wallet's render while
    // the new address is loading. Reloads for the same address keep the last
    // validated snapshot, but an address change is a hard data-scope boundary.
    setData(null);
    setError(false);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [address, load]);

  return (
    <section
      className="mb-6"
      aria-label={t("portfolioPerformanceAria")}
      aria-busy={loading && data === null}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-sm font-bold uppercase tracking-wide text-pv-text">
            {t("portfolioPerformanceTitle")}
          </h2>
          <p className="mt-0.5 text-xs text-pv-muted">
            {t("portfolioPerformanceHint")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data ? <CacheFreshnessPill freshness={data.cache} /> : null}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="focus-ring rounded border border-pv-ink/[0.14] px-3 py-1.5 font-display text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted transition-colors hover:border-pv-emerald/45 hover:text-pv-text disabled:cursor-wait disabled:opacity-50"
          >
            {loading ? t("portfolioPerformanceRefreshing") : t("portfolioPerformanceRefresh")}
          </button>
        </div>
      </div>

      {loading && data === null ? (
        <div className="h-[230px] animate-pulse border border-pv-ink/[0.1] bg-pv-surface/40" aria-hidden />
      ) : null}

      {error && data === null ? (
        <div
          role="alert"
          className="border border-pv-danger/30 bg-pv-danger/[0.06] px-4 py-8 text-center text-sm text-pv-muted"
        >
          <p>{t("portfolioPerformanceError")}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="focus-ring mt-3 rounded border border-pv-danger/30 px-3 py-1.5 font-display text-[10px] font-bold uppercase tracking-[0.14em] text-pv-text"
          >
            {t("portfolioPerformanceRetry")}
          </button>
        </div>
      ) : null}

      {data ? (
        <>
          {error ? (
            <p role="status" className="mb-2 text-xs text-pv-danger">
              {t("portfolioPerformanceRefreshFailed")}
            </p>
          ) : data.cache.status === "stale" ? (
            <p role="status" className="mb-2 text-xs text-pv-muted">
              {t("portfolioPerformanceStale")}
            </p>
          ) : null}
          <PerformanceChart
            points={data.points}
            baseline={0}
            label={t("portfolioPerformanceChartLabel")}
            emptyMessage={t("portfolioPerformanceEmpty")}
            invalidMessage={t("portfolioPerformanceInvalid")}
            keyboardNavigation
          />
        </>
      ) : null}
    </section>
  );
}
