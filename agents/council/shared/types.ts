/**
 * Shared types for the Mimir Council runtime, plus the one mapper that adapts the
 * contract's claim struct to them ({@link toClaimOnChain}).
 */

import type { ClaimData } from "../../../lib/contract";
import type { PersonaSpec } from "../personas";

/**
 * On-chain claim shape consumed by the runner.
 *
 * Kept as its own camelCase interface rather than aliasing `ClaimData` so the
 * persona evaluators — which are business logic and were not touched by the chain
 * migration — keep reading the field names they always did. `agents/council/index.ts`
 * maps `ClaimData` onto this once, at the single fetch site.
 *
 * Two field types changed with the chain, and both are simplifications:
 *   - **stakes are display USDC**, not atomic bigints. `decodeClaim` converts at
 *     the boundary, so the evaluators compare plain numbers.
 *   - **`state` is a string** (`"open"` / `"active"` / …), mirroring the Soroban
 *     `ClaimState` enum by name. The old numeric discriminant invited off-by-one
 *     comparisons that silently skipped every freshly created market.
 */
export interface ClaimOnChain {
  id:                   number;
  creator:              string;
  question:             string;
  creatorPosition:      string;
  counterPosition:      string;
  resolutionUrl:        string;
  /** Display USDC. */
  creatorStake:         number;
  /** Display USDC. */
  totalChallengerStake: number;
  /** Unix seconds. */
  deadline:             number;
  state:                ClaimData["state"];
  category:             string;
  marketType:           string;
  challengerCount:      number;
  /** 0 means unlimited. */
  maxChallengers:       number;
  isPrivate:            boolean;
  settlementRule:       string;
  /** Roster already in, so "am I in" needs no extra call. */
  challengerAddresses:  readonly string[];
  /** Individual challenger stakes in display USDC, for the whale rule. */
  challengerStakes:     readonly number[];
  /**
   * Quorum policy revision in force when this claim's aggregate decision was
   * recorded. Stable across policy default changes so historical ballots replay
   * deterministically against the revision they were captured under.
   */
  quorumPolicyRevision?: number;
}

/**
 * What a persona decides about a single claim in a single cycle.
 *
 * Personas can only join the challenger side (createClaim is the
 * market-creator's role). When a persona's analysis agrees with the
 * creator's position, the persona simply abstains.
 */
export interface PersonaDecision {
  shouldStake:   boolean;
  /** USDC amount staked. Only meaningful when shouldStake is true. */
  stakeUsdc:     number;
  /** Human-readable reason — surfaced in the activity log and /council. */
  rationale:     string;
  /** Optional LLM confidence (0-100) for callers that want to display it. */
  confidence?:   number;
  /** Reason for skipping when shouldStake is false. For observability. */
  skipReason?:
    | "category-filter"
    | "abstain-low-confidence"
    | "abstain-agrees-with-creator"
    | "already-challenged"
    | "self-created"
    | "private"
    | "full"
    | "insufficient-balance"
    | "no-pool-imbalance"
    | "no-whale-yet"
    | "no-evidence"
    | "stale-evidence"
    | "llm-failed";
  /**
   * Quorum policy revision the decision was evaluated under. Recorded so an
   * aggregate decision can be replayed deterministically later.
   */
  quorumPolicyRevision?: number;
}

/**
 * Per-cycle context shared by every persona.
 *
 * The EVM version carried a `publicClient` and a `contractAddress` because each
 * evaluator made its own `readContract` calls. On Soroban the claim struct arrives
 * complete — roster included — so the reads those fields existed for are gone, and
 * with them the risk of a rule quietly re-reading state the runner already had.
 */
export interface PersonaRunnerContext {
  /** Market contract id (`C…`), for logs and explorer links. */
  contractId:       string;
  evidenceCache:    Map<number, EvidenceCacheEntry>;
  peerReasoning?:   Map<string, string[]>;
  /**
   * Quorum policy revision pinned for this cycle. Stable reference: if defaults
   * change mid-cycle the pinned revision is still used for every decision.
   */
  quorumPolicyRevision?: number;
}

/**
 * Represents a cached piece of evidence associated with a claim.
 *
 * Includes an integrity check mechanism via SHA-256 hashing to ensure
 * the cached text has not been tampered with or corrupted since caching.
 * This supports the "evidence-cache integrity check" feature requirement,
 * ensuring contract-first, privacy-safe behavior at this boundary.
 */
export interface EvidenceCacheEntry {
  text:    string;
  fetcher: string;
  /** SHA-256 of the text, bare hex. Used for integrity verification. */
  hash:    string;
  /**
   * Optional timestamp of when this evidence was cached.
   */
  cachedAt?: number;
  /**
   * Epoch ms when the fetch completed.  Populated for all real fetches;
   * absent (undefined) only for the "no URL / failed" placeholder entries so
   * callers can distinguish "no-evidence" from "evidence that is stale".
   */
  fetchedAt?: number;
  /** Normalised source URL after any redirects.  Absent for placeholder entries. */
  sourceUrl?: string;
}

/**
 * Map the contract's `ClaimData` onto the runner's shape.
 *
 * The single place the snake_case contract struct meets the evaluators' camelCase
 * field names — which is exactly why the persona logic downstream needed no
 * changes when the chain did. Shared with `app/api/council/*`, so a paid vote
 * served over HTTP sees the same claim the worker would.
 */
export function toClaimOnChain(claim: ClaimData): ClaimOnChain {
  return {
    id:                   claim.id,
    creator:              claim.creator,
    question:             claim.question,
    creatorPosition:      claim.creator_position,
    counterPosition:      claim.counter_position,
    resolutionUrl:        claim.resolution_url,
    creatorStake:         claim.creator_stake,
    totalChallengerStake: claim.total_challenger_stake,
    deadline:             claim.deadline,
    state:                claim.state,
    category:             claim.category,
    challengerCount:      claim.challenger_count,
    marketType:           claim.market_type,
    settlementRule:       claim.settlement_rule,
    maxChallengers:       claim.max_challengers,
    isPrivate:            claim.is_private ?? false,
    challengerAddresses:  claim.challenger_addresses ?? [],
    challengerStakes:     (claim.challengers ?? []).map((entry) => entry.stake),
  };
}

export interface PersonaStakeReceipt {
  persona:   PersonaSpec;
  claimId:   number;
  stakeUsdc: number;
  txHash:    string;
  rationale: string;
}
