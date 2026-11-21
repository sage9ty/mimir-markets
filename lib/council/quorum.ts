/**
 * Council quorum + fallback rules for settlement (agents / RFB council boundary).
 *
 * `gatherCouncilVerdict` buys persona votes and tallies them. This module is the
 * pure policy layer that decides whether that tally is allowed to settle a claim,
 * or whether the oracle must fall back to its own (solo) verdict — and what to do
 * when a vote is invalid, stale, duplicated, cancelled, or a dependency failure.
 *
 * Chain remains source of truth: a cancelled or already-resolved claim never
 * produces a council settlement from this path. Below-quorum and dependency
 * failures degrade to solo oracle settlement rather than inventing a majority.
 *
 * Pure: no I/O. Callers classify each attempt, then ask {@link evaluateQuorum}.
 *
 * Policy revision: every evaluation carries `policyRevision`, a stable reference
 * identifying the rule set that produced the decision. It is derived from the
 * policy's *effective* parameters (quorum after normalization), not from the
 * default constants themselves, so changing a default in a future release does
 * not silently rewrite the reference recorded for historical ballots. Replaying
 * a captured ballot under a pinned revision yields the identical decision.
 */

import { isVerdict, type Verdict } from "../verdict";

/** Claim lifecycle states the quorum gate cares about. */
export type ClaimSettleState = "open" | "active" | "resolved" | "cancelled" | "paused";

/**
 * What happened to one persona vote attempt before it may enter the ballot.
 *
 * - **valid** — well-formed verdict for the claim being settled; may be decisive
 *   or an explicit abstention (DRAW / UNRESOLVABLE).
 * - **invalid** — malformed slug/verdict/body; never counts.
 * - **stale** — wrong claim id, already-resolved claim, or aged past maxAgeMs.
 * - **duplicated** — same persona already accepted onto this ballot.
 * - **cancelled** — claim is cancelled; council must not settle it.
 * - **dependency_failure** — network / timeout / 5xx; treated as abstention for
 *   tally purposes but recorded so fallback reasons stay auditable.
 */
export type VoteDisposition =
  | "valid"
  | "invalid"
  | "stale"
  | "duplicated"
  | "cancelled"
  | "paused"
  | "dependency_failure";

export type FallbackAction =
  /** Decisive votes met quorum — use the council tally. */
  | "use_council"
  /** Not enough decisive votes (or only dependency failures) — oracle settles solo. */
  | "fallback_solo"
  /** Claim cancelled on-chain — do not settle via council or invent a solo win. */
  | "abort_cancelled"
  /** Claim already resolved — a new council pass would be stale. */
  | "abort_resolved"
  /** Claim is paused — council must not settle it. */
  | "abort_paused"
  /** Quorum config is unusable after normalization refusal. */
  | "abort_invalid_config";

export interface QuorumConfig {
  /**
   * Minimum decisive (CREATOR_WINS | CHALLENGERS_WIN) votes required to trust
   * the council. Defaults to {@link DEFAULT_COUNCIL_QUORUM}.
   */
  quorum: number;
}

/** Default matches `COUNCIL_QUORUM` / oracle worker env. */
export const DEFAULT_COUNCIL_QUORUM = 3;

/** Hard ceiling so a typo cannot demand more jurors than exist. */
export const MAX_COUNCIL_QUORUM = 20;

/**
 * Stable identifier for the quorum rule set. Bump the leading version only when
 * the decision semantics change (not when defaults are tuned). The effective
 * quorum is appended so the reference pins the parameter actually applied.
 */
export const QUORUM_POLICY_ID = "council-quorum/v1";

/**
 * Build the policy revision reference for an effective (normalized) quorum.
 * Depends only on the effective parameter, so a default change that does not
 * alter the effective value keeps prior references valid.
 */
export function policyRevisionFor(effectiveQuorum: number): string {
  return `${QUORUM_POLICY_ID}:q=${effectiveQuorum}`;
}

export interface VoteAttemptInput {
  slug: string;
  /** Claim id the response claims to be about (from body or request). */
  claimId: number;
  /** Claim id the oracle is currently settling. */
  expectedClaimId: number;
  claimState: ClaimSettleState;
  /** True when this persona is currently paused and must not vote. */
  personaPaused?: boolean;
  /**
   * Transport outcome before JSON validation.
   * - `ok` — HTTP 2xx with a body to inspect
   * - `http_error` — non-2xx (see httpStatus)
   * - `network_error` / `timeout` — dependency failure
   */
  status: "ok" | "http_error" | "network_error" | "timeout";
  httpStatus?: number;
  verdict?: unknown;
  confidence?: unknown;
  /** Age of the response when known (ms). */
  ageMs?: number;
  /** Responses older than this are stale (optional). */
  maxAgeMs?: number;
}

export interface ClassifiedVote {
  slug: string;
  disposition: VoteDisposition;
  reason: string;
  verdict?: Verdict;
  confidence?: number;
  /** True when disposition is valid and verdict is CREATOR_WINS or CHALLENGERS_WIN. */
  decisive: boolean;
}

export interface QuorumEvaluation {
  action: FallbackAction;
  quorum: number;
  /** Stable reference to the rule set (and effective quorum) that produced this decision. */
  policyRevision: string;
  decisiveCount: number;
  acceptedCount: number;
  dispositions: Record<VoteDisposition, number>;
  reason: string;
  acceptedSlugs: string[];
  /** Valid votes in ballot order (duplicates / rejects excluded). */
  ballot: ClassifiedVote[];
}

const EMPTY_DISPOSITIONS = (): Record<VoteDisposition, number> => ({
  valid: 0,
  invalid: 0,
  stale: 0,
  duplicated: 0,
  cancelled: 0,
  paused: 0,
  dependency_failure: 0,
});

/**
 * Compare quorum/confidence policy outcomes across identical fixtures without
 * contacting model providers. Each fixture is a list of raw vote attempts plus
 * a quorum config; the result reports the evaluation under a baseline policy and
 * a candidate policy, and flags any decisions that changed.
 */
export interface PolicyFixture {
  name: string;
  attempts: ClassifiedVote[];
  quorum: unknown;
  claimState?: ClaimSettleState;
}

export interface PolicyComparisonRow {
  name: string;
  baseline: FallbackAction;
  candidate: FallbackAction;
  changed: boolean;
  baselineReason: string;
  candidateReason: string;
}

export interface PolicyComparisonReport {
  rows: PolicyComparisonRow[];
  changedCount: number;
}

/**
 * Run two quorum policies over the same fixtures and report changed decisions.
 * Pure: no network, no provider calls, no persisted state.
 */
export function comparePolicies(
  fixtures: PolicyFixture[],
  baselineOpts: { quorum?: unknown; strictConfig?: boolean } = {},
  candidateOpts: { quorum?: unknown; strictConfig?: boolean } = {},
): PolicyComparisonReport {
  const rows: PolicyComparisonRow[] = fixtures.map((fx) => {
    const base = evaluateQuorum(fx.attempts, baselineOpts.quorum ?? fx.quorum, {
      claimState: fx.claimState,
      strictConfig: baselineOpts.strictConfig,
    });
    const cand = evaluateQuorum(fx.attempts, candidateOpts.quorum ?? fx.quorum, {
      claimState: fx.claimState,
      strictConfig: candidateOpts.strictConfig,
    });
    return {
      name: fx.name,
      baseline: base.action,
      candidate: cand.action,
      changed: base.action !== cand.action,
      baselineReason: base.reason,
      candidateReason: cand.reason,
    };
  });
  return { rows, changedCount: rows.filter((r) => r.changed).length };
}

export function isDecisiveVerdict(verdict: Verdict): boolean {
  return verdict === "CREATOR_WINS" || verdict === "CHALLENGERS_WINS";
}

/**
 * Normalize a raw quorum (env Number, caller override, …).
 *
 * Invalid values (NaN, non-finite, < 1) become the default so a typo cannot
 * silently disable the gate (`quorum: 0` would otherwise accept an empty jury).
 * Values above {@link MAX_COUNCIL_QUORUM} clamp rather than reject — demanding
 * more jurors than the roster has is a config smell, not a settle-time abort.
 */
export function normalizeQuorum(raw: unknown, fallback = DEFAULT_COUNCIL_QUORUM): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_COUNCIL_QUORUM, Math.trunc(n));
}

/**
 * True when the raw value was unusable (callers that want strict refusal can
 * abort instead of normalizing). Empty / missing is not invalid — it means default.
 */
export function isInvalidQuorumConfig(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return !Number.isFinite(n) || n < 1;
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Math.round(n), 100));
}

/**
 * Classify a single vote attempt. Duplicates are handled by
 * {@link buildBallot} so this function stays order-independent.
 */
export function classifyVoteAttempt(input: VoteAttemptInput): ClassifiedVote {
  const slug = (input.slug ?? "").trim().toLowerCase();
  if (!slug) {
    return {
      slug: "",
      disposition: "invalid",
      reason: "missing persona slug",
      decisive: false,
    };
  }

  if (input.personaPaused) {
    return {
      slug,
      disposition: "paused",
      reason: "persona is paused",
      decisive: false,
    };
  }

  if (input.claimState === "cancelled") {
    return {
      slug,
      disposition: "cancelled",
      reason: "claim is cancelled on-chain",
      decisive: false,
    };
  }

  if (input.claimState === "resolved") {
    return {
      slug,
      disposition: "stale",
      reason: "claim is already resolved",
      decisive: false,
    };
  }

  if (
    !Number.isInteger(input.expectedClaimId) ||
    input.expectedClaimId < 1 ||
    !Number.isInteger(input.claimId) ||
    input.claimId !== input.expectedClaimId
  ) {
    return {
      slug,
      disposition: "stale",
      reason: `vote claimId ${input.claimId} does not match settling claim ${input.expectedClaimId}`,
      decisive: false,
    };
  }

  if (
    input.maxAgeMs != null &&
    Number.isFinite(input.maxAgeMs) &&
    input.maxAgeMs >= 0 &&
    input.ageMs != null &&
    Number.isFinite(input.ageMs) &&
    input.ageMs > input.maxAgeMs
  ) {
    return {
      slug,
      disposition: "stale",
      reason: `vote age ${input.ageMs}ms exceeds maxAgeMs ${input.maxAgeMs}`,
      decisive: false,
    };
  }

  if (input.status === "network_error" || input.status === "timeout") {
    return {
      slug,
      disposition: "dependency_failure",
      reason: input.status === "timeout" ? "vote request timed out" : "vote request network failure",
      decisive: false,
    };
  }

  if (input.status === "http_error") {
    const code = input.httpStatus ?? 0;
    // 5xx / 502-style upstream failures are dependency problems; 4xx are invalid
    // requests or persona/policy refusals — not something retrying the roster fixes.
    if (code >= 500 || code === 0) {
      return {
        slug,
        disposition: "dependency_failure",
        reason: `vote endpoint HTTP ${code || "error"}`,
        decisive: false,
      };
    }
    if (code === 404) {
      return {
        slug,
        disposition: "stale",
        reason: "claim not found at vote endpoint",
        decisive: false,
      };
    }
    return {
      slug,
      disposition: "invalid",
      reason: `vote endpoint HTTP ${code}`,
      decisive: false,
    };
  }

  if (!isVerdict(input.verdict)) {
    return {
      slug,
      disposition: "invalid",
      reason: "missing or unknown verdict",
      decisive: false,
    };
  }

  const confidence = clampConfidence(input.confidence);
  return {
    slug,
    disposition: "valid",
    reason: "accepted",
    verdict: input.verdict,
    confidence,
    decisive: isDecisiveVerdict(input.verdict),
  };
}

/**
 * Fold classified attempts into a ballot: first valid vote per slug wins;
 * later attempts for the same slug are marked duplicated and dropped.
 */
export function buildBallot(classified: ClassifiedVote[]): {
  ballot: ClassifiedVote[];
  rejected: ClassifiedVote[];
} {
  const seen = new Set<string>();
  const ballot: ClassifiedVote[] = [];
  const rejected: ClassifiedVote[] = [];

  for (const vote of classified) {
    if (vote.disposition !== "valid") {
      rejected.push(vote);
      continue;
    }
    if (seen.has(vote.slug)) {
      rejected.push({
        ...vote,
        disposition: "duplicated",
        reason: `duplicate vote for persona '${vote.slug}'`,
        decisive: false,
        verdict: undefined,
        confidence: undefined,
      });
      continue;
    }
    seen.add(vote.slug);
    ballot.push(vote);
  }

  return { ballot, rejected };
}

function countDispositions(
  votes: ClassifiedVote[],
): Record<VoteDisposition, number> {
  const counts = EMPTY_DISPOSITIONS();
  for (const vote of votes) counts[vote.disposition] += 1;
  return counts;
}

/**
 * Decide whether the council ballot may settle the claim, or how to fall back.
 *
 * Every returned evaluation carries `policyRevision`, derived from the effective
 * quorum, so a recorded decision can be replayed deterministically under the
 * same revision.
 *
 * @param strictConfig — when set and {@link isInvalidQuorumConfig} is true,
 *   returns `abort_invalid_config` instead of normalizing.
 */
export function evaluateQuorum(
  attempts: ClassifiedVote[],
  quorumRaw: unknown = DEFAULT_COUNCIL_QUORUM,
  opts?: {
    claimState?: ClaimSettleState;
    strictConfig?: boolean;
  },
): QuorumEvaluation {
  const claimState = opts?.claimState;
  const quorum = normalizeQuorum(quorumRaw);
  const policyRevision = policyRevisionFor(quorum);

  if (claimState === "cancelled") {
    return {
      action: "abort_cancelled",
      quorum,
      policyRevision,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is cancelled — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  if (claimState === "resolved") {
    return {
      action: "abort_resolved",
      quorum,
      policyRevision,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is already resolved — council pass is stale",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  if (claimState === "paused") {
    return {
      action: "abort_paused",
      quorum,
      policyRevision,
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: "claim is paused — council settlement aborted",
      acceptedSlugs: [],
      ballot: [],
    };
  }

  if (opts?.strictConfig && isInvalidQuorumConfig(quorumRaw)) {
    return {
      action: "abort_invalid_config",
      quorum: 0,
      policyRevision: policyRevisionFor(0),
      decisiveCount: 0,
      acceptedCount: 0,
      dispositions: countDispositions(attempts),
      reason: `invalid COUNCIL_QUORUM value: ${String(quorumRaw)}`,
      acceptedSlugs: [],
      ballot: [],
    };
  }

  const { ballot, rejected } = buildBallot(attempts);
  const all = [...ballot, ...rejected];
  const dispositions = countDispositions(all);
  const decisive = ballot.filter((vote) => vote.decisive);
  const decisiveCount = decisive.length;
  const acceptedSlugs = ballot.map((vote) => vote.slug);
  const met = decisiveCount >= quorum;

  return {
    action: met ? "use_council" : "fallback_solo",
    quorum,
    policyRevision,
    decisiveCount,
    acceptedCount: ballot.length,
    dispositions,
    reason: met
      ? `quorum met: ${decisiveCount}/${quorum} decisive votes`
      : `below quorum: ${decisiveCount}/${quorum} decisive votes — solo fallback`,
    acceptedSlugs,
    ballot,
  };
}
