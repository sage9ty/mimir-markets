"use client";

import { Activity } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import {
  CREATE_TICKET_BODY_CLASS,
  CREATE_TICKET_META_GRID_CLASS,
  CREATE_TICKET_SHELL_CLASS,
  CREATE_TICKET_WATERMARK_CLASS,
} from "@/lib/createFormResponsive";
import { parsePrefillParams } from "@/lib/mirror-prefill";

export type ChallengeSide = "yes" | "no";


function truncate(s: string, max: number) {
  const t = s.trim();
  if (t.length > max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Vista compacta: primeros 6 y últimos 4 caracteres (p. ej. GAIRCE...CF6M).
 *
 * The EVM version prefixed a `0x` when the value did not already have one, which
 * on Stellar produced `0xGAIRCE…` — a string that is not an address, cannot be
 * pasted, and looks like a rendering bug. A strkey carries its own type prefix
 * (`G` for an account, `C` for a contract), so it is shown verbatim.
 */
function formatWalletForTicket(address: string | null | undefined): string {
  if (!address || typeof address !== "string") {
    return "—";
  }
  const a = address.trim();
  if (a.length < 12) {
    return a;
  }
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

export type CreateChallengeTicketProps = {
  draftId: string;
  marketTypeLabel: string;
  oddsModeLabel: string;
  formatLabel: string;
  visibilityLabel: string;
  /** Texto mostrado como vista previa de settlement (regla actual o plantilla guía). */
  settlementPreview: string;
  stakeAmount: number;
  /** Dirección conectada para la línea AUTH_SIG; si no hay, se muestra un marcador. */
  walletAddress?: string | null;
  /** Monto máximo permitido por mercado (suscripción). Usado para clamp. */
  maxAmount?: number;
  /** Query string de la URL actual (p. ej. `window.location.search`). */
  searchParams?: string;
  /** True when the connected account has changed since the last signed intent.
   *  The ticket shows a review banner and hides the SIGNED watermark; the
   *  parent is responsible for gating submission until re-authorization. */
  accountChanged?: boolean;
};

/**
 * Ticket lateral en vivo para el flujo de creación de VS (resumen y compromiso).
 */
export default function CreateChallengeTicket({
  draftId,
  marketTypeLabel,
  oddsModeLabel,
  formatLabel,
  visibilityLabel,
  settlementPreview,
  stakeAmount,
  walletAddress,
  maxAmount,
  searchParams,
  accountChanged = false,
}: CreateChallengeTicketProps) {
  const t = useTranslations("create");

  // Resolve search params from prop or, in the browser, from the URL.
  const [resolvedSearch, setResolvedSearch] = useState<string | undefined>(
    searchParams,
  );
  useEffect(() => {
    if (searchParams !== undefined) {
      setResolvedSearch(searchParams);
      return;
    }
    if (typeof window !== "undefined") {
      setResolvedSearch(window.location.search);
    }
  }, [searchParams]);

  const prefill = useMemo(() => {
    if (!resolvedSearch) return null;
    try {
      const params = new URLSearchParams(
        resolvedSearch.startsWith("?")
          ? resolvedSearch.slice(1)
          : resolvedSearch,
      );
      return parsePrefillParams(params, maxAmount);
    } catch {
      return null;
    }
  }, [resolvedSearch, maxAmount]);

  const effectiveStake = prefill ? prefill.amount : stakeAmount;
  const stakeStr = Number.isFinite(effectiveStake)
    ? effectiveStake.toFixed(2)
    : "—";
  const body = truncate(settlementPreview.trim(), 240);
  const authDisplay = formatWalletForTicket(walletAddress);
  const showQuoted = body.length > 0;

  return (
    <div className={CREATE_TICKET_SHELL_CLASS}>
      {accountChanged ? (
        <div
          role="status"
          aria-live="polite"
          className="border-b border-pv-amber/40 bg-pv-amber/10 px-4 py-2 text-xs text-pv-text"
        >
          Account changed — review and re-authorize before submitting.
        </div>
      ) : null}
      {/* Watermark — transitions from UNSIGNED to SIGNED based on wallet */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none overflow-hidden">
        <span className={CREATE_TICKET_WATERMARK_CLASS}>
          {accountChanged ? "UNSIGNED" : walletAddress ? "SIGNED" : "UNSIGNED"}
        </span>
      </div>
      <div
        className="absolute left-0 top-0 h-1 w-full bg-pv-emerald"
        aria-hidden
      />
      <div className={CREATE_TICKET_BODY_CLASS}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold tracking-tighter text-pv-text sm:text-xl">
              {t("challengeTicketTitle")}
            </h2>
            <p className="mt-1 font-mono text-[10px] tracking-[0.12em] text-pv-muted/60">
              <span className="text-pv-muted/40">{t("ticketIdLabel")}</span>{" "}
              <span className="uppercase">{draftId}</span>
            </p>
          </div>
          <Activity
            className="size-6 shrink-0 animate-pulse text-pv-emerald"
            strokeWidth={2}
            aria-hidden
          />
        </div>

        <div className="space-y-6">
          <div className={CREATE_TICKET_META_GRID_CLASS}>
            <div>
              <div className="mb-1 block text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                {t("marketType")}
              </div>
              <span className="break-words text-sm font-semibold text-pv-text">
                {marketTypeLabel}
              </span>
            </div>
            <div>
              <div className="mb-1 block text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                {t("oddsMode")}
              </div>
              <span className="text-sm font-semibold text-pv-text">
                {oddsModeLabel}
              </span>
            </div>
            <div>
              <div className="mb-1 block text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                {t("format")}
              </div>
              <span className="text-sm font-semibold text-pv-text">
                {formatLabel}
              </span>
            </div>
            <div>
              <div className="mb-1 block text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                {t("visibility")}
              </div>
              <span className="text-sm font-semibold text-pv-emerald">
                {visibilityLabel}
              </span>
            </div>
            {prefill ? (
              <div>
                <div className="mb-1 block text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                  {t("ticketSideLabel")}
                </div>
                <span className="text-sm font-semibold uppercase text-pv-emerald">
                  {prefill.side}
                </span>
              </div>
            ) : null}
          </div>

          <div className="space-y-2 border-t border-pv-ink/[0.08] pt-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
              {t("settlementRule")}
            </div>
            <p className="text-xs italic break-words leading-relaxed text-pv-text/85">
              {showQuoted ? (
                <>
                  <span className="text-pv-muted/70" aria-hidden>
                    &ldquo;
                  </span>
                  {body}
                  <span className="text-pv-muted/70" aria-hidden>
                    &rdquo;
                  </span>
                </>
              ) : (
                t("ticketSettlementFallback")
              )}
            </p>
          </div>
        </div>

        <div className="space-y-4 border-t border-dashed border-pv-ink/[0.08] pt-6">
          <div className="flex items-end justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-[0.12em] text-pv-muted">
              {t("ticketYourCommitment")}
            </span>
            <span className="font-display text-2xl font-bold tabular-nums text-pv-emerald">
              {stakeStr} USDC
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-pv-border/30 bg-pv-surface2/60 px-4 py-3">
        <div className="flex min-w-0 shrink gap-px" aria-hidden>
          {[1, 2, 2, 3, 2, 1, 2, 1, 2, 1].map((w, i) => (
            <div
              key={i}
              className="h-6 bg-pv-text/[0.18]"
              style={{ width: `${w * 5}px` }}
            />
          ))}
        </div>
        <span className="shrink-0 font-mono text-[10px] text-pv-muted/85">
          {t("ticketAuthSig")}: {authDisplay}
        </span>
      </div>
      <div className="h-1 w-full bg-pv-emerald" aria-hidden />
    </div>
  );
}
