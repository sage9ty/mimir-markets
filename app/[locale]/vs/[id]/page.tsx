"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useParams, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useWallet } from "@/lib/wallet";
import {
  acceptVS,
  cancelVS,
  didUserChallengeVS,
  getClaimFees,
  getRivalryChain,
  getVS,
  getVSChallengerCount,
  getVSConfiguredMaxChallengers,
  getVSSingleWinnerPayout,
  getVSTotalPot,
  getUserVSDirect,
  hasVSWinner,
  hasZeroAddressWinner,
  isVSJoinable,
  isVSPrivate,
  isVSMultiChallengerWin,
  requestResolveVS,
  resetVSResolveRequest,
  type ClaimChallenger,
  type StellarSigner,
  type VSData,
} from "@/lib/contract";
import { getExplorerTxUrl, waitForTransaction } from "@/lib/stellar";
import {
  challengeRecoveryTxHashFromError,
  isChallengeRecoveryBlocking,
} from "@/lib/challenge-recovery";
import ChallengeRecoveryPanel from "@/components/vs/ChallengeRecoveryPanel";
import { buildSeriesView } from "@/lib/series-view";
import { openPeepsAvatar } from "@/lib/avatars";
import { useVsDetail } from "@/hooks/useVsDetail";
import CacheFreshnessControls from "@/components/CacheFreshnessControls";
import { formatUsdc } from "@/lib/money";
import {
  availableCreatorLiquidityUnits,
  feeStateFromClaimFees,
  maxFixedOddsStakeUnits,
  PENDING_FEE_STATE,
  poolCreatorPayoutUnits,
  previewChallengerPayoutSafe,
  principalSafePayout,
  toPrincipalSafePreview,
  type PayoutFeeState,
} from "@/lib/payout";
import { unitsToUsdc, usdcToUnits } from "@/lib/usdc";
import { toCanonicalMode } from "@/lib/market-modes";
import { MarketAnalytics } from "@/components/MarketAnalytics";
import { MarketPanelSkeleton, RivalryPanelSkeleton } from "@/components/ui/AsyncPanelSkeleton";
import { track } from "@/lib/analytics/client";
import { idempotencyKey } from "@/lib/analytics/events";
import { stakeBucket } from "@/lib/analytics/useMarketAnalytics";
import ReasoningFeed from "@/components/vs/ReasoningFeed";
import { acquireTxLock } from "@/lib/tx-lock";
import { evaluateUsdcTrustlineGate } from "@/lib/usdcTrustlineGate";
import {
  MIN_STAKE,
  ZERO_ADDRESS,
  getShareUrl,
  shortenAddress,
} from "@/lib/constants";
import {
  MOCK_CREATED_VS_ID,
} from "@/lib/mockVsCreate";
import { SAMPLE_VS } from "@/lib/sampleVs";
import { useCountdown } from "@/lib/hooks";
import {
  getStoredPrivateInviteKey,
  rememberPrivateInviteKey,
} from "@/lib/private-links";
import { toast } from "sonner";
import PageTransition, { AnimatedItem } from "@/components/PageTransition";
import {
  Badge,
  Button,
  CountdownTimer,
  GlassCard,
  Input,
} from "@/components/ui";
import ProvenStamp from "@/components/ProvenStamp";
import ClaimStrengthCard from "@/components/ClaimStrengthCard";
import SettlementExplanationCard from "@/components/SettlementExplanationCard";
import ResolutionTerminal from "@/components/ResolutionTerminal";
import { ShareMarket } from "@/components/vs/ShareMarket";
import { ProfileLink } from "@/components/ui/AddressChip";
import ClaimPayoutCard from "@/components/vs/ClaimPayoutCard";
import {
  UsdcTrustlineGate,
  useUsdcTrustline,
} from "@/components/wallet/UsdcTrustlineGate";
import VsXmtpPanel from "@/components/xmtp/VsXmtpPanel";
import CouncilVoteWidget from "@/components/council/CouncilVoteWidget";
import Stage from "@/components/Stage";
import LiveDeadline from "@/components/LiveDeadline";
import { BlueprintHeading } from "@/components/BlueprintGrid";
import { AnimatePresence } from "framer-motion";
import { verdictOverlay, verdictWord, verdictResult } from "@/lib/animations/rituals";
import {
  VS_XMTP_CHAT_ANCHOR_ID,
  shouldMountVsXmtpPanelOnDetailPage,
} from "@/lib/xmtp/vs-chat-eligibility";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FlaskConical,
  GitBranch,
  Share2,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { ProgressBar } from "@/components/vs/detail/ProgressBar";
import { VsChallengersCard } from "@/components/vs/detail/VsChallengersCard";
import {
  buildDesignPreviewVs,
  buildDesignPreviewRematchChain,
  formatChallengers,
  txToastOptions,
  VERDICT_OVERLAY_MS,
  RESOLVE_PHASE_MS,
  RESOLVE_ANIM_TOTAL_MS,
} from "@/lib/vs/detail-preview";

/**
 * Design-preview fixtures live in `lib/design-preview/vs.ts` and are loaded
 * lazily so they never ship in the normal page bundle.
 *
 * To enable the preview, open a sample market (negative id, e.g. `/vs/-1`) and
 * use the lifecycle controls rendered by the sample-mode card. The builders are
 * only imported when `isSampleVS` is true.
 */
type DesignPreviewModule = typeof import("@/lib/design-preview/vs");

/** Misma silueta que la píldora «{addr} challenges you» (fucsia, pill redondeada). */
const DUEL_STATUS_FUCHSIA_PILL_CLASS =
  "inline-flex max-w-full min-w-0 items-center rounded-full border border-pv-fuch/35 bg-pv-fuch/[0.08] px-2.5 py-1 text-left text-[11px] font-semibold leading-tight text-pv-fuch shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] sm:px-3 sm:py-1.5 sm:text-xs";

const RIVALRY_ITEM_BASE_CLASS =
  "rounded-xl border p-4 transition-[border-color,background-color] duration-200 bg-pv-bg/30 hover:border-pv-ink/[0.22] hover:bg-pv-bg/35";
const RIVALRY_ITEM_ACTIVE_CLASS =
  "border-pv-emerald/[0.35] bg-pv-emerald/[0.08] hover:border-pv-emerald/[0.45] hover:bg-pv-emerald/[0.12]";

export default function VSDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const vsId = Number(params.id);
  const isSampleVS = vsId < 0 && !!SAMPLE_VS[vsId];
  const inviteFromUrl = searchParams.get("invite")?.trim() ?? "";
  const { address, isConnected, connect, signer } = useWallet();
  const trustline = useUsdcTrustline();
  const t = useTranslations("vsDetail");
  const tWallet = useTranslations("wallet");
  const tc = useTranslations("common");
  const tStamp = useTranslations("stamp");
  const tBadges = useTranslations("badges");

  const [storedInviteKey, setStoredInviteKey] = useState("");

  const inviteKey = inviteFromUrl || storedInviteKey;

  // ── useVsDetail: generation-guarded polling, freshness, user-context ────────
  const {
    phase: vsPhase,
    vs,
    cache: vsFreshness,
    fetchAttempts,
    refreshing,
    challengeStake,
    setChallengeStake,
    resetChallengeStake,
    refresh: refreshVs,
    challengeRecovery,
    challengeRecoveryChecking,
    beginChallengeRecovery,
    checkChallengeRecovery,
    dismissChallengeRecovery,
  } = useVsDetail({ vsId, address, inviteKey, isSampleVS });

  /**
   * While a signed challenge submission has an unobserved outcome, no second
   * stake action may be presented — the first transaction may still land.
   */
  const challengeRecoveryBlocking = isChallengeRecoveryBlocking(challengeRecovery);

  /** Convenience: true during initial load (skeleton shown). */
  const loading = vsPhase === "loading";

  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [resolvePhase, setResolvePhase] = useState(-1);
  const [showVerdict, setShowVerdict] = useState(false);
  /**
   * The claim's snapshotted fee terms, which turn the gross preview into the
   * number the contract will actually pay. Read once per claim: the snapshot is
   * immutable after create, so it cannot go stale while the page is open.
   */
  const [feeState, setFeeState] = useState<PayoutFeeState>(PENDING_FEE_STATE);
  const [rivalryChain, setRivalryChain] = useState<VSData[]>([]);
  const [rivalryLoading, setRivalryLoading] = useState(false);
  // Evita parpadeos: si cambiamos de `vs.id` o aún no terminó el fetch,
  // mostramos "loading" en vez de "empty" con datos viejos/vacíos.
  const [rivalryLoadedForVsId, setRivalryLoadedForVsId] = useState<number | null>(null);
  const [isRivalryExpanded, setIsRivalryExpanded] = useState(false);
  const [marketTermsOpen, setMarketTermsOpen] = useState(false);
  const marketTermsHeadingId = useId();
  const marketTermsPanelId = useId();
  /** Solo VS de muestra (ids negativos): índice 0–4 para previsualizar diseño sin blockchain. */
  const [designLifecycleStep, setDesignLifecycleStep] = useState<number | null>(null);
  const [designResolvedOutcome, setDesignResolvedOutcome] = useState<"creator" | "challengers">("creator");
  const [designPreview, setDesignPreview] = useState<DesignPreviewModule | null>(null);
  /** Tracks whether a resolve tx was fired so we can reveal the verdict once the state arrives. */
  const pendingResolveRef = useRef(false);
  const attemptedFinalizeResolveTxRef = useRef<string | null>(null);
  const [pendingResolveTxHash, setPendingResolveTxHash] = useState<string | null>(null);
  const [, setHasAttemptedResolve] = useState(false);

  const countdown = useCountdown(vs?.deadline || 0);

  useEffect(() => {
    setDesignLifecycleStep(null);
    setDesignResolvedOutcome("creator");
    pendingResolveRef.current = false;
    attemptedFinalizeResolveTxRef.current = null;
    setPendingResolveTxHash(null);
    setHasAttemptedResolve(false);
  }, [vsId]);

  // Load the design-preview builders only when a sample market is open, so the
  // fixtures stay out of the production chunk for every real market.
  useEffect(() => {
    if (!isSampleVS) {
      setDesignPreview(null);
      return;
    }
    let cancelled = false;
    import("@/lib/design-preview/vs").then((mod) => {
      if (!cancelled) setDesignPreview(mod);
    });
    return () => {
      cancelled = true;
    };
  }, [isSampleVS]);

  const displayVs = useMemo(() => {
    if (!vs) return null;
    if (!isSampleVS || designLifecycleStep === null) {
      return vs;
    }
    if (!designPreview) {
      return vs;
    }
    return designPreview.buildDesignPreviewVs(
      vs,
      designLifecycleStep,
      t("designPreviewResolutionSummary"),
      designResolvedOutcome,
    );
  }, [vs, isSampleVS, designLifecycleStep, t, designResolvedOutcome, designPreview]);

  useEffect(() => {
    if (isSampleVS) {
      return;
    }

    if (inviteFromUrl) {
      rememberPrivateInviteKey(vsId, inviteFromUrl);
      setStoredInviteKey(inviteFromUrl);
      return;
    }

    setStoredInviteKey(getStoredPrivateInviteKey(vsId));
  }, [inviteFromUrl, isSampleVS, vsId]);

  // Fee terms are a separate, optional read from the market itself. `loading`
  // while it is in flight, `unavailable` when the read fails or no contract is
  // configured, `invalid` when the answer is a snapshot the contract could not
  // have written. The preview falls back to the gross in every one of those
  // cases, and says so — it never guesses a fee.
  useEffect(() => {
    if (isSampleVS) {
      // A sample market is not a real claim, so there is no snapshot to read and
      // inventing a fee schedule would be fiction.
      setFeeState({ status: "unavailable" });
      return;
    }
    let cancelled = false;
    setFeeState(PENDING_FEE_STATE);
    getClaimFees(vsId)
      .then((terms) => {
        if (!cancelled) setFeeState(feeStateFromClaimFees(terms));
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[vsDetail] claim fee terms read failed", err);
        setFeeState({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [isSampleVS, vsId]);

  /**
   * Alias kept for the resolve-tx watcher and ClaimPayoutCard so that existing
   * call sites read naturally.  Delegates to the hook's `refresh`.
   */
  const fetchVS = useCallback(() => refreshVs(), [refreshVs]);

  useEffect(() => {
    if (!vs || vs.state !== "resolved" || !pendingResolveRef.current) {
      return;
    }

    pendingResolveRef.current = false;
    attemptedFinalizeResolveTxRef.current = null;
    setPendingResolveTxHash(null);
    setHasAttemptedResolve(false);
    setShowVerdict(true);

    const timer = setTimeout(() => setShowVerdict(false), VERDICT_OVERLAY_MS);
    return () => clearTimeout(timer);
  }, [vs]);

  useEffect(() => {
    if (!pendingResolveTxHash || isSampleVS) {
      return;
    }

    let cancelled = false;
    const resolveTxHash = pendingResolveTxHash;

    async function watchResolveTransaction() {
      // Stellar closes a ledger every ~5s and a transaction is final the moment it
      // is included — no reorgs, no confirmation count. So there is one poll and
      // three outcomes: succeeded, failed, or still not visible.
      const outcome = await waitForTransaction(resolveTxHash);
      if (cancelled) return;

      if (outcome.pending) {
        toast(t("resolveStillPending"));
        return;
      }

      if (!outcome.succeeded) {
        pendingResolveRef.current = false;
        attemptedFinalizeResolveTxRef.current = null;
        setPendingResolveTxHash(null);
        toast.error(t("resolveExecutionFailed"));
      } else {
        attemptedFinalizeResolveTxRef.current = null;
        setPendingResolveTxHash(null);
      }
      void fetchVS();
    }

    void watchResolveTransaction();

    return () => {
      cancelled = true;
    };
  }, [address, fetchVS, isSampleVS, pendingResolveTxHash, t]);

  useEffect(() => {
    // La rivalry chain puede ser costosa y además se recalcula en cada refresh del VS.
    // Para evitar parpadeos en despliegues (polling), solo la cargamos cuando el duelo
    // entra a fase PROVEN/resolved.
    if (isSampleVS || !vs) return;

    if (vs.state !== "resolved") {
      setRivalryChain([]);
      setRivalryLoading(false);
      setRivalryLoadedForVsId(null);
      return;
    }

    let cancelled = false;
    const currentVsId = vs.id;

    async function loadRivalry() {
      setRivalryLoadedForVsId(null);
      setRivalryLoading(true);

      try {
        const ids = await getRivalryChain(currentVsId);
        if (cancelled) return;

        if (ids.length === 0) {
          setRivalryChain([]);
          return;
        }

        const items = await Promise.all(ids.map((id) => getVS(id)));
        if (cancelled) return;

        setRivalryChain(items.filter((item): item is VSData => item !== null));
      } catch {
        if (!cancelled) {
          setRivalryChain([]);
        }
      } finally {
        if (!cancelled) {
          setRivalryLoading(false);
          setRivalryLoadedForVsId(currentVsId);
        }
      }
    }

    loadRivalry();

    return () => {
      cancelled = true;
    };
  }, [isSampleVS, vs?.id, vs?.state]);

  useEffect(() => {
    // Para mantener coherencia visual, colapsamos el rematch list cuando cambia la data.
    setIsRivalryExpanded(false);
  }, [vs?.id, rivalryChain.length, designLifecycleStep, designResolvedOutcome]);

  // The series is derived from the parent chain, not from the fetch order: the
  // round number and the running score have to survive a chain that arrives out
  // of order or with an ancestor outside the read-index window.
  const seriesView = useMemo(
    () => buildSeriesView(vs?.id ?? 0, rivalryChain),
    [vs?.id, rivalryChain],
  );
  const visibleSeriesRows =
    seriesView.rows.length > 2 && !isRivalryExpanded
      ? seriesView.rows.slice(0, 2)
      : seriesView.rows;
  const canLoadMoreRivalry = seriesView.rows.length > 2 && !isRivalryExpanded;
  const isRivalryDataReady =
    isSampleVS || (rivalryLoadedForVsId !== null && rivalryLoadedForVsId === vs?.id);

  useEffect(() => {
    // En demo/testing (VS de muestra) simulamos el rematch para que la card
    // `RIVALRY CHAIN` muestre rondas adicionales en el preview.
    if (!isSampleVS || !vs) return;

    if (designLifecycleStep !== 3) {
      setRivalryChain([]);
      setRivalryLoading(false);
      setRivalryLoadedForVsId(null);
      return;
    }

    if (!designPreview) {
      return;
    }

    setRivalryLoading(false);
    setRivalryChain(
      designPreview.buildDesignPreviewRematchChain(
        vs,
        designResolvedOutcome,
        t("designPreviewResolutionSummary"),
      )
    );
    setRivalryLoadedForVsId(vs.id);
  }, [
    isSampleVS,
    vs,
    designLifecycleStep,
    designResolvedOutcome,
    t,
    designPreview,
  ]);

  if (loading) {
    return (
      <div>
        <MarketPanelSkeleton />
        <p className="sr-only">
          {fetchAttempts > 1 ? t("submittedPending") : tc("loading")}
        </p>
      </div>
    );
  }

  if (!vs) {
    return (
      <div className="text-center py-20">
        <p className="font-display font-bold text-lg mb-4">{t("notFound")}</p>
        <Link href="/">
          <Button variant="primary" fullWidth={false} className="px-8">
            {tc("back")}
          </Button>
        </Link>
      </div>
    );
  }

  const display = displayVs!;

  // Exact, trimmed comparison. Stellar strkeys are case-sensitive base32, so the
  // `toLowerCase()` pair the EVM version used here would never match.
  const isCreator = Boolean(address) && address!.trim() === vs.creator.trim();
  const isOpponent = didUserChallengeVS(display, address);
  const isPrivateVS = isVSPrivate(vs);
  const missingPrivateInvite = isPrivateVS && !inviteKey && !isCreator && !isOpponent;
  // Disconnected visitors get the connect CTA, not the stake form. The payout
  // preview inside that form is address-independent (see
  // `previewChallengerPayoutSafe`), so it needs no disconnected fallback of its
  // own — connection gates the form and the action, not the number.
  const canAccept =
    !isSampleVS &&
    !missingPrivateInvite &&
    isVSJoinable(vs, address) &&
    isConnected;
  const acceptTrustlineGate = evaluateUsdcTrustlineGate({
    action: "accept",
    status: trustline.status,
    loading: trustline.loading,
    stale: trustline.stale,
    isConnected,
    hasSigner: Boolean(signer),
  });
  const canCancel = !isSampleVS && vs.state === "open" && isCreator;
  const hasWinner = hasVSWinner(display);
  const creatorRequestedResolve = Boolean(display.creator_requested_resolve);
  const challengerRequestedResolve = Boolean(display.challenger_requested_resolve);
  const isParticipant = isCreator || isOpponent;
  const userRequestedResolve = isCreator
    ? creatorRequestedResolve
    : isOpponent
      ? challengerRequestedResolve
      : false;
  const counterpartyRequestedResolve = isCreator
    ? challengerRequestedResolve
    : isOpponent
      ? creatorRequestedResolve
      : false;
  const canRequestResolve =
    !isSampleVS &&
    display.state === "accepted" &&
    countdown.expired &&
    isConnected &&
    isParticipant &&
    !userRequestedResolve;
  const canResetResolveRequest =
    !isSampleVS &&
    display.state === "accepted" &&
    countdown.expired &&
    isConnected &&
    isParticipant &&
    (creatorRequestedResolve || challengerRequestedResolve);
  const willTriggerResolution = canRequestResolve && counterpartyRequestedResolve;
  const showRetryResolve = canRequestResolve && (display.resolve_attempts ?? 0) > 0;
  const challengerCount = getVSChallengerCount(display);
  const maxChallengers =
    typeof display.max_challengers === "number" && display.max_challengers > 0
      ? display.max_challengers
      : 1;
  const hasAnyChallenger = challengerCount > 0;
  const isOpen = !hasAnyChallenger;
  const pool = getVSTotalPot(display);
  const challengers = formatChallengers(display);
  const resolvedPayout = getVSSingleWinnerPayout(display);
  const isDesignSampleLost =
    isSampleVS && designLifecycleStep === 3 && designResolvedOutcome === "challengers";
  const isDesignSampleWin =
    isSampleVS && designLifecycleStep === 3 && designResolvedOutcome === "creator";

  const winnerTitle = !hasWinner
    ? tStamp("draw")
    : isDesignSampleLost
      ? tStamp("lost")
      : isDesignSampleWin
        ? tStamp("youWon")
        : display.winner_side === "challengers" &&
            (isVSMultiChallengerWin(display) || hasZeroAddressWinner(display))
          ? "Challengers won"
          : tStamp("won", { address: shortenAddress(display.winner) });
  const provenResultTone = isDesignSampleLost ? "lost" : isDesignSampleWin ? "win" : undefined;
  const winnerAmountLabel =
    !hasWinner
      ? null
      : resolvedPayout === null
        ? formatUsdc(pool)
        : `${provenResultTone === "lost" ? "-" : "+"}${formatUsdc(resolvedPayout)}`;
  const marketType = display.market_type ?? "binary";
  const oddsMode = display.odds_mode ?? "pool";
  const challengeStakeValue = Number(challengeStake);
  const hasValidChallengeStake =
    Number.isFinite(challengeStakeValue) && challengeStakeValue >= MIN_STAKE;
  const creatorStake = display.creator_stake ?? display.stake_amount;
  const challengerStake = display.total_challenger_stake ?? 0;

  // Canonical mode drives the preview: a one-slot pool market is a duel, and a
  // duel pays winner-takes-pot rather than a proportional share.
  const canonicalMode = toCanonicalMode({
    marketType: display.market_type ?? "binary",
    oddsMode: display.odds_mode ?? "pool",
    maxChallengers: getVSConfiguredMaxChallengers(display),
  });

  // Previewed in atomic USDC units by lib/payout.ts, so the number shown matches
  // what the contract will actually transfer (integer truncation included), and
  // split with the claim's snapshotted fees so it matches what will actually be
  // paid. `feeAdjusted` is false while the fee terms are loading, unavailable or
  // invalid — the panel then shows the gross and labels it, because the gross is
  // the most the position can pay and never below the stake.
  const stakePreview = hasValidChallengeStake
    ? previewChallengerPayoutSafe({
        settlementMode: canonicalMode.settlementMode,
        stake: challengeStakeValue,
        creatorStake,
        challengerPoolBefore: challengerStake,
        challengerPayoutBps: display.challenger_payout_bps,
        fees: feeState,
      })
    : null;
  const isPoolPreview = canonicalMode.settlementMode === "pool";
  const totalChallengerStakeAfterJoin = challengerStake + (hasValidChallengeStake ? challengeStakeValue : 0);
  // The creator's side is settled with the same snapshot, so the "if creator wins"
  // figure is net too. Showing one leg gross and the other net would make the two
  // tiles incomparable.
  const creatorPayoutPreview = hasValidChallengeStake
    ? toPrincipalSafePreview(
        principalSafePayout({
          gross: poolCreatorPayoutUnits({
            creatorStakeUnits: usdcToUnits(creatorStake),
            challengerPoolUnits: usdcToUnits(totalChallengerStakeAfterJoin),
          }),
          feeState,
          outcome: "creator_wins",
        }),
      ).netPayout
    : pool;

  // Fixed odds: capacity is bounded by the creator's UNRESERVED liquidity, not by
  // a slot count, and it shrinks as each challenger reserves their profit. Read
  // it from chain state through the same atomic helpers the contract mirrors, so
  // the number shown is the number the escrow will enforce.
  const isFixedOdds = canonicalMode.settlementMode === "fixed_odds";
  const availableLiquidity = isFixedOdds
    ? unitsToUsdc(
        availableCreatorLiquidityUnits({
          creatorStakeUnits: usdcToUnits(creatorStake),
          reservedLiabilityUnits: usdcToUnits(display.reserved_creator_liability ?? 0),
        }),
      )
    : 0;
  const maxFixedStake = isFixedOdds
    ? unitsToUsdc(
        maxFixedOddsStakeUnits({
          availableLiquidityUnits: usdcToUnits(availableLiquidity),
          challengerPayoutBps: display.challenger_payout_bps ?? 0,
        }),
      )
    : 0;
  // Block an over-capacity stake before submit rather than letting it revert.
  const exceedsFixedCapacity =
    isFixedOdds && hasValidChallengeStake && challengeStakeValue > maxFixedStake;
  const showRivalrySection =
    rivalryChain.length > 1 || display.state === "resolved";
  const shareUrl = getShareUrl(vsId, inviteKey);

  /**
   * Shared guard for every on-chain action: wallet connected, one tx at a
   * time (tab-wide lock), and actionLoading reset when the action finishes.
   */
  async function withTxLock(run: (wallet: StellarSigner) => Promise<void>): Promise<void> {
    if (!isConnected || !address) {
      return;
    }
    // Every write below needs a SIGNER, not an address. `lib/contract.ts` still
    // accepts a bare string so unmigrated call sites compile, but it throws at
    // call time — so the guard is here, once, rather than as a surprise inside
    // each action.
    if (!signer) {
      toast.error(t("walletCannotSign"));
      return;
    }
    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = acquireTxLock(address);
    } catch (lockErr: any) {
      toast.error(lockErr.message);
      return;
    }
    try {
      await run(signer);
    } finally {
      releaseLock?.();
      setActionLoading(null);
    }
  }

  async function handleAccept() {
    if (!isConnected || !address) {
      return;
    }
    // Fail closed: while a previous signed submission is unobserved, the stake
    // action is not presented and must not run even if invoked directly.
    if (challengeRecoveryBlocking) {
      toast.error(t("stakeUncertainToast"));
      return;
    }
    if (!hasValidChallengeStake) {
      toast.error(t("invalidChallengeStakeMin", { amount: MIN_STAKE }));
      return;
    }
    if (!acceptTrustlineGate.allowed) {
      toast.error(tWallet(acceptTrustlineGate.messageKey));
      return;
    }

    await withTxLock(async (wallet) => {
    flushSync(() => {
      setActionLoading("accept");
    });
    try {
      const liveVS = await getVS(vsId, {
        inviteKey,
        viewerAddress: address,
      });

      if (!liveVS) {
        void fetchVS();
        toast.error(t("notFound"));
        return;
      }

      void fetchVS();

      if (!isVSJoinable(liveVS, address)) {
        toast.error(t("challengeUnavailable"));
        return;
      }

      track({
        event: "stake_started",
        envelope: {
          source_surface: "vs_detail",
          claim_id: vsId,
          category: liveVS.category,
          subject_type: canonicalMode.subjectType,
          settlement_mode: canonicalMode.settlementMode,
          modifiers: canonicalMode.productModifiers,
          tx_status: "submitted",
        },
        properties: { stake_bucket: stakeBucket(challengeStakeValue) },
        address,
      });

      const result = await acceptVS(wallet, vsId, challengeStakeValue, inviteKey);
      const isPending = "pending" in result && Boolean(result.pending);

      if (!isPending) {
        track({
          event: "stake_confirmed",
          envelope: {
            source_surface: "vs_detail",
            claim_id: vsId,
            category: liveVS.category,
            subject_type: canonicalMode.subjectType,
            settlement_mode: canonicalMode.settlementMode,
            modifiers: canonicalMode.productModifiers,
            tx_status: "confirmed",
          },
          properties: { stake_bucket: stakeBucket(challengeStakeValue) },
          address,
          idempotencyKey: idempotencyKey(["stake_confirmed", vsId, result.txHash]),
        });
      }

      toast.success(
        isPending
          ? t("submittedPending")
          : t("joinedToast", {
              amount: challengeStakeValue,
              total: getVSTotalPot(liveVS) + challengeStakeValue,
            }),
        txToastOptions(result)
      );
      if (isPending && result.txHash) {
        // The wallet saw the submission but the outcome is unobserved: record
        // the tx identity so the recovery panel can run bounded status checks
        // and no second stake is offered in the meantime.
        beginChallengeRecovery({
          txHash: result.txHash,
          stakeAmount: challengeStakeValue,
        });
      } else if (!isPending) {
        // A confirmed new stake supersedes any previously resolved record.
        dismissChallengeRecovery();
      }
      resetChallengeStake();
      fetchVS();
    } catch (err: any) {
      const uncertainTxHash = challengeRecoveryTxHashFromError(err);
      track({
        event: "stake_failed",
        envelope: {
          source_surface: "vs_detail",
          claim_id: vsId,
          category: display.category,
          subject_type: canonicalMode.subjectType,
          settlement_mode: canonicalMode.settlementMode,
          modifiers: canonicalMode.productModifiers,
          tx_status: "failed",
        },
        properties: {
          failure_stage: uncertainTxHash ? "submit_uncertain" : "submit",
        },
        address,
      });
      if (uncertainTxHash) {
        // The submission carries a tx hash: it may have landed. Recovery checks
        // the hash instead of inviting a blind resubmit.
        beginChallengeRecovery({
          txHash: uncertainTxHash,
          stakeAmount: challengeStakeValue,
        });
        toast.error(t("stakeUncertainToast"));
      } else {
        toast.error(err.message || t("errorAccepting"));
      }
    }
    });
  }

  async function handleResolve() {
    await withTxLock(async (wallet) => {
    setActionLoading("resolve");
    if (willTriggerResolution) {
      setResolvePhase(0);
    }

    // La terminal escribe letra por letra (muy lento). Sincronizamos el avance de fase
    // para que se puedan ver TODAS las líneas (incl. "Fetching results..." y "Issuing verdict").
    // Si el tx on-chain tarda menos, mantenemos la terminal visible hasta terminar la animación.
    const phaseTimers = willTriggerResolution
      ? RESOLVE_PHASE_MS.map((ms, i) => setTimeout(() => setResolvePhase(i + 1), ms))
      : [];
    const startedAt = Date.now();

    try {
      const result = await requestResolveVS(wallet, vsId, inviteKey);
      const isPending = "pending" in result && Boolean(result.pending);
      setHasAttemptedResolve(willTriggerResolution);
      toast.success(
        willTriggerResolution
          ? isPending
            ? t("submittedPending")
            : t("requestResolveTriggered")
          : t("requestResolveStored"),
        txToastOptions(result)
      );

      if (willTriggerResolution && isPending) {
        // Consensus hasn't finished — don't reveal the verdict yet.
        // A useEffect watches vs.state and will auto-reveal once the
        // data transitions to "resolved" (with a winner).
        pendingResolveRef.current = true;
        setPendingResolveTxHash(result.explorerTxHash || result.txHash || null);
      } else if (willTriggerResolution) {
        setPendingResolveTxHash(null);
        setShowVerdict(true);
        setTimeout(() => setShowVerdict(false), VERDICT_OVERLAY_MS);
      } else {
        setPendingResolveTxHash(null);
      }
      void fetchVS();

      // Asegura que la terminal tenga tiempo de mostrar la última línea aunque la tx
      // se confirme rápido.
      const elapsed = Date.now() - startedAt;
      if (willTriggerResolution && elapsed < RESOLVE_ANIM_TOTAL_MS) {
        await new Promise((r) => setTimeout(r, RESOLVE_ANIM_TOTAL_MS - elapsed));
      }
    } catch (err: any) {
      toast.error(err.message || t("errorResolving"));
    } finally {
      phaseTimers.forEach(clearTimeout);
      if (willTriggerResolution) {
        setResolvePhase(-1);
      }
    }
    });
  }

  async function handleResetResolveRequest() {
    await withTxLock(async (wallet) => {
    setActionLoading("resetResolve");
    try {
      const result = await resetVSResolveRequest(wallet, vsId, inviteKey);
      toast.success(t("resetResolveRequestSuccess"), txToastOptions(result));
      void fetchVS();
    } catch (err: any) {
      toast.error(err.message || t("resetResolveRequestError"));
    }
    });
  }

  async function handleCancel() {
    await withTxLock(async (wallet) => {
    setActionLoading("cancel");
    try {
      const result = await cancelVS(wallet, vsId, inviteKey);
      const isPending = "pending" in result && Boolean(result.pending);
      toast.success(
        isPending ? t("submittedPending") : t("cancelledToast"),
        txToastOptions(result)
      );
      fetchVS();
    } catch (err: any) {
      toast.error(err.message || t("errorCancelling"));
    }
    });
  }

  return (
    <>
      {/* Funnel instrumentation. Lives in a child so the hooks stay
          unconditional despite this component's early returns; the hooks
          themselves own de-duplication, so typing a stake does not emit an
          event per keystroke. */}
      <MarketAnalytics
        claimId={vsId}
        mode={canonicalMode}
        category={display.category}
        address={address}
        surface="vs_detail"
        preview={
          stakePreview
            ? {
                stake: challengeStakeValue,
                // Analytics deliberately keeps the GROSS formula output for the
                // money fields. `stake_previewed` / `payout_preview_seen` have
                // always meant "the pool/fixed-odds math for this stake", and
                // re-pointing them at the fee-adjusted net would silently change
                // every historical comparison. `feeAdjusted` records which figure
                // the user actually saw, so the two are never conflated; a future
                // schema version can carry both if a dashboard needs the net.
                totalReturn: stakePreview.gross.totalReturn,
                netProfit: stakePreview.gross.netProfit,
                upsideBps: stakePreview.gross.upsideBps,
                isLowUpside: stakePreview.isLowUpside,
                feeAdjusted: stakePreview.feeAdjusted,
              }
            : null
        }
        settlementReturn={{
          resolved: display.state === "resolved",
          isParticipant,
        }}
      />

      {/* Verdict Reveal Overlay — finality moment */}
      <AnimatePresence>
        {showVerdict && (
          <motion.div
            variants={verdictOverlay}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-pv-bg/90 backdrop-blur-sm"
          >
            <motion.div
              variants={verdictWord}
              className="font-display text-[clamp(3rem,15vw,8rem)] font-bold uppercase text-pv-emerald drop-shadow-[0_0_40px_rgba(51,79,169,0.4)]"
            >
              SETTLED.
            </motion.div>
            <motion.div
              variants={verdictResult}
              className="mt-4 font-mono text-sm text-pv-muted"
            >
              {winnerTitle}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <PageTransition>
        <div className="relative z-[1] mx-auto w-full max-w-[1280px] px-4 pb-16 sm:px-6 sm:pb-20">
          <div className="mx-auto w-full min-w-0">
        <AnimatedItem>
          <Link
            href={isConnected ? "/dashboard" : "/"}
            className="mb-6 inline-flex items-center gap-2 rounded-lg border border-transparent px-2 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-pv-muted transition-[color,border-color,background-color] hover:border-pv-ink/[0.1] hover:bg-pv-ink/[0.04] hover:text-pv-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-emerald/30 sm:mb-8 sm:px-3 sm:text-[11px]"
          >
            <ArrowLeft size={14} className="shrink-0 opacity-80" aria-hidden />
            {tc("back")}
          </Link>
        </AnimatedItem>

        <AnimatedItem>
          <div className="mb-6 -mx-4 sm:mb-8 sm:-mx-6">
            <BlueprintHeading>{t("heroLead")}</BlueprintHeading>
            <p className="mt-3 text-center font-mono text-[10px] font-bold uppercase tracking-[0.28em] text-pv-emerald sm:text-xs">
              {t("subtitle")}
            </p>
          </div>
        </AnimatedItem>

        {(isSampleVS ? display.state : vs.state) !== "cancelled" && (
          <AnimatedItem>
            <ProgressBar
              canonicalState={isSampleVS ? display.state : vs.state}
              visualStepIndex={isSampleVS ? designLifecycleStep : null}
              interactive={isSampleVS}
              onStepSelect={
                isSampleVS
                  ? (index) => {
                      setDesignLifecycleStep(index);
                      if (index !== 3) setDesignResolvedOutcome("creator");
                    }
                  : undefined
              }
            />
            {isSampleVS && (
              <div className="mb-8 flex flex-col gap-2 border-b border-pv-ink/[0.06] pb-6 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <p className="max-w-3xl text-[10px] leading-relaxed text-pv-muted sm:text-[11px]">
                  {t("designPreviewLifecycleHint")}
                </p>
                {designLifecycleStep !== null ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDesignLifecycleStep(null);
                      setDesignResolvedOutcome("creator");
                    }}
                    className="shrink-0 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-pv-emerald/90 underline-offset-2 hover:underline sm:text-right sm:text-[11px]"
                  >
                    {t("designPreviewReset")}
                  </button>
                ) : null}
              </div>
            )}
          </AnimatedItem>
        )}

        {/* Freshness pill + manual refresh — only for real on-chain markets, not sample previews */}
        {!isSampleVS && (vsFreshness || refreshing) && (
          <AnimatedItem>
            <div className="mb-6 sm:mb-8">
              <CacheFreshnessControls
                freshness={vsFreshness}
                onRefresh={refreshVs}
                refreshing={refreshing}
              />
            </div>
          </AnimatedItem>
        )}

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-start lg:gap-10">
          <div className="min-w-0 lg:col-span-8">
        {display.state === "resolved" && resolvePhase === -1 && (
          <>
            <AnimatedItem>
              <ProvenStamp
                title={winnerTitle}
                amountLabel={winnerAmountLabel}
                resolutionSummary={display.resolution_summary}
                resultTone={provenResultTone}
              />
            </AnimatedItem>
            <AnimatedItem>
              <div className="mb-6 sm:mb-8">
                <SettlementExplanationCard vs={display} />
              </div>
            </AnimatedItem>
          </>
        )}

        {vsId > 0 && (
          <AnimatedItem>
            {/* Above the council widget: sharing is what a reader does right after
                reading the market, not after scrolling past everything else. */}
            <div className="mb-6 flex justify-end sm:mb-8">
              <ShareMarket
                claimId={vsId}
                question={display.question}
                creatorPosition={display.creator_position}
              />
            </div>
          </AnimatedItem>
        )}

        {vsId > 0 && (
          <AnimatedItem>
            <div className="mb-6 sm:mb-8">
              <CouncilVoteWidget claimId={vsId} />
            </div>
          </AnimatedItem>
        )}

        {((actionLoading === "resolve" && willTriggerResolution) ||
          (isSampleVS && designLifecycleStep === 2)) && (
          <AnimatedItem>
            <ResolutionTerminal
              phase={actionLoading === "resolve" ? resolvePhase : 4}
              url={display.resolution_url}
            />
          </AnimatedItem>
        )}

        {(display.state !== "resolved" || resolvePhase !== -1) &&
          actionLoading !== "resolve" && (
          <AnimatedItem>
            <Stage glow="both" className="mb-6 border border-pv-ink/[0.10] sm:mb-8">
              <div className="relative">
                <div className="relative z-[1]">
              <div className="p-5 sm:p-8">
                <div className="mb-5 flex items-center justify-between sm:mb-6">
                  {display.state === "open" && !isCreator ? (
                    <div className={DUEL_STATUS_FUCHSIA_PILL_CLASS}>
                      {t("challengesYou", { address: shortenAddress(display.creator) })}
                    </div>
                  ) : display.state === "accepted" ? (
                    <div className={DUEL_STATUS_FUCHSIA_PILL_CLASS}>
                      {tBadges("accepted")}
                    </div>
                  ) : (
                    <Badge status={display.state} large />
                  )}
                  <span className="font-mono text-[11px] text-pv-muted">#{vs.id}</span>
                </div>

                <h2 className="mb-6 font-display text-[clamp(28px,8.5vw,46px)] font-bold leading-[0.92] tracking-tight sm:mb-7">
                  {display.question}
                </h2>

                <div className="mb-6 flex flex-col overflow-hidden rounded-xl border border-pv-ink/[0.12] sm:flex-row">
                  <div className="flex-1 p-4 bg-pv-cyan/[0.04]">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-pv-cyan/35 bg-pv-surface2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={openPeepsAvatar(`creator-${display.creator}`)}
                          alt=""
                          className="h-full w-full object-cover object-top opacity-95"
                        />
                      </div>
                      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-pv-cyan/60 sm:text-[11px]">
                        {t("creator")}
                      </div>
                    </div>
                    <div className="text-sm font-semibold">
                      <ProfileLink address={display.creator} />
                      {isCreator && (
                        <span className="text-pv-emerald text-[10px] ml-1">{t("you")}</span>
                      )}
                    </div>
                    <div className="text-xs text-pv-cyan mt-1">{display.creator_position}</div>
                  </div>

                  <div
                    className="h-px w-full shrink-0 bg-pv-ink/[0.06] sm:h-auto sm:w-px sm:self-stretch"
                    aria-hidden
                  />

                  <div className="flex-1 p-4 bg-pv-fuch/[0.04]">
                    {isOpen ? (
                      <div className="text-center py-2">
                        <div className="w-7 h-7 border-2 border-dashed border-pv-ink/[0.2] flex items-center justify-center mx-auto mb-2 text-pv-muted font-bold text-xs">
                          ?
                        </div>
                        <div className="text-xs text-pv-muted italic">{t("waitingRival")}</div>
                      </div>
                    ) : challengerCount === 1 ? (
                      <>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-pv-fuch/35 bg-pv-surface2">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={openPeepsAvatar(`challenger-${display.opponent}`)}
                              alt=""
                              className="h-full w-full object-cover object-top opacity-95"
                            />
                          </div>
                          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-pv-fuch/60 sm:text-[11px]">
                            {t("rival")}
                          </div>
                        </div>
                        <div className="text-sm font-semibold">
                          <ProfileLink address={display.opponent} />
                          {isOpponent && (
                            <span className="text-pv-emerald text-[10px] ml-1">{t("you")}</span>
                          )}
                        </div>
                        <div className="text-xs text-pv-fuch mt-1">{display.opponent_position}</div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 mb-2">
                          <Users size={15} className="text-pv-fuch" />
                          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-pv-fuch/60 sm:text-[11px]">
                            {t("challengerSide")}
                          </div>
                        </div>
                        <div className="text-sm font-semibold">
                          {t("challengersJoined", { count: challengerCount })}
                        </div>
                        <div className="text-xs text-pv-fuch mt-1">{display.counter_position}</div>
                        <div className="text-xs text-pv-muted mt-2">
                          {t("slotsFilled", { count: challengerCount, total: maxChallengers })}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Métricas: mobile-first — 1 col → 2 (sm) → 4 (lg); panel unificado + celdas con min-h táctil */}
                <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-pv-ink/[0.1] bg-pv-ink/[0.07] p-px shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] sm:grid-cols-2 lg:grid-cols-4">
                  {/* Misma estructura en las 4: título arriba (shrink-0) + valor abajo (mt-auto) para alinear filas */}
                  <div className="flex min-h-[5.75rem] min-w-0 flex-col bg-pv-bg/55 px-4 py-3.5 sm:min-h-[6rem] sm:px-4 sm:py-4">
                    <p className="shrink-0 text-[10px] font-bold uppercase leading-snug tracking-[0.16em] text-pv-muted/90 sm:text-[11px] sm:tracking-[0.18em]">
                      {t("pool")}
                    </p>
                    <div className="mt-auto min-w-0 pt-2 font-mono text-base font-bold tabular-nums leading-tight text-pv-gold sm:text-lg lg:text-xl">
                      {formatUsdc(pool)}
                    </div>
                  </div>
                  <div className="flex min-h-[5.75rem] min-w-0 flex-col bg-pv-bg/55 px-4 py-3.5 sm:min-h-[6rem] sm:px-4 sm:py-4">
                    <p className="shrink-0 text-[10px] font-bold uppercase leading-snug tracking-[0.16em] text-pv-muted/90 sm:text-[11px] sm:tracking-[0.18em]">
                      {t("creatorStake")}
                    </p>
                    <div className="mt-auto min-w-0 pt-2 font-mono text-base font-bold tabular-nums leading-tight text-pv-cyan sm:text-lg lg:text-xl">
                      {formatUsdc(display.creator_stake ?? display.stake_amount)}
                    </div>
                  </div>
                  <div className="flex min-h-[5.75rem] min-w-0 flex-col bg-pv-bg/55 px-4 py-3.5 sm:min-h-[6rem] sm:px-4 sm:py-4">
                    <p className="shrink-0 text-[10px] font-bold uppercase leading-snug tracking-[0.16em] text-pv-muted/90 sm:text-[11px] sm:tracking-[0.18em]">
                      {t("deadline")}
                    </p>
                    <div className="mt-auto min-w-0 pt-2">
                      <LiveDeadline
                        deadline={display.deadline}
                        phase={
                          display.state === "open" ? "open"
                            : display.state === "accepted" ? "locked"
                            : display.state === "resolved" ? "proven"
                            : undefined
                        }
                        compact
                        showPhaseBadge={false}
                        timeClassName="text-base sm:text-lg lg:text-xl"
                      />
                    </div>
                  </div>
                  <div className="flex min-h-[5.75rem] min-w-0 flex-col bg-pv-bg/55 px-4 py-3.5 sm:min-h-[6rem] sm:px-4 sm:py-4">
                    <p className="shrink-0 text-[10px] font-bold uppercase leading-snug tracking-[0.16em] text-pv-muted/90 sm:text-[11px] sm:tracking-[0.18em]">
                      {t("slots")}
                    </p>
                    <div className="mt-auto min-w-0 pt-2 font-mono text-base font-bold tabular-nums leading-tight text-pv-fuch sm:text-lg lg:text-xl">
                      {challengerCount}/{maxChallengers}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-pv-ink/[0.08] px-5 py-3 sm:px-8">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-pv-emerald shadow-[0_0_8px_rgba(51,79,169,0.6)]" />
                  <span className="text-xs text-pv-muted">{t("provenVerifies")}</span>
                </div>
                {display.resolution_url && (
                  <a
                    href={
                      display.resolution_url.startsWith("http")
                        ? display.resolution_url
                        : `https://${display.resolution_url}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-pv-muted hover:text-pv-cyan transition-colors flex items-center gap-1"
                  >
                    <ExternalLink size={10} />
                    {t("source")}
                  </a>
                )}
              </div>
                </div>
              </div>
            </Stage>
          </AnimatedItem>
        )}

        {shouldMountVsXmtpPanelOnDetailPage(vs) && (
          <AnimatedItem>
            <div
              id={VS_XMTP_CHAT_ANCHOR_ID}
              className="scroll-mt-[calc(3.5rem+12px)]"
            >
              <VsXmtpPanel vs={display} />
            </div>
          </AnimatedItem>
        )}

        <AnimatedItem>
          <GlassCard
            glass
            glow="none"
            noPad
            className="mb-6 w-full overflow-hidden !rounded-2xl border border-pv-ink/[0.12] sm:mb-8"
          >
            <button
              type="button"
              onClick={() => setMarketTermsOpen((open) => !open)}
              aria-expanded={marketTermsOpen}
              aria-controls={marketTermsPanelId}
              className="flex w-full min-h-[3.25rem] items-start justify-between gap-3 px-5 py-5 text-left transition-colors hover:bg-pv-ink/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-pv-emerald/35 sm:min-h-0 sm:gap-4 sm:px-8 sm:py-6"
            >
              <div className="flex min-w-0 gap-3 sm:gap-3.5">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-pv-emerald/10 text-pv-emerald"
                  aria-hidden
                >
                  <SlidersHorizontal size={16} strokeWidth={2} />
                </span>
                <div className="min-w-0 space-y-1">
                  <h3
                    id={marketTermsHeadingId}
                    className="font-display text-xs font-bold uppercase tracking-[0.18em] text-pv-text sm:tracking-[0.2em]"
                  >
                    {t("marketTerms")}
                  </h3>
                  <p className="text-[10px] leading-relaxed text-pv-muted sm:text-[11px]">
                    {t("marketTermsHint")}
                  </p>
                </div>
              </div>
              <ChevronDown
                size={20}
                className={`shrink-0 text-pv-muted transition-transform duration-200 ease-out ${
                  marketTermsOpen ? "rotate-180" : ""
                }`}
                aria-hidden
              />
            </button>

            <motion.div
              initial={false}
              animate={{
                height: marketTermsOpen ? "auto" : 0,
                opacity: marketTermsOpen ? 1 : 0,
              }}
              transition={{
                height: {
                  duration: 0.34,
                  ease: [0.25, 0.46, 0.45, 0.94],
                },
                opacity: {
                  duration: 0.22,
                  ease: [0.25, 0.1, 0.25, 1],
                },
              }}
              className={`overflow-hidden ${!marketTermsOpen ? "pointer-events-none" : ""}`}
              aria-hidden={!marketTermsOpen}
            >
              <div
                id={marketTermsPanelId}
                role="region"
                aria-labelledby={marketTermsHeadingId}
                className="border-t border-pv-ink/[0.08] px-5 pb-6 pt-5 sm:px-8 sm:pb-8 sm:pt-6"
              >
                <div className="grid grid-cols-1 gap-2.5 text-sm sm:grid-cols-2 sm:gap-3">
                  <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                    <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                      {t("marketType")}
                    </div>
                    <div className="font-semibold">{t(`marketTypes.${marketType}`)}</div>
                  </div>
                  <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                    <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                      {t("oddsMode")}
                    </div>
                    <div className="font-semibold">{t(`oddsModes.${oddsMode}`)}</div>
                  </div>
                  <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                    <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                      {t("format")}
                    </div>
                    <div className="font-semibold">{t("headToHeadSummary")}</div>
                  </div>
                  <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                    <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                      {t("challengerCapacity")}
                    </div>
                    <div className="font-semibold">
                      {t("slotsFilled", { count: challengerCount, total: maxChallengers })}
                    </div>
                  </div>
                  <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                    <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                      {t("visibility")}
                    </div>
                    <div className="font-semibold">
                      {isPrivateVS ? t("visibilityPrivate") : t("visibilityPublic")}
                    </div>
                  </div>
                  {oddsMode === "fixed" && typeof display.challenger_payout_bps === "number" && (
                    <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4 sm:col-span-2">
                      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                        {t("fixedPayout")}
                      </div>
                      <div className="font-semibold">
                        {(display.challenger_payout_bps / 10000).toFixed(2)}x
                      </div>
                    </div>
                  )}
                  {display.handicap_line && (
                    <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4 sm:col-span-2">
                      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                        {t("handicapLine")}
                      </div>
                      <div className="font-semibold">{display.handicap_line}</div>
                    </div>
                  )}
                  {display.settlement_rule && (
                    <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4 sm:col-span-2">
                      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                        {t("settlementRule")}
                      </div>
                      <div className="font-semibold leading-relaxed">{display.settlement_rule}</div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </GlassCard>
        </AnimatedItem>

        {null}

        {!isSampleVS ? (
          <AnimatedItem>
            <div className="flex flex-col gap-3 sm:gap-4">
              {missingPrivateInvite && (
                <GlassCard glass className="!rounded-2xl border border-pv-ink/[0.12]">
                  <div className="mb-2 text-sm font-semibold text-pv-emerald">
                    {t("privateInviteRequired")}
                  </div>
                  <p className="text-sm text-pv-muted">{t("privateInviteHint")}</p>
                </GlassCard>
              )}

              {/* Uncertain challenge submission: show the tx identity and
                  bounded status checks, and keep the stake action hidden until
                  the first outcome is observed (or the record expires). */}
              {challengeRecovery && (
                <ChallengeRecoveryPanel
                  record={challengeRecovery}
                  explorerUrl={getExplorerTxUrl(challengeRecovery.txHash)}
                  checking={challengeRecoveryChecking}
                  onCheckStatus={() => void checkChallengeRecovery()}
                  onDismiss={dismissChallengeRecovery}
                />
              )}

              {/* A brand-new Stellar account cannot hold USDC until it trusts the
                  issuer, so the first-ever stake needs this once. Renders nothing
                  for an account that is already set up. */}
              {canAccept && !challengeRecoveryBlocking && (
                <UsdcTrustlineGate trustline={trustline} />
              )}

              {canAccept && !challengeRecoveryBlocking && (
                <GlassCard glass className="!rounded-2xl border border-pv-ink/[0.12]">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,12rem)] sm:items-end">
                      <Input
                        label={t("challengeStake")}
                        type="number"
                        min={MIN_STAKE}
                        step="1"
                        value={challengeStake}
                        onChange={(event) => setChallengeStake(event.target.value)}
                        className="h-[3.25rem]"
                      />
                      <Button
                        variant="fuch"
                        onClick={handleAccept}
                        loading={actionLoading === "accept"}
                        disabled={!hasValidChallengeStake || !acceptTrustlineGate.allowed}
                        className="h-[3.25rem] w-full"
                      >
                        {actionLoading === "accept"
                          ? t("accepting")
                          : t("acceptAndStake", {
                              amount: hasValidChallengeStake ? challengeStakeValue : vs.stake_amount,
                            })}
                      </Button>
                    </div>
                    {stakePreview && (
                      <div className="mt-4 overflow-hidden rounded-xl border border-pv-ink/[0.1] bg-pv-bg/35">
                        {/* Total return, returned principal and net profit are shown
                            separately — a single "payout" number reads as profit.
                            Every figure is after the claim's snapshotted fees when
                            they could be read, so `totalReturn` is what lands in the
                            wallet, which is what that word has always meant here. */}
                        <div className="grid grid-cols-1 gap-px bg-pv-ink/[0.07] p-px sm:grid-cols-2">
                          <div className="min-w-0 bg-pv-bg/70 px-3.5 py-3">
                            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                              {t("totalReturn")}
                            </div>
                            <div className="mt-1.5 font-mono text-sm font-bold tabular-nums text-pv-emerald sm:text-base">
                              {formatUsdc(stakePreview.netPayout)}
                            </div>
                            <div className="mt-1 font-mono text-[10px] tabular-nums text-pv-muted">
                              {stakePreview.netMultiple.toFixed(2)}× {t("totalReturnMultipleHint")}
                            </div>
                          </div>
                          <div className="min-w-0 bg-pv-bg/70 px-3.5 py-3">
                            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                              {t("returnedPrincipal")}
                            </div>
                            <div className="mt-1.5 font-mono text-sm font-bold tabular-nums text-pv-text sm:text-base">
                              {formatUsdc(stakePreview.principal)}
                            </div>
                          </div>
                          <div className="min-w-0 bg-pv-bg/70 px-3.5 py-3">
                            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                              {t("netProfit")}
                            </div>
                            <div className="mt-1.5 font-mono text-sm font-bold tabular-nums text-pv-fuch sm:text-base">
                              +{formatUsdc(stakePreview.netProfit)}
                            </div>
                          </div>
                          <div className="min-w-0 bg-pv-bg/70 px-3.5 py-3">
                            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                              {t("ifCreatorWins")}
                            </div>
                            <div className="mt-1.5 font-mono text-sm font-bold tabular-nums text-pv-cyan sm:text-base">
                              {formatUsdc(creatorPayoutPreview)}
                            </div>
                          </div>
                        </div>
                        {/* The fee is stated, not implied. When the snapshot could
                            not be read the gross is shown and labelled as such —
                            an unlabelled gross would read as take-home. */}
                        <div className="border-t border-pv-ink/[0.07] px-3.5 py-3 text-xs leading-relaxed">
                          {stakePreview.clamped ? (
                            <p className="text-pv-gold">{t("payoutFeeClamped")}</p>
                          ) : stakePreview.feeAdjusted ? (
                            <p className="text-pv-muted">
                              {t("payoutFeeLine", { fee: formatUsdc(stakePreview.totalFee) })}
                              {stakePreview.agentOwnerFee > 0
                                ? ` ${t("payoutFeeSplit", {
                                    platform: formatUsdc(stakePreview.platformFee),
                                    owner: formatUsdc(stakePreview.agentOwnerFee),
                                  })}`
                                : null}
                            </p>
                          ) : stakePreview.feeStatus === "loading" ? (
                            <p className="text-pv-muted">{t("payoutFeeChecking")}</p>
                          ) : (
                            <p className="text-pv-gold">{t("payoutFeeUnknown")}</p>
                          )}
                          <p className="mt-1 text-pv-muted">{t("principalGuarantee")}</p>
                        </div>
                        {isFixedOdds && (
                          <p
                            className={`border-t px-3.5 py-3 text-xs leading-relaxed ${
                              exceedsFixedCapacity
                                ? "border-red-500/30 bg-red-500/[0.07] text-red-300"
                                : "border-pv-ink/[0.07] text-pv-muted"
                            }`}
                          >
                            {exceedsFixedCapacity
                              ? t("fixedOddsOverCapacity", {
                                  max: formatUsdc(maxFixedStake),
                                })
                              : t("fixedOddsCapacity", {
                                  available: formatUsdc(availableLiquidity),
                                  max: formatUsdc(maxFixedStake),
                                })}
                          </p>
                        )}
                        {stakePreview.isLowUpside && (
                          <p className="border-t border-pv-gold/25 bg-pv-gold/[0.07] px-3.5 py-3 text-xs leading-relaxed text-pv-gold">
                            {t("lowUpsideWarning", {
                              stake: formatUsdc(stakePreview.principal),
                              profit: formatUsdc(stakePreview.netProfit),
                            })}
                          </p>
                        )}
                        {isPoolPreview ? (
                          <p className="px-3.5 py-3 text-xs leading-relaxed text-pv-muted">
                            {t("poolPayoutFormula", {
                              stake: formatUsdc(challengeStakeValue),
                              creatorStake: formatUsdc(creatorStake),
                              challengerStake: formatUsdc(totalChallengerStakeAfterJoin),
                            })}
                          </p>
                        ) : null}
                        <p className="border-t border-pv-ink/[0.07] px-3.5 py-3 text-xs leading-relaxed text-pv-muted">
                          {t("profitComesFromLosingSide")}
                        </p>
                      </div>
                    )}
                    <p className="text-xs text-pv-muted mt-3">
                      {canonicalMode.settlementMode === "fixed_odds" && stakePreview
                        ? t("challengeStakeHintFixed", { payout: stakePreview.netPayout })
                        : t("challengeStakeHintPool")}
                    </p>
                    <p className="text-xs text-pv-muted mt-2">
                      {t("minimumStakeHint", { amount: MIN_STAKE })}
                    </p>
                </GlassCard>
              )}

              {vs.state === "open" && !isConnected && !countdown.expired && (
                <Button onClick={connect}>{t("connectToAccept")}</Button>
              )}

              {!isSampleVS &&
                vs.state === "open" &&
                !hasAnyChallenger &&
                countdown.expired && (
                <GlassCard glass className="!rounded-2xl border border-pv-ink/[0.12]">
                  <div className="text-sm font-semibold text-pv-text">
                    {t("expiredNoRivalTitle")}
                  </div>
                  <p className="mt-1 text-sm text-pv-muted">
                    {isCreator
                      ? t("expiredNoRivalHintCreator")
                      : t("expiredNoRivalHintViewer")}
                  </p>
                </GlassCard>
              )}

              {display.state === "accepted" && countdown.expired && (
                <GlassCard glass className="!rounded-2xl border border-pv-ink/[0.12]">
                  <div className="space-y-4">
                    <div>
                      <div className="text-sm font-semibold text-pv-text">
                        {t("resolutionStatusTitle")}
                      </div>
                      <p className="mt-1 text-sm text-pv-muted">
                        {t("resolutionStatusHint")}
                      </p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                          {t("creatorRequestedLabel")}
                        </div>
                        <div className="mt-1 font-semibold">
                          {creatorRequestedResolve ? t("requestedStatus") : t("pendingStatus")}
                        </div>
                      </div>
                      <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                          {t("challengerRequestedLabel")}
                        </div>
                        <div className="mt-1 font-semibold">
                          {challengerRequestedResolve ? t("requestedStatus") : t("pendingStatus")}
                        </div>
                      </div>
                    </div>
                    <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                        {t("resolveAttemptsLabel")}
                      </div>
                      <div className="mt-1 font-semibold">{display.resolve_attempts ?? 0}</div>
                    </div>
                    {display.resolution_summary ? (
                      <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/40 p-4">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
                          {t("latestResolutionNote")}
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-pv-text/90">
                          {display.resolution_summary}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </GlassCard>
              )}

              {/* Settlement is pull-based for challengers, so a won market needs a
                  button or the escrow just sits there. See ClaimPayoutCard. */}
              <ClaimPayoutCard vs={display} onCollected={fetchVS} />

              {canRequestResolve && actionLoading !== "resolve" && (
                <GlassCard glass className="!rounded-2xl border border-pv-emerald/20">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-pv-text">
                        {showRetryResolve ? t("retryResolveVS") : t("requestResolveVS")}
                      </div>
                      <p className="mt-1 text-sm text-pv-muted">
                        {willTriggerResolution
                          ? t("requestResolveReadyHint")
                          : showRetryResolve
                            ? t("retryResolveHint")
                            : t("requestResolveHint")}
                      </p>
                    </div>
                    <Button variant="emerald" onClick={handleResolve}>
                      {showRetryResolve ? t("retryResolveVS") : t("requestResolveVS")}
                    </Button>
                  </div>
                </GlassCard>
              )}

              {canResetResolveRequest && actionLoading !== "resetResolve" && (
                <GlassCard glass className="!rounded-2xl border border-pv-ink/[0.12]">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-pv-text">
                        {t("resetResolveRequest")}
                      </div>
                      <p className="mt-1 text-sm text-pv-muted">
                        {t("resetResolveRequestHint")}
                      </p>
                    </div>
                    <Button variant="ghost" onClick={handleResetResolveRequest}>
                      {t("resetResolveRequest")}
                    </Button>
                  </div>
                </GlassCard>
              )}

              {display.state === "accepted" &&
                countdown.expired &&
                isParticipant &&
                userRequestedResolve &&
                !counterpartyRequestedResolve &&
                actionLoading !== "resolve" && (
                <GlassCard glass className="!rounded-2xl border border-pv-ink/[0.12] text-center">
                  <p className="text-sm text-pv-muted">{t("waitingOtherResolveRequest")}</p>
                </GlassCard>
              )}

              {display.state === "accepted" &&
                countdown.expired &&
                !isParticipant && (
                <GlassCard glass className="!rounded-2xl border border-pv-ink/[0.12] text-center">
                  <p className="text-sm text-pv-muted">{t("participantsMustRequestResolve")}</p>
                </GlassCard>
              )}

              {vs.state === "accepted" && !countdown.expired && actionLoading !== "resolve" && (
                <GlassCard glass className="!rounded-2xl border border-pv-ink/[0.12] text-center">
                  <p className="text-sm text-pv-muted">{t("waitingDeadline")}</p>
                </GlassCard>
              )}

              {vs.state === "open" &&
                isCreator && (
                <GlassCard
                  glass
                  noPad
                  glow="none"
                  className="!rounded-2xl border border-pv-ink/[0.12]"
                >
                  <div className="space-y-3 p-5 sm:p-6">
                    <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-pv-text">
                      <Share2 size={14} className="shrink-0 text-pv-cyan" aria-hidden />
                      {isPrivateVS
                        ? t("sendPrivateLink")
                        : t("sendLink")}
                    </div>
                    {isPrivateVS && !inviteKey ? (
                      <p className="text-sm text-pv-muted">{t("privateLinkUnavailable")}</p>
                    ) : (
                      <>
                        <label
                          className="block text-left text-[10px] font-bold uppercase tracking-[0.16em] text-pv-muted"
                          htmlFor="vs-detail-share-url"
                        >
                          {t("shareLinkLabel")}
                        </label>
                        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-stretch sm:gap-3">
                          <input
                            id="vs-detail-share-url"
                            readOnly
                            value={shareUrl}
                            className="form-field-pv min-h-[3rem] flex-1 break-all font-mono text-[11px] leading-snug sm:min-h-0 sm:text-xs"
                          />
                          <Button
                            type="button"
                            variant="primary"
                            fullWidth={false}
                            onClick={async () => {
                              await navigator.clipboard.writeText(shareUrl);
                              setCopied(true);
                              toast.success(tc("copied"));
                              setTimeout(() => setCopied(false), 2000);
                            }}
                            className="w-full shrink-0 rounded-xl py-3.5 font-display text-xs font-bold uppercase tracking-widest sm:w-auto sm:min-w-[8.5rem]"
                          >
                            {copied ? (
                              <Check className="size-4 shrink-0" aria-hidden />
                            ) : (
                              <Copy className="size-4 shrink-0" aria-hidden />
                            )}
                            {copied ? tc("copied") : tc("copy")}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                </GlassCard>
              )}

              {canCancel && (
                <Button
                  variant="danger"
                  onClick={handleCancel}
                  loading={actionLoading === "cancel"}
                >
                  {actionLoading === "cancel" ? t("cancelling") : t("cancelVS")}
                </Button>
              )}
            </div>
          </AnimatedItem>
        ) : (
          <AnimatedItem>
            <GlassCard
              glass
              glow="none"
              noPad
              className="!rounded-2xl !border-2 !border-dashed !border-pv-ink/[0.18] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]"
            >
              <div className="p-5 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-4">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-pv-ink/[0.1] bg-pv-ink/[0.03] text-pv-muted"
                    aria-hidden
                  >
                    <FlaskConical size={18} strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                      <h3 className="font-display text-xs font-bold uppercase tracking-[0.18em] text-pv-text sm:tracking-[0.2em]">
                        {t("sampleModeTitle")}
                      </h3>
                      <span className="inline-flex shrink-0 rounded border border-pv-ink/[0.12] bg-pv-ink/[0.04] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-pv-muted sm:text-[10px] sm:tracking-[0.22em]">
                        {t("sampleModeDemoBadge")}
                      </span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-pv-muted sm:text-xs">
                      {t("sampleModeBody")}
                    </p>
                    <div className="pt-0.5">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          fullWidth={false}
                          onClick={() => {
                            setDesignLifecycleStep(4);
                            setDesignResolvedOutcome("creator");
                          }}
                          className="w-full !border-pv-ink/[0.1] !bg-pv-ink/[0.03] !py-2 !px-3 !text-[10px] !font-semibold !text-pv-muted !shadow-none hover:!border-pv-ink/[0.16] hover:!bg-pv-ink/[0.05] hover:!text-pv-text sm:w-auto sm:!px-3.5 sm:!text-[11px]"
                        >
                          {tBadges("cancelled")}
                        </Button>

                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          fullWidth={false}
                          onClick={() => {
                            setDesignLifecycleStep(3);
                            setDesignResolvedOutcome((prev) =>
                              prev === "challengers" ? "creator" : "challengers"
                            );
                          }}
                          className="w-full !border-pv-ink/[0.1] !bg-pv-ink/[0.03] !py-2 !px-3 !text-[10px] !font-semibold !text-pv-muted !shadow-none hover:!border-pv-ink/[0.16] hover:!bg-pv-ink/[0.05] hover:!text-pv-text sm:w-auto sm:!px-3.5 sm:!text-[11px]"
                        >
                          {designResolvedOutcome === "challengers"
                            ? tBadges("lost")
                            : tBadges("won")}
                        </Button>

                        <Link
                          href="/vs/create"
                          className="inline-block w-full sm:w-auto"
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            fullWidth={false}
                            className="w-full !border-pv-ink/[0.1] !bg-pv-ink/[0.03] !py-2 !px-3 !text-[10px] !font-semibold !text-pv-muted !shadow-none hover:!border-pv-ink/[0.16] hover:!bg-pv-ink/[0.05] hover:!text-pv-text sm:w-auto sm:!px-3.5 sm:!text-[11px]"
                          >
                            {t("sampleModeCTA")}
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </GlassCard>
          </AnimatedItem>
        )}
          </div>

          <aside className="min-w-0 lg:col-span-4 text-pv-text">
            <AnimatedItem>
              <div className="flex flex-col gap-6 lg:sticky lg:top-24">
                {(display.state === "open" || display.state === "accepted") && (
                  <ClaimStrengthCard
                    className="lg:min-h-[20rem]"
                    input={{
                      question: display.question,
                      creator_position: display.creator_position,
                      opponent_position: display.opponent_position,
                      resolution_url: display.resolution_url,
                      settlement_rule: display.settlement_rule ?? "",
                      category: display.category,
                      deadline: display.deadline,
                    }}
                  />
                )}
                <VsChallengersCard
                  challengers={challengers}
                  counterPosition={display.counter_position ?? ""}
                  address={address}
                  challengerCount={challengerCount}
                  maxChallengers={maxChallengers}
                  showLoadMore={isSampleVS && designLifecycleStep !== null}
                />
                {/* Sample markets have no chain history, so there is no reasoning to
                    fetch — the component would render nothing anyway, but skipping it
                    avoids a pointless request on every design preview. */}
                {!isSampleVS && vs.id > 0 && (
                  <AnimatedItem>
                    <ReasoningFeed claimId={vs.id} />
                  </AnimatedItem>
                )}
                {showRivalrySection && (
                  <AnimatedItem>
                    <GlassCard
                      glass
                      noPad
                      className="!rounded-2xl border border-pv-ink/[0.12]"
                    >
                      <div className="p-5 sm:p-6">
                        <div className="mb-4 flex flex-col gap-3 sm:mb-5">
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-3">
                              <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-pv-emerald/85">
                                {t("rivalry")}
                              </h2>
                              {/* Only shown once a round has actually been decided: a
                                  0-0 badge reads as a played draw. */}
                              {seriesView.scoreLabel && (
                                <span className="rounded-md border border-pv-ink/[0.12] bg-pv-ink/[0.03] px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums text-pv-text">
                                  {seriesView.scoreLabel}
                                </span>
                              )}
                            </div>
                            <p className="mt-2 text-sm leading-relaxed text-pv-muted sm:mt-3">
                              {t("rivalryHint")}
                            </p>
                          </div>

                          {!isSampleVS &&
                            (vs.state === "resolved" || vs.state === "cancelled") && (
                              <div className="flex w-full flex-wrap justify-center gap-2">
                                <Link href={`/vs/create?rematch=${vs.id}`}>
                                  <Button variant="emerald" fullWidth={false} size="sm">
                                    {t("createRematch")}
                                  </Button>
                                </Link>
                                {/* Best-of is a target the two sides agree on, not
                                    chain state — nothing on chain stores it, and the
                                    read-index must stay a pure fold of chain events.
                                    So these carry the intent into the create screen
                                    and the score below is what actually settles it. */}
                                {[3, 5].map((bestOf) => (
                                  <Link
                                    key={bestOf}
                                    href={`/vs/create?rematch=${vs.id}&bestOf=${bestOf}`}
                                  >
                                    <Button variant="ghost" fullWidth={false} size="sm">
                                      {t("bestOfCta", { n: bestOf })}
                                    </Button>
                                  </Link>
                                ))}
                              </div>
                            )}
                        </div>

                        {!isRivalryDataReady || rivalryLoading ? (
                          <RivalryPanelSkeleton />
                        ) : seriesView.rows.length > 1 ? (
                          <div className="rounded-xl border border-pv-ink/[0.08] bg-pv-bg/30 p-4 sm:p-5">
                            <div className="space-y-3">
                              {visibleSeriesRows.map((row) => {
                                const entry = row.claim;
                                const inner = (
                                  <div
                                    className={`${RIVALRY_ITEM_BASE_CLASS} ${
                                      row.isCurrent
                                        ? RIVALRY_ITEM_ACTIVE_CLASS
                                        : "border-pv-ink/[0.1]"
                                    }`}
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                                      <div className="flex items-center gap-2 text-pv-muted text-[10px] font-bold uppercase tracking-[0.14em]">
                                        <GitBranch size={12} />
                                        {/* From the parent chain, not the array index —
                                            a missing ancestor must not renumber rounds. */}
                                        {t("roundLabel", { round: row.round })}
                                      </div>
                                      <Badge status={entry.state} compact />
                                    </div>
                                    <div className="font-semibold text-[14px] leading-snug sm:text-[15px]">
                                      {entry.question}
                                    </div>
                                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-pv-muted">
                                      <span>
                                        {t("pool")}: {formatUsdc(getVSTotalPot(entry))}
                                      </span>
                                      {/* A refund is shown as a refund. Calling it a draw
                                          would imply a result the escrow never paid. */}
                                      {row.refunded ? (
                                        <span className="font-semibold uppercase tracking-[0.12em] text-pv-muted/80">
                                          {t("seriesRefunded")}
                                        </span>
                                      ) : row.winner !== "none" ? (
                                        <span className="font-semibold uppercase tracking-[0.12em] text-pv-emerald/85">
                                          {row.winner === "creator"
                                            ? t("seriesCreatorWon")
                                            : t("seriesChallengersWon")}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                );

                                return isSampleVS ? (
                                  <div key={entry.id} className="block">
                                    {inner}
                                  </div>
                                ) : (
                                  <Link
                                    key={entry.id}
                                    href={`/vs/${entry.id}`}
                                    className="block"
                                  >
                                    {inner}
                                  </Link>
                                );
                              })}
                            </div>

                            {seriesView.refundedRounds > 0 && (
                              <p className="pt-3 text-[11px] leading-relaxed text-pv-muted/80">
                                {t("seriesRefundNote", { count: seriesView.refundedRounds })}
                              </p>
                            )}

                            {/* Anyone can rematch a settled parent, so a rivalry can
                                fork. Said out loud rather than folded into the score,
                                which would let abandoned branches pad a record. */}
                            {seriesView.branchCount > 0 && (
                              <p className="pt-2 text-[11px] leading-relaxed text-pv-muted/80">
                                {t("seriesBranchNote", { count: seriesView.branchCount })}
                              </p>
                            )}

                            {canLoadMoreRivalry ? (
                              <div className="pt-3 text-center">
                                <button
                                  type="button"
                                  aria-expanded={isRivalryExpanded}
                                  onClick={() => setIsRivalryExpanded(true)}
                                  className="inline-flex items-center justify-center rounded-lg border border-pv-ink/[0.06] bg-pv-ink/[0.01] px-3 py-2 text-xs font-semibold text-pv-muted transition-[background-color,border-color] hover:border-pv-ink/[0.1] hover:bg-pv-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-emerald/25"
                                >
                                  Load more
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="rounded-xl border border-dashed border-pv-ink/[0.14] bg-pv-bg/30 p-4 text-center sm:p-5">
                            <p className="text-sm leading-relaxed text-pv-muted">
                              {t("rivalryEmpty")}
                            </p>
                          </div>
                        )}
                      </div>
                    </GlassCard>
                  </AnimatedItem>
                )}
              </div>
            </AnimatedItem>
          </aside>
        </div>
        </div>
        </div>
      </PageTransition>
    </>
  );
}

// ── Section components (extracted from this page) ────────────────────────────
// The page file used to inline the progress bar, the challengers card, the
// design-preview builders and the resolve-animation timing constants. They now
// live in `components/vs/detail/*` and `lib/vs/detail-preview.ts` so that each
// VS-page issue can touch one section without conflicting with the others.
// Re-exported here so existing imports from this module keep working.
export { ProgressBar } from "@/components/vs/detail/ProgressBar";
export { VsChallengersCard } from "@/components/vs/detail/VsChallengersCard";
export {
  buildDesignPreviewVs,
  buildDesignPreviewRematchChain,
  formatChallengers,
  txToastOptions,
  VERDICT_OVERLAY_MS,
  RESOLVE_PHASE_MS,
  RESOLVE_ANIM_TOTAL_MS,
} from "@/lib/vs/detail-preview";