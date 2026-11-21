"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
  WALLET_SIGNING_OPERATION_MESSAGE_KEYS,
  useWallet,
} from "@/lib/wallet";
import {
  ensureUsdcTrustline,
  readUsdcTrustline,
  type TrustlineState,
} from "@/lib/stellar-trustline";
import type { WalletSigningOperationRecord } from "@/lib/wallet-signing-coordinator";

export interface UsdcTrustline extends TrustlineState {
  connected: boolean;
  canSign: boolean;
  stale: boolean;
  loading: boolean;
  adding: boolean;
  add: () => Promise<boolean>;
  refresh: () => void;
  signingBlockedByOtherTab?: boolean;
  signingRecovery?: WalletSigningOperationRecord | null;
  acknowledgeSigningRecovery?: () => boolean;
}

export function useUsdcTrustline(): UsdcTrustline {
  const {
    address,
    isConnected,
    signer,
    signingBlockedByOtherTab = false,
    signingRecovery = null,
    acknowledgeSigningRecovery,
  } = useWallet();
  const t = useTranslations("wallet");
  const [state, setState] = useState<TrustlineState>({ status: "unknown", balance: null });
  const [checkedAddress, setCheckedAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(address));
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!address) {
      setState({ status: "unknown", balance: null });
      setCheckedAddress(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setCheckedAddress(null);
    readUsdcTrustline(address)
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setCheckedAddress(address);
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: "unknown", balance: null });
        setCheckedAddress(address);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [address, tick]);

  const refresh = useCallback(() => {
    setCheckedAddress(null);
    setLoading(true);
    setTick((n) => n + 1);
  }, []);

  const add = useCallback(async () => {
    if (!signer) return false;
    setAdding(true);
    setLoading(true);
    try {
      await ensureUsdcTrustline(signer);
      const next = await readUsdcTrustline(signer.publicKey);
      setState(next);
      setCheckedAddress(signer.publicKey);
      return next.status === "ready";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(
        /reject|denied|cancel/i.test(message)
          ? t("trustlineRejected")
          : /fund|account.*exist|not exist/i.test(message)
            ? t("trustlineUnfunded")
            : message,
      );
      return false;
    } finally {
      setLoading(false);
      setAdding(false);
    }
  }, [signer, t]);

  const acknowledgeRecovery = useCallback(() => {
    if (!acknowledgeSigningRecovery) return false;
    return acknowledgeSigningRecovery(signingRecovery?.operationId);
  }, [acknowledgeSigningRecovery, signingRecovery?.operationId]);

  return {
    ...state,
    connected: isConnected && Boolean(address),
    canSign: Boolean(signer),
    stale: Boolean(address && checkedAddress !== address),
    loading,
    adding,
    add,
    refresh,
    signingBlockedByOtherTab,
    signingRecovery,
    acknowledgeSigningRecovery: acknowledgeRecovery,
  };
}

function UsdcTrustlineGateView({
  trustline,
  className = "",
  onReady,
}: {
  trustline: UsdcTrustline;
  className?: string;
  onReady?: () => void;
}) {
  const t = useTranslations("wallet");
  const state = trustline;

  if (!state.connected) return null;

  if (state.signingRecovery) {
    return (
      <div
        className={`border border-amber-400/35 bg-amber-400/[0.06] p-4 ${className}`}
        role="alert"
      >
        <h3 className="font-mono text-[10px] uppercase tracking-wider text-amber-300">
          {t("signingRecoveryTitle")}
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-pv-muted">
          {t("signingRecoveryHint", {
            operation: t(
              WALLET_SIGNING_OPERATION_MESSAGE_KEYS[state.signingRecovery.operationKind],
            ),
          })}
        </p>
        <button
          type="button"
          onClick={() => state.acknowledgeSigningRecovery?.()}
          className="btn-compact-primary mt-3 px-3.5 py-1.5 text-[12px]"
        >
          {t("signingRecoveryAcknowledge")}
        </button>
      </div>
    );
  }

  if (state.status === "ready" && state.canSign && !state.loading && !state.stale) {
    return null;
  }

  if (!state.canSign) {
    return (
      <div
        className={`border border-pv-ink/[0.12] bg-pv-ink/[0.03] p-4 ${className}`}
        role="status"
        aria-live="polite"
      >
        <p className="text-[12px] leading-relaxed text-pv-muted">{t("cannotSign")}</p>
      </div>
    );
  }

  if (state.loading) {
    return (
      <div
        className={`border border-pv-ink/[0.12] bg-pv-ink/[0.03] p-4 ${className}`}
        role="status"
        aria-live="polite"
      >
        <p className="text-[12px] leading-relaxed text-pv-muted">{t("trustlineChecking")}</p>
      </div>
    );
  }

  if (state.stale) {
    return (
      <div
        className={`border border-amber-400/35 bg-amber-400/[0.06] p-4 ${className}`}
        role="status"
        aria-live="polite"
      >
        <p className="text-[12px] leading-relaxed text-pv-muted">{t("trustlineStale")}</p>
        <button
          type="button"
          onClick={state.refresh}
          className="btn-compact-primary mt-3 px-3.5 py-1.5 text-[12px]"
        >
          {t("trustlineRetry")}
        </button>
      </div>
    );
  }

  if (state.status === "unfunded") {
    return (
      <div
        className={`border border-amber-400/35 bg-amber-400/[0.06] p-4 ${className}`}
        role="status"
        aria-live="polite"
      >
        <h3 className="font-mono text-[10px] uppercase tracking-wider text-amber-300">
          {t("trustlineUnfundedTitle")}
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-pv-muted">
          {t("trustlineUnfundedHint")}
        </p>
      </div>
    );
  }

  if (state.status === "unknown") {
    return (
      <div
        className={`border border-amber-400/35 bg-amber-400/[0.06] p-4 ${className}`}
        role="status"
        aria-live="polite"
      >
        <h3 className="font-mono text-[10px] uppercase tracking-wider text-amber-300">
          {t("trustlineCheckFailedTitle")}
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-pv-muted">
          {t("trustlineCheckFailedHint")}
        </p>
        <button
          type="button"
          onClick={state.refresh}
          className="btn-compact-primary mt-3 px-3.5 py-1.5 text-[12px]"
        >
          {t("trustlineRetry")}
        </button>
      </div>
    );
  }

  return (
    <div className={`border border-pv-emerald/35 bg-pv-emerald/[0.05] p-4 ${className}`}>
      <h3 className="font-mono text-[10px] uppercase tracking-wider text-pv-emerald">
        {t("trustlineMissingTitle")}
      </h3>
      <p className="mt-1 text-[12px] leading-relaxed text-pv-muted">
        {t("trustlineMissingHint")}
      </p>
      <button
        type="button"
        onClick={async () => {
          if (await state.add()) onReady?.();
        }}
        disabled={state.adding || state.signingBlockedByOtherTab}
        aria-busy={state.adding || undefined}
        className="btn-compact-primary mt-3 px-3.5 py-1.5 text-[12px] disabled:opacity-40"
      >
        {state.adding ? t("trustlineAdding") : t("trustlineAdd")}
      </button>
      {state.signingBlockedByOtherTab ? (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-300" role="status" aria-live="polite">
          {t("signingActiveOtherTabHint")}
        </p>
      ) : null}
    </div>
  );
}

export function UsdcTrustlineGate({
  trustline,
  className,
  onReady,
}: {
  trustline?: UsdcTrustline;
  className?: string;
  onReady?: () => void;
}) {
  if (trustline) {
    return (
      <UsdcTrustlineGateView
        trustline={trustline}
        className={className}
        onReady={onReady}
      />
    );
  }

  return <UsdcTrustlineGateFromWallet className={className} onReady={onReady} />;
}

function UsdcTrustlineGateFromWallet({
  className,
  onReady,
}: {
  className?: string;
  onReady?: () => void;
}) {
  const trustline = useUsdcTrustline();
  return (
    <UsdcTrustlineGateView
      trustline={trustline}
      className={className}
      onReady={onReady}
    />
  );
}
