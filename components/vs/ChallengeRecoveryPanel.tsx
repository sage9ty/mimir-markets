"use client";

/**
 * Recovery panel for a challenge submission whose outcome is unknown.
 *
 * Rendered by the market detail page while `useVsDetail` holds a recovery
 * record. It shows the submitted transaction identity (hash + explorer link),
 * the stake that was signed, and the bounded status-check budget. All state
 * transitions live in `lib/challenge-recovery.ts` and the hook — this
 * component only renders them and forwards the two user actions.
 */

import { ExternalLink, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button, GlassCard } from "@/components/ui";
import {
  CHALLENGE_RECOVERY_MAX_STATUS_CHECKS,
  hasChallengeStatusBudget,
  isChallengeRecoveryBlocking,
  type ChallengeRecoveryRecord,
} from "@/lib/challenge-recovery";

export interface ChallengeRecoveryPanelProps {
  record: ChallengeRecoveryRecord;
  /** Explorer URL for the submitted transaction hash. */
  explorerUrl: string;
  /** True while a status check is in flight. */
  checking: boolean;
  /** Run one bounded status check. */
  onCheckStatus: () => void;
  /** Clear a resolved or expired record. Ignored by the hook while blocking. */
  onDismiss: () => void;
}

export default function ChallengeRecoveryPanel({
  record,
  explorerUrl,
  checking,
  onCheckStatus,
  onDismiss,
}: ChallengeRecoveryPanelProps) {
  const t = useTranslations("vsDetail");

  const blocking = isChallengeRecoveryBlocking(record);
  const hasBudget = hasChallengeStatusBudget(record);
  const statusLabel =
    record.status === "succeeded"
      ? t("challengeRecoveryStatusSucceeded")
      : record.status === "failed"
        ? t("challengeRecoveryStatusFailed")
        : t("challengeRecoveryStatusUnknown");
  const statusColorClass =
    record.status === "succeeded"
      ? "text-pv-emerald"
      : record.status === "failed"
        ? "text-pv-fuch"
        : "text-pv-cyan";

  return (
    <GlassCard
      glass
      className="!rounded-2xl border border-pv-ink/[0.12]"
      data-testid="challenge-recovery-panel"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-pv-text">
            {t("challengeRecoveryTitle")}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-pv-muted">
            {t("challengeRecoveryBody")}
          </p>
        </div>
        <span
          className={`shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.12em] ${statusColorClass}`}
          data-testid="challenge-recovery-status"
        >
          {statusLabel}
        </span>
      </div>

      <dl className="mt-3 space-y-2 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
            {t("challengeRecoveryTxLabel")}
          </dt>
          <dd className="min-w-0 break-all font-mono text-pv-text" data-testid="challenge-recovery-txhash">
            {record.txHash}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
            {t("challengeRecoveryStakeLabel")}
          </dt>
          <dd className="font-mono tabular-nums text-pv-text">
            {record.stakeAmount} USDC
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
            {t("challengeRecoveryStatusLabel")}
          </dt>
          <dd className="font-mono tabular-nums text-pv-muted">
            {t("challengeRecoveryChecksUsed", {
              used: Math.min(record.statusChecks, CHALLENGE_RECOVERY_MAX_STATUS_CHECKS),
              max: CHALLENGE_RECOVERY_MAX_STATUS_CHECKS,
            })}
          </dd>
        </div>
      </dl>

      {blocking && !hasBudget && (
        <p className="mt-3 text-xs leading-relaxed text-pv-muted">
          {t("challengeRecoveryBudgetExhausted")}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="fuch"
          size="sm"
          fullWidth={false}
          onClick={onCheckStatus}
          loading={checking}
          disabled={checking || record.status !== "unknown" || !hasBudget}
          data-testid="challenge-recovery-check"
        >
          {checking ? t("challengeRecoveryChecking") : t("challengeRecoveryCheckButton")}
        </Button>
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-pv-ink/[0.12] px-3 py-1.5 text-xs font-semibold text-pv-text transition-colors hover:border-pv-emerald/40 hover:text-pv-emerald"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t("challengeRecoveryExplorer")}
        </a>
        {!blocking && (
          <Button
            variant="ghost"
            size="sm"
            fullWidth={false}
            onClick={onDismiss}
            className="ml-auto"
            data-testid="challenge-recovery-dismiss"
          >
            <X className="size-3.5" aria-hidden />
            {t("challengeRecoveryDismiss")}
          </Button>
        )}
      </div>
    </GlassCard>
  );
}
