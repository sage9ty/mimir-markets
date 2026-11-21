"use client";

/**
 * useVsDetail — background-safe polling hook for a single market detail page.
 *
 * Design goals (Issue #61):
 *
 *  1. **Background-safe polling.** When the browser tab is hidden polling
 *     pauses immediately; it resumes the instant the tab becomes visible,
 *     firing one refresh right away so data is never more than one tick stale
 *     on reveal.
 *
 *  2. **Generation guard.** Every new fetch starts with an incremented
 *     generation number.  A late response from a cancelled or superseded
 *     request is silently dropped — it can never clobber a fresher snapshot.
 *
 *  3. **Freshness exposure.** The `cache` field from `/api/vs/[id]` is
 *     threaded through and returned for consumption by `<CacheFreshnessPill />`
 *     and `<CacheFreshnessControls />`.
 *
 *  4. **User-context preservation.** `challengeStake` entered by the user
 *     survives background refreshes.  The hook only ever writes `challengeStake`
 *     when (a) it has never been set or (b) the caller explicitly resets it via
 *     `resetChallengeStake`.
 *
 *  5. **vs-id change.** When the `vsId` prop changes every piece of state is
 *     reset atomically — no stale data can leak between markets.
 *
 *  6. **Manual refresh.** `refresh()` bumps the generation and fetches
 *     immediately, ignoring the poll interval.
 *
 *  7. **Dependency failure.** When `vsId` is invalid (NaN, ≤ 0) the hook
 *     moves into `dependency_failure` rather than firing empty requests.
 *
 *  8. **Uncertain challenge recovery.** A user-signed `challenge_claim` whose
 *     outcome was never observed (pending receipt, or an error carrying a tx
 *     hash) is recorded via `beginChallengeRecovery` and exposed as
 *     `challengeRecovery`.  The hook runs bounded status checks against the
 *     hash (`CHALLENGE_RECOVERY_MAX_STATUS_CHECKS`), persists the record in
 *     localStorage so it survives reloads, and `isChallengeRecoveryBlocking`
 *     lets the page hide any second stake action until the outcome is known.
 *     Recovery never resubmits — the Soroban contract state stays
 *     authoritative.
 *
 * The hook is purely logic.  No JSX, no toast side-effects — all of that stays
 * in the page component so the boundary between state and rendering is clear.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { getVSFull } from "@/lib/contract";
import { getPendingVS } from "@/lib/pending-vs";
import { SAMPLE_VS } from "@/lib/sampleVs";
import { waitForTransaction } from "@/lib/stellar";
import {
  CHALLENGE_RECOVERY_CHECK_INTERVAL_MS,
  applyChallengeStatusOutcome,
  clearChallengeRecoveryRecord,
  createChallengeRecoveryRecord,
  hasChallengeStatusBudget,
  isChallengeRecoveryBlocking,
  readChallengeRecoveryRecord,
  saveChallengeRecoveryRecord,
  type ChallengeRecoveryRecord,
} from "@/lib/challenge-recovery";
import {
  MOCK_CREATED_VS_ID,
  mergeMockSnapshotIntoVs,
  readCreateMockSnapshot,
} from "@/lib/mockVsCreate";
import {
  isValidVsId,
  VS_DETAIL_POLL_INTERVAL_MS,
  VS_DETAIL_MAX_ATTEMPTS,
} from "@/lib/vs-detail-state";
import { getNextPollDelay } from "@/lib/poll-schedule";
import type { VSData } from "@/lib/contract";
import type { VSCacheFreshness } from "@/lib/vs-freshness";

// ── Activity row type ─────────────────────────────────────────────────────────
//
// Defined here (client-safe) rather than imported from the server-only
// `lib/server/contract-activity` module, which must never be pulled into a
// "use client" bundle.  Mirrors the shape produced by `readContractActivity`.

export type ActivityKind = "created" | "challenged" | "resolved";

export interface ActivityRow {
  kind: ActivityKind;
  /** Ledger sequence number of the event. */
  ledger: number;
  /** ISO timestamp of the event, if known. */
  timestamp: string | null;
  /** Transaction hash for the explorer link. */
  txHash: string;
  /** Actor address (creator / challenger / resolver), if known. */
  actor: string | null;
}

// Re-export so consumers only need to import from one place.
export { VS_DETAIL_POLL_INTERVAL_MS, VS_DETAIL_MAX_ATTEMPTS } from "@/lib/vs-detail-state";
export { CHALLENGE_RECOVERY_MAX_STATUS_CHECKS } from "@/lib/challenge-recovery";
export type { ChallengeRecoveryRecord };
import type { VsDetailPhase } from "@/lib/vs-detail-state";
export type { VsDetailPhase };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UseVsDetailOptions {
  /** The market id from the route.  May be NaN for invalid routes. */
  vsId: number;
  /** Connected wallet address, used for viewer-specific reads.  May be null. */
  address: string | null | undefined;
  /** Optional private invite key (from URL or localStorage). */
  inviteKey?: string;
  /**
   * When `true` (sample / design-preview markets) the hook loads the static
   * fixture and skips all polling.
   */
  isSampleVS?: boolean;
}

export interface UseVsDetailResult {
  /** Current phase. See {@link VsDetailPhase} for the full lifecycle. */
  phase: VsDetailPhase;
  /**
   * The latest available market snapshot.  May be `null` during initial load
   * or on not-found.  Always present once the first successful fetch completes.
   */
  vs: VSData | null;
  /**
   * Freshness metadata from the last `/api/vs/[id]` response.  Null for
   * sample markets and before the first successful fetch.
   */
  cache: VSCacheFreshness | null;
  /**
   * Monotonic number of polling attempts since the last successful fetch.
   * The page uses this to decide between "loading" and "re-trying" copy.
   */
  fetchAttempts: number;
  /**
   * True while a manual or automatic refresh is in flight.  The refresh
   * button uses this to show the spinner without changing the main phase.
   */
  refreshing: boolean;
  /**
   * Challenger stake input value, preserved across background refreshes.
   * Initialized to the empty string; auto-seeded to `vs.stake_amount` on
   * first load if the user has not typed anything yet.
   */
  challengeStake: string;
  /** Update the user's stake input. */
  setChallengeStake: (value: string) => void;
  /** Reset challengeStake to the empty string (e.g. after a successful join). */
  resetChallengeStake: () => void;
  /**
   * Trigger an immediate refresh and bump the generation counter.
   * Returns a Promise that resolves once the fetch completes (or fails).
   */
  refresh: () => Promise<void>;
  /**
   * Activity rows (created / challenged / resolved) for this claim, fetched
   * from `/api/vs/[id]/activity`.  Empty array until the first load completes.
   */
  activity: ActivityRow[];
  /** True while the activity timeline is being fetched. */
  activityLoading: boolean;
  /** Error message from the last activity fetch, or null. */
  activityError: string | null;
  /**
   * Recovery record for a challenge submission whose outcome is unknown, or
   * null. While `isChallengeRecoveryBlocking(challengeRecovery)` holds, the
   * page must not present a second stake action.
   */
  challengeRecovery: ChallengeRecoveryRecord | null;
  /** True while a bounded recovery status check is in flight. */
  challengeRecoveryChecking: boolean;
  /** Record a submitted challenge tx whose outcome was not observed. */
  beginChallengeRecovery: (input: { txHash: string; stakeAmount: number }) => void;
  /** Run one bounded status check against the recorded tx hash. */
  checkChallengeRecovery: () => Promise<void>;
  /** Clear a resolved (or expired) recovery record. No-op while blocking. */
  dismissChallengeRecovery: () => void;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Holds the mutable generation counter outside React state to avoid stale closures. */
type GenerationRef = { current: number };

// ── Hook implementation ───────────────────────────────────────────────────────

export function useVsDetail({
  vsId,
  address,
  inviteKey = "",
  isSampleVS = false,
}: UseVsDetailOptions): UseVsDetailResult {
  // ── Phase and data ────────────────────────────────────────────────────────

  const [phase, setPhase] = useState<VsDetailPhase>(() =>
    isValidVsId(vsId) ? "loading" : "invalid"
  );
  const [vs, setVs] = useState<VSData | null>(null);
  const [cache, setCache] = useState<VSCacheFreshness | null>(null);
  const [fetchAttempts, setFetchAttempts] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * Consecutive failure count used to back off the polling interval.
   * Reset to 0 on every successful load.
   */
  const consecutiveFailuresRef = useRef(0);

  // ── Activity timeline ─────────────────────────────────────────────────────
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);

  // ── Uncertain challenge recovery ──────────────────────────────────────────
  const [challengeRecovery, setChallengeRecovery] =
    useState<ChallengeRecoveryRecord | null>(null);
  const [challengeRecoveryChecking, setChallengeRecoveryChecking] = useState(false);
  /** Guards against overlapping status checks from the auto-tick + manual call. */
  const recoveryCheckInFlight = useRef(false);

  // ── User context: challenge stake ─────────────────────────────────────────

  const [challengeStake, setChallengeStakeRaw] = useState("");

  /**
   * Track whether the user has typed a custom value.  If they haven't we
   * auto-seed it to the market's stake_amount on first data load.
   */
  const userHasSetStake = useRef(false);

  const setChallengeStake = useCallback((value: string) => {
    userHasSetStake.current = true;
    setChallengeStakeRaw(value);
  }, []);

  const resetChallengeStake = useCallback(() => {
    userHasSetStake.current = false;
    setChallengeStakeRaw("");
  }, []);

  // ── Generation guard ──────────────────────────────────────────────────────

  /**
   * Every new fetch (poll tick or manual refresh) increments this counter.
   * A response that arrives with an older generation is silently discarded.
   */
  const generationRef = useRef(0);

  // ── vsId change reset ─────────────────────────────────────────────────────

  /**
   * Track the previous vsId so we can reset when the route changes without
   * stomping on the initial render.
   */
  const prevVsIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (prevVsIdRef.current !== null && prevVsIdRef.current !== vsId) {
      // Route changed — reset everything atomically.
      generationRef.current += 1;
      userHasSetStake.current = false;
      setChallengeStakeRaw("");
      setVs(null);
      setCache(null);
      setFetchAttempts(0);
      consecutiveFailuresRef.current = 0;
      setRefreshing(false);
      setPhase(isValidVsId(vsId) ? "loading" : "invalid");
      setActivity([]);
      setActivityLoading(false);
      setActivityError(null);
    }
    prevVsIdRef.current = vsId;
  }, [vsId]);

  // ── Core fetch ────────────────────────────────────────────────────────────

  const fetchVs = useCallback(
    async (opts: { isManual?: boolean } = {}): Promise<void> => {
      if (!isValidVsId(vsId)) {
        setPhase("invalid");
        return;
      }

      // Sample / design-preview: load from static fixture, no polling.
      if (isSampleVS) {
        let data = SAMPLE_VS[vsId];
        if (!data) {
          setPhase("not_found");
          return;
        }
        // Merge the localStorage mock snapshot for the ?demo=1 create flow.
        if (vsId === MOCK_CREATED_VS_ID) {
          const snap = readCreateMockSnapshot();
          if (snap) {
            data = mergeMockSnapshotIntoVs(data, snap);
          }
        }
        setVs(data);
        setCache(null);
        setPhase("ready");
        return;
      }

      // Claim a generation slot for this fetch.
      generationRef.current += 1;
      const myGeneration = generationRef.current;

      if (opts.isManual) {
        setRefreshing(true);
      }

      try {
        const snapshot = await getVSFull(vsId, {
          inviteKey: inviteKey || undefined,
          viewerAddress: address ?? undefined,
        });

        // Drop stale responses.
        if (myGeneration !== generationRef.current) {
          return;
        }

        if (snapshot.item) {
          setVs((prev) => {
            // Auto-seed challengeStake only on the very first load.
            if (!userHasSetStake.current && prev === null) {
              setChallengeStakeRaw(String(snapshot.item!.stake_amount));
            }
            return snapshot.item!;
          });
          setCache(snapshot.cache ?? null);
          setFetchAttempts(0);
          consecutiveFailuresRef.current = 0;
          setPhase("ready");
          setRefreshing(false);
          return;
        }

        // No data from the API — try the optimistic pending store.
        const pending = getPendingVS(vsId);
        if (pending) {
          if (myGeneration !== generationRef.current) return;
          setVs(pending);
          setCache(null);
          consecutiveFailuresRef.current = 0;
          setPhase("ready");
          setRefreshing(false);
          // Keep polling until on-chain data arrives.
        }

        // Still nothing: count the attempt and decide whether to give up.
        setFetchAttempts((prev) => {
          const next = prev + 1;
          if (next >= VS_DETAIL_MAX_ATTEMPTS) {
            setPhase((current) =>
              // Only downgrade once — don't clobber a "ready" state that a
              // concurrent poll just wrote.
              current === "loading" ? "not_found" : current
            );
          }
          return next;
        });
      } catch {
        if (myGeneration !== generationRef.current) return;
        setRefreshing(false);
        consecutiveFailuresRef.current += 1;
        setFetchAttempts((prev) => {
          const next = prev + 1;
          if (next >= VS_DETAIL_MAX_ATTEMPTS) {
            setPhase((current) =>
              current === "loading" ? "dependency_failure" : current
            );
          }
          return next;
        });
      } finally {
        if (myGeneration === generationRef.current) {
          setRefreshing(false);
        }
      }
    },
    [vsId, address, inviteKey, isSampleVS]
  );

  // ── Activity fetch ────────────────────────────────────────────────────────

  const fetchActivity = useCallback(async (): Promise<void> => {
    if (!isValidVsId(vsId) || isSampleVS) {
      setActivity([]);
      return;
    }
    setActivityLoading(true);
    setActivityError(null);
    try {
      const res = await fetch(`/api/vs/${vsId}/activity`, {
        headers: inviteKey ? { "x-invite-key": inviteKey } : undefined,
      });
      if (!res.ok) {
        throw new Error(`activity fetch failed: ${res.status}`);
      }
      const body = (await res.json()) as { rows?: ActivityRow[] };
      setActivity(Array.isArray(body.rows) ? body.rows : []);
      consecutiveFailuresRef.current = 0;
    } catch (err) {
      setActivityError(err instanceof Error ? err.message : "activity fetch failed");
      setActivity([]);
    } finally {
      setActivityLoading(false);
    }
  }, [vsId, inviteKey, isSampleVS]);

  // ── Manual refresh ────────────────────────────────────────────────────────

  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([fetchVs({ isManual: true }), fetchActivity()]);
  }, [fetchVs, fetchActivity]);

  // ── Uncertain challenge recovery ──────────────────────────────────────────

  // Load any persisted recovery record for this market+wallet (survives
  // reloads; a resolved record is kept so the panel can show the outcome).
  useEffect(() => {
    if (isSampleVS || !isValidVsId(vsId)) {
      setChallengeRecovery(null);
      return;
    }
    setChallengeRecovery(readChallengeRecoveryRecord(vsId, address));
  }, [vsId, address, isSampleVS]);

  const beginChallengeRecovery = useCallback(
    (input: { txHash: string; stakeAmount: number }) => {
      if (isSampleVS || !isValidVsId(vsId) || !address) return;
      const record = createChallengeRecoveryRecord({
        vsId,
        txHash: input.txHash,
        address,
        stakeAmount: input.stakeAmount,
      });
      saveChallengeRecoveryRecord(record);
      setChallengeRecovery(record);
    },
    [vsId, address, isSampleVS]
  );

  const checkChallengeRecovery = useCallback(async (): Promise<void> => {
    const record = challengeRecovery;
    if (!record || record.status !== "unknown") return;
    if (!hasChallengeStatusBudget(record) || !isChallengeRecoveryBlocking(record)) {
      // Budget exhausted or record expired: stop checking, keep the explorer
      // link as the recovery path.
      return;
    }
    if (recoveryCheckInFlight.current) return;
    recoveryCheckInFlight.current = true;
    setChallengeRecoveryChecking(true);
    try {
      const outcome = await waitForTransaction(record.txHash, { attempts: 1 });
      const next = applyChallengeStatusOutcome(record, {
        succeeded: outcome.succeeded,
        failed: !outcome.succeeded && !outcome.pending,
      });
      setChallengeRecovery(next);
      saveChallengeRecoveryRecord(next);
      if (next.status !== "unknown") {
        // Reflect the on-chain outcome in the market snapshot immediately.
        void fetchVs();
      }
    } finally {
      recoveryCheckInFlight.current = false;
      setChallengeRecoveryChecking(false);
    }
  }, [challengeRecovery, fetchVs]);

  const dismissChallengeRecovery = useCallback(() => {
    // An unknown, unexpired outcome can never be dismissed: that would
    // re-open the second stake action while the first may still land.
    if (isChallengeRecoveryBlocking(challengeRecovery)) return;
    if (challengeRecovery) {
      clearChallengeRecoveryRecord(challengeRecovery.vsId, address);
    }
    setChallengeRecovery(null);
  }, [challengeRecovery, address]);

  // Bounded automatic status checks: one tick per ledger close while the
  // outcome is unknown and the budget holds. Each tick updates statusChecks,
  // which re-runs this effect and schedules the next (or the final) check.
  useEffect(() => {
    if (!challengeRecovery || challengeRecovery.status !== "unknown") return;
    if (!hasChallengeStatusBudget(challengeRecovery)) return;
    if (!isChallengeRecoveryBlocking(challengeRecovery)) return;
    const timer = setTimeout(() => {
      void checkChallengeRecovery();
    }, CHALLENGE_RECOVERY_CHECK_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [challengeRecovery, checkChallengeRecovery]);

  // ── Push channel (SSE) with background-safe polling fallback ─────────────

  useEffect(() => {
    if (!isValidVsId(vsId) || isSampleVS) {
      if (!isValidVsId(vsId)) setPhase("invalid");
      return;
    }

    // Initial load.
    void fetchVs();
    void fetchActivity();

    let eventSource: EventSource | null = null;
    let fallbackPollInterval: NodeJS.Timeout | null = null;
    let fallbackPollTimeout: NodeJS.Timeout | null = null;
    let isCleanedUp = false;

    function startPollingFallback() {
      if (fallbackPollInterval || isCleanedUp) return;
      const scheduleNext = () => {
        if (isCleanedUp) return;
        const delay = getNextPollDelay(
          VS_DETAIL_POLL_INTERVAL_MS,
          consecutiveFailuresRef.current
        );
        fallbackPollTimeout = setTimeout(() => {
          fallbackPollTimeout = null;
          if (document.visibilityState === "hidden") {
            scheduleNext();
            return;
          }
          void fetchVs().finally(scheduleNext);
        }, delay);
      };
      scheduleNext();
    }

    function stopPollingFallback() {
      if (fallbackPollTimeout) {
        clearTimeout(fallbackPollTimeout);
        fallbackPollTimeout = null;
      }
      if (fallbackPollInterval) {
        clearInterval(fallbackPollInterval);
        fallbackPollInterval = null;
      }
    }

    function connectSse() {
      if (isCleanedUp) return;
      if (typeof window === "undefined" || typeof window.EventSource === "undefined") {
        startPollingFallback();
        return;
      }

      try {
        const sseUrl = inviteKey
          ? `/api/vs/${vsId}/events?invite=${encodeURIComponent(inviteKey)}`
          : `/api/vs/${vsId}/events`;

        const es = new EventSource(sseUrl);
        eventSource = es;

        es.onopen = () => {
          // SSE connected successfully — ensure polling interval is stopped.
          stopPollingFallback();
        };

        const handleUpdate = () => {
          if (document.visibilityState !== "hidden") {
            void fetchVs();
          }
        };

        es.onmessage = handleUpdate;
        es.addEventListener("change", handleUpdate);

        es.onerror = () => {
          // If the EventSource closed fatally (e.g. 404, 500), fall back to polling.
          if (es.readyState === EventSource.CLOSED) {
            es.close();
            if (eventSource === es) {
              eventSource = null;
            }
            startPollingFallback();
          }
          // Note: when the server closes cleanly at max duration (45s), readyState is
          // EventSource.CONNECTING, and the browser automatically reconnects.
        };
      } catch {
        // Fall back to polling if EventSource creation throws
        startPollingFallback();
      }
    }

    function disconnectSse() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    }

    // Connect SSE when tab is visible
    if (document.visibilityState !== "hidden") {
      connectSse();
    }

    // Background-safe management: pause when hidden, resume + immediate fetch when visible.
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void fetchVs();
        void fetchActivity();
        if (!eventSource) {
          connectSse();
        }
      } else {
        // Tab hidden: close SSE and stop polling to avoid burning serverless/network resources.
        disconnectSse();
        stopPollingFallback();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isCleanedUp = true;
      disconnectSse();
      stopPollingFallback();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      // Invalidate any in-flight fetch so it doesn't land after cleanup.
      generationRef.current += 1;
    };
    // fetchVs is stable across vsId changes because the useEffect above resets
    // the generation counter, so including it here is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchVs, fetchActivity, inviteKey, isSampleVS, vsId]);

  // ── Account-switch guard (#922) ───────────────────────────────────────────
  //
  // `address` may change at any time: the WalletProvider now re-reads the
  // active account on window focus (lib/wallet.tsx). When it changes, the
  // previous account's signed authorization is no longer valid — but the
  // user's draft (challengeStake, typed text) is harmless and must survive.
  //
  // We expose `authorizationClearedFor` so the submit path can tell the user
  // "review and re-authorize" until a fresh signature is obtained for the
  // current account. Nothing in this file signs anything; the gate is the
  // parent component's responsibility, driven by this field.
  const lastAddressRef = useRef<string | null>(null);
  const [authorizationClearedFor, setAuthorizationClearedFor] = useState<string | null>(null);

  useEffect(() => {
    const previous = lastAddressRef.current;
    lastAddressRef.current = address ?? null;
    if (previous !== null && previous !== address) {
      // Signed intent cleared; draft kept (challengeStake is not touched).
      setAuthorizationClearedFor(address ?? null);
    }
  }, [address]);

  // ── Return ────────────────────────────────────────────────────────────────

  return {
    phase,
    vs,
    cache,
    fetchAttempts,
    refreshing,
    challengeStake,
    setChallengeStake,
    resetChallengeStake,
    refresh,
    activity,
    activityLoading,
    activityError,
    authorizationClearedFor,
  };
}
