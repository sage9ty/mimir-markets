/**
 * Dedupe helpers for the market-creator worker.
 *
 * Extracted from index.ts so they can be unit-tested offline. Behaviour is
 * unchanged: the worker imports these and the tests pin the normalization and
 * filtering rules.
 */

/**
 * Mimir Market Creator Agent
 *
 * Autonomously creates prediction markets from trusted public sources:
 *   - CoinGecko (crypto prices)
 *   - ESPN Headlines (sports)
 *   - OpenWeather (weather)
 *   - Custom RSS/API feeds
 *
 * Flow:
 *   1. Fetch events from trusted sources
 *   2. Use Claude to draft verifiable claim candidates
 *   3. Score candidates for quality (question clarity, source quality, deadline)
 *   4. Create top-scored claims on-chain via Mimir contract
 *   5. Optionally self-stake creator side (puts skin in the game)
 *
 * The sourcing, LLM drafting, quality scoring, council preflight and shadow-mode
 * gate are unchanged. The chain plumbing under them moved to Soroban: one
 * `get_claim` per id instead of two positional-tuple reads, `create_claim` returns
 * the new id directly, and staking needs no `approve` because the invocation
 * carries auth for exactly the stake.
 *
 * Run: npx tsx agents/market-creator/index.ts
 * Env: CREATOR_SECRET, NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID, ANTHROPIC_API_KEY
 *      CREATOR_STAKE_USDC=2     (stake per market, default 2 USDC)
 *      MAX_CLAIMS_PER_RUN=5      (max new claims per run, default 5)
 *      MAX_ACTIVE_CLAIMS=30      (skip run if joinable on-chain claims >= this)
 *      RUN_INTERVAL_HOURS=6      (hours between runs, default 6h)
 *      MARKET_CREATOR_POLL_JITTER_MS=2160000 (± spread per run, default 10%)
 *      MARKET_CREATOR_MAX_PER_CATEGORY_MARKETS=5      (open markets per category)
 *      MARKET_CREATOR_MAX_PER_CATEGORY_EXPOSURE_USDC=100 (open USDC per category)
 *      MARKET_CREATOR_CATEGORY_CAPS={"crypto":{"maxMarkets":3,"maxExposureUsdc":40}}
 *      MARKET_CREATOR_DRY_RUN=1    (full pipeline, log would-be creates, no txs, no x402)
 */

// Worker-scoped Gemini key. Falls back to the shared GEMINI_API_KEY when
// CREATOR_GEMINI_API_KEY is not set. See agents/oracle/index.ts for the
// rationale.
applyWorkerGeminiKey("CREATOR_GEMINI_API_KEY");

import { requireEnv, requireAnyLLMKey, applyWorkerGeminiKey } from "../../lib/agent-bootstrap";
import { callLLM, activeLLMProvider, activeLLMModel, activeLLMKeyFingerprint, pickGeminiModel, extractJson } from "../../lib/llm";
import { INJECTION_GUARD, fenceUntrusted } from "../../lib/prompt-safety";
import { fetchLaunchEvents, fetchWeatherEvents, type LaunchEvent, type WeatherEvent } from "./sources";
import { fetchCryptoEvents, fetchSportsEvents, fetchStockEvents, type CryptoEvent, type SportEvent, type StockEvent } from "./sources";
import { extractUsdThresholds, cryptoThresholdReason, formatUsd } from "./thresholds";
import { filterDuplicateCandidates, buildCandidateSignature, normalizeComparableText, normalizeResolutionUrl, type ExistingClaimSignature } from "./dedupe";
import { draftClaimCandidates } from "./drafting";
import {
  cancelClaim,
  createClaim as createClaimOnChain,
  getClaimCount,
  readClaimRaw,
  type CreateClaimParams,
} from "../../lib/contract";
import { getCreatorWallet, readAgentBalances } from "../../lib/agent-wallets";
import { sha256Hex } from "../../lib/content-hash";
import {
  STELLAR_NETWORK,
  isAccountAddress,
  isContractAddress,
  requireMarketContractId,
} from "../../lib/stellar";
import { payingWalletFor } from "../../lib/x402/buyer";
import { reportingPoll, runWorkerLoop } from "../../lib/ops/heartbeat";
import { resolvePollJitterMs } from "../../lib/ops/poll-jitter";
import { isCategoryEnabled } from "../../lib/ops/flags";
import { unitsToUsdc } from "../../lib/usdc";
import { gatherCouncilPreflight } from "./council-preflight";
import { insertMarketProposal } from "../../lib/db";
import { toCanonicalMode } from "../../lib/market-modes";
import { dimensionsReported } from "../../lib/market-creator/preflight-score";
import { defaultCreatorPolicy } from "../../lib/market-creator/mode-matrix";
import {
  checkCreatorExposureCap,
  marketsRemainingUnderCap,
  parseExposureCapPolicy,
  sumCreatorOpenExposure,
  type CategoryExposureClaim,
} from "../../lib/market-creator/exposure-caps";
import {
  bumpCategoryUsage,
  checkCategoryCreatorCap,
  describeCategoryCapPolicy,
  normalizeCategory,
  parseCategoryCapPolicy,
  summariseCreatorCaps,
} from "../../lib/market-creator/category-caps";
import {
  creatorSideEffectPolicy,
  isMarketCreatorDryRun,
} from "../../lib/market-creator/dry-run";
import {
  BackoffError,
  CREATOR_BACKOFF,
  describeBackoffError,
  withBackoff,
} from "../../lib/ops/backoff-policies";
import { reconcileSettlements } from "../../lib/server/settlement-index";

// ── Config ────────────────────────────────────────────────────────────────────
const CONTRACT_ID         = requireMarketContractId();
const CREATOR_STAKE_USDC = Number(
  process.env.CREATOR_STAKE_USDC ?? "2"
);
const MAX_CLAIMS_PER_RUN  = Number(process.env.MAX_CLAIMS_PER_RUN ?? "5");
const MAX_ACTIVE_CLAIMS   = Number(process.env.MAX_ACTIVE_CLAIMS ?? "30");
const RUN_INTERVAL_HOURS  = Number(process.env.RUN_INTERVAL_HOURS ?? "6");
const RUN_INTERVAL_MS     = RUN_INTERVAL_HOURS * 3600 * 1000;
// ± around each run; unset = 10% of the interval, 0 = fixed scheduling.
const POLL_JITTER_MS      = resolvePollJitterMs(RUN_INTERVAL_MS, process.env.MARKET_CREATOR_POLL_JITTER_MS);
// Creator open-exposure ceiling (USDC). Parsed explicitly so a bad env value
// fails closed instead of disabling the funded-state safety rail.
const _exposurePolicy = parseExposureCapPolicy(process.env);
if (!_exposurePolicy.ok) {
  throw new Error(`[market-creator] ${_exposurePolicy.error}`);
}
const MAX_OPEN_EXPOSURE_USDC = _exposurePolicy.policy.maxOpenExposureUsdc;
// Per-category creator caps (open markets + notional exposure inside each
// category). Parsed explicitly for the same reason as the exposure ceiling: a
// malformed cap must stop the worker at boot rather than silently becoming
// "unlimited" at runtime.
const _categoryCapPolicy = parseCategoryCapPolicy(process.env, {
  defaultMaxExposureUsdc: MAX_OPEN_EXPOSURE_USDC,
});
if (!_categoryCapPolicy.ok) {
  throw new Error(`[market-creator] ${_categoryCapPolicy.error}`);
}
const CATEGORY_CAP_POLICY = _categoryCapPolicy.policy;
const CREATOR_POLICY = {
  ...defaultCreatorPolicy(process.env),
  maxOpenExposureUsdc: MAX_OPEN_EXPOSURE_USDC,
  categoryCaps: CATEGORY_CAP_POLICY,
};
const MIN_QUALITY_SCORE   = 70; // 0-100
// Proposal-only until shadow precision has been measured against human review.
// Opt-in rather than opt-out: the default has to be the safe one.
const SHADOW_MODE         = process.env.MARKET_CREATOR_AUTONOMOUS !== "1";
/** U+001F, so a proposal id cannot be forged by a question containing the joiner. */
const UNIT_SEPARATOR = String.fromCharCode(0x1f);

/**
 * Upper bound for `max_challengers`, mirroring the contract's `MAX_CHALLENGERS`.
 * The on-chain `create_claim` rejects anything above it, so a value past this
 * would fail every create at runtime instead of at boot.
 */
export const CONTRACT_MAX_CHALLENGERS = 100;

/**
 * Parse `MARKET_CREATOR_MAX_CHALLENGERS` into a usable challenger cap.
 *
 * Exported so the boot-time validation can be unit tested without spinning up
 * the worker. A malformed value must fail closed: silently falling back to the
 * default would let a typo'd cap diverge from what the proposal queue records.
 */
export function parseMaxChallengers(
  raw: string | undefined,
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = (raw ?? "").trim();
  const source = trimmed === "" ? "10" : trimmed;
  const value = Number(source);
  if (!Number.isInteger(value)) {
    return {
      ok: false,
      error: `MARKET_CREATOR_MAX_CHALLENGERS must be an integer, got "${raw}"`,
    };
  }
  if (value < 1 || value > CONTRACT_MAX_CHALLENGERS) {
    return {
      ok: false,
      error:
        `MARKET_CREATOR_MAX_CHALLENGERS must be between 1 and ` +
        `${CONTRACT_MAX_CHALLENGERS} (contract MAX_CHALLENGERS), got ${value}`,
    };
  }
  return { ok: true, value };
}

const _maxChallengers = parseMaxChallengers(process.env.MARKET_CREATOR_MAX_CHALLENGERS);
if (!_maxChallengers.ok) {
  throw new Error(`[market-creator] ${_maxChallengers.error}`);
}
const CRYPTO_MIN_THRESHOLD_RATIO = Number(process.env.CRYPTO_MIN_THRESHOLD_RATIO ?? "0.65");
const CRYPTO_MAX_THRESHOLD_RATIO = Number(process.env.CRYPTO_MAX_THRESHOLD_RATIO ?? "1.35");
const CREATE_DELAY_MS = Number(process.env.MARKET_CREATE_DELAY_MS ?? "600000");
/**
 * Who collects the agent-owner fee on markets this agent opens.
 *
 * The contract FREEZES this onto the claim at creation — a market opened with no
 * recipient can never pay an owner fee, however the policy changes later. So this
 * has to be right the first time, which is why it is not left to a default.
 *
 * There is no zero-address sentinel on Stellar: `agent_owner_recipient` is an
 * `Option<Address>`, so "nobody" is `undefined`, not a magic 20 zero bytes. An
 * unset or malformed value therefore resolves to `undefined` here rather than to
 * an address that silently burns the fee.
 */
function resolveFeeRecipient(): string | undefined {
  const configured = (process.env.MARKET_CREATOR_FEE_RECIPIENT ?? process.env.CREATOR_PUBLIC ?? "")
    .split(/\s+#/)[0]
    .trim();
  if (!configured) return undefined;
  if (!isAccountAddress(configured) && !isContractAddress(configured)) {
    console.warn(
      `[market-creator] MARKET_CREATOR_FEE_RECIPIENT "${configured}" is not a Stellar address — ` +
        `markets will be opened with no agent-owner fee recipient.`,
    );
    return undefined;
  }
  return configured;
}
const FEE_RECIPIENT = resolveFeeRecipient();
const CANCEL_DELAY_MS = Number(process.env.MARKET_CANCEL_DELAY_MS ?? "60000");
const PREFLIGHT_ENABLED =
  false ||
  process.env.MARKET_CREATOR_PREFLIGHT === "1" || Boolean(process.env.MIMIR_BASE_URL?.trim());
const PREFLIGHT_BASE_URL = process.env.MIMIR_BASE_URL ?? "http://localhost:3000";
const PREFLIGHT_MIN_SCORE = Number(process.env.MARKET_CREATOR_PREFLIGHT_MIN_SCORE ?? "60");
const PREFLIGHT_CAP_USDC = Number(process.env.MARKET_CREATOR_PREFLIGHT_CAP_USDC ?? "0.005");
const PREFLIGHT_PERSONAS = process.env.MARKET_CREATOR_PREFLIGHT_PERSONAS;
const PREFLIGHT_DELAY_MS = Number(process.env.MARKET_CREATOR_PREFLIGHT_DELAY_MS ?? "30000");

requireEnv(["CREATOR_SECRET"]);
requireAnyLLMKey();

// ── Clients ───────────────────────────────────────────────────────────────────
const CREATOR        = getCreatorWallet();
const CREATOR_ADDR   = CREATOR.address;
const CREATOR_PAYER  = payingWalletFor(CREATOR);

// ── Types ─────────────────────────────────────────────────────────────────────

// ── Source fetchers ───────────────────────────────────────────────────────────

async function applyCouncilPreflight(candidates: ClaimCandidate[]): Promise<ClaimCandidate[]> {
  if (!PREFLIGHT_ENABLED || candidates.length === 0) {
    return candidates;
  }
  if (!SIDE_EFFECTS.paidPreflight) {
    console.log(
      `[market-creator] DRY_RUN — skipping paid council preflight for ${candidates.length} candidate(s).`,
    );
    return candidates;
  }

  const kept: Array<{ candidate: ClaimCandidate; score: number }> = [];
  console.log(
    `[market-creator] Buying council preflight for ${candidates.length} candidate(s) ` +
    `(min score ${PREFLIGHT_MIN_SCORE}, ${PREFLIGHT_DELAY_MS / 1000}s persona gap)...`,
  );

  for (const candidate of candidates) {
    const result = await gatherCouncilPreflight({
      candidate,
      baseUrl: PREFLIGHT_BASE_URL,
      payer: CREATOR_PAYER,
      personaCsv: PREFLIGHT_PERSONAS,
      capUsdc: PREFLIGHT_CAP_USDC,
      delayMs: PREFLIGHT_DELAY_MS,
    }).catch((err) => {
      console.warn(
        `[market-creator] Council preflight failed for "${candidate.question.slice(0, 70)}...":`,
        err instanceof Error ? err.message : err,
      );
      return null;
    });

    if (!result || result.opinions.length === 0 || result.averageScore === null) {
      console.warn(
        `[market-creator] Council preflight unavailable; keeping candidate: ${candidate.question.slice(0, 70)}...`,
      );
      kept.push({ candidate, score: candidate.qualityScore });
      continue;
    }

    const paidUsdc = unitsToUsdc(result.totalPaidUnits);
    const avg = Math.round(result.averageScore);
    console.log(
      `[market-creator] Council preflight ${avg}/100 ` +
      `(open=${result.openVotes}, revise=${result.reviseVotes}, skip=${result.skipVotes}, paid=${paidUsdc.toFixed(6)} USDC) ` +
      `for "${candidate.question.slice(0, 70)}..."`,
    );

    if (avg < PREFLIGHT_MIN_SCORE || result.skipVotes > result.openVotes + result.reviseVotes) {
      console.warn(
        `[market-creator] Drop candidate after council preflight (${avg}/100): ${candidate.question.slice(0, 90)}`,
      );
      continue;
    }

    // The named dimensions are the real gate: a blended average lets a market
    // nobody can settle through on the strength of its sources. The blocker is
    // logged rather than swallowed so a repeated failure names its own cause.
    //
    // A persona fleet that predates the dimensions returns none of them. Treating
    // that as "all four failed" would silently stop creation altogether, so the
    // gate is skipped — loudly — and the blended average above stands alone.
    if (!dimensionsReported(result.verdict)) {
      console.warn(
        "[market-creator] Preflight returned no named dimensions; falling back to the blended score. " +
        "Update the persona preflight prompt to restore the dimension gate.",
      );
    } else if (!result.verdict.autonomousOk) {
      console.warn(
        `[market-creator] Drop candidate — preflight dimension gate: ${result.verdict.blockedBy} ` +
        `(clarity=${result.verdict.dimensions.resolutionClarity.score ?? "?"}, ` +
        `sources=${result.verdict.dimensions.sourceIndependence.score ?? "?"}, ` +
        `liquidity=${result.verdict.dimensions.liquidityFit.score ?? "?"}, ` +
        `mode=${result.verdict.dimensions.bestMode.score ?? "?"}) ` +
        `for "${candidate.question.slice(0, 70)}..."`,
      );
      continue;
    }

    // Blend draft quality and paid council judgment so high-consensus markets
    // are created first when headroom is tight.
    kept.push({
      candidate,
      score: Math.round(candidate.qualityScore * 0.6 + avg * 0.4),
    });
  }

  return kept
    .sort((a, b) => b.score - a.score)
    .map((item) => item.candidate);
}

async function fetchCryptoEvents(): Promise<{ text: string; events: CryptoEvent[] }> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&sparkline=false",
      { headers: { "User-Agent": "Mimir-MarketCreator/1.0" } }
    );
    const coins = await res.json() as any[];
    const events: CryptoEvent[] = (Array.isArray(coins) ? coins : []).map((c: any) => ({
      id:            String(c.id ?? ""),
      name:          String(c.name ?? ""),
      symbol:        String(c.symbol ?? "").toUpperCase(),
      // CoinGecko URLs with /coins/<slug> hit the deterministic API path in
      // lib/server/evidence-fetcher.ts. Always use the slug, never the symbol.
      resolutionUrl: c.id ? `https://www.coingecko.com/en/coins/${c.id}` : "",
      priceUsd:      Number(c.current_price ?? 0),
    })).filter((e) => e.id && e.resolutionUrl);

    const text = events.map((c) =>
      `${c.name} (${c.symbol}, slug=${c.id}): $${c.priceUsd.toFixed(2)}`
    ).join("\n");
    return { text: text || "Crypto data unavailable", events };
  } catch {
    return {
      text: "BTC: ~$95,000, ETH: ~$3,500, SOL: ~$180 (live data unavailable)",
      events: [],
    };
  }
}

// Generic ESPN scoreboard reader. Pulls scheduled (not-started) games for any
// sport/league. Live games make deadline math uncertain and finished games
// resolve immediately — both are dead inventory, so we keep only `pre` state.
const SPORTS_POST_GAME_BUFFER_MS = 4 * 3600 * 1000;

async function fetchEspnScoreboard(
  url: string,
  fallbackName: string,
  matchPath: string,
): Promise<SportEvent[]> {
  try {
    const nowMs = Date.now();
    const latestStartMs = nowMs + MAX_DEADLINE_HOURS * 3600 * 1000 - SPORTS_POST_GAME_BUFFER_MS;
    const res = await fetch(url, { headers: { "User-Agent": "Mimir-MarketCreator/1.0" } });
    const data = (await res.json()) as any;
    const all = (data.events ?? []) as any[];
    const scheduled = all
      .filter((e: any) => e.status?.type?.state === "pre" && !e.status?.type?.completed)
      .slice(0, 6);

    return scheduled
      .map((e: any) => {
        const links = Array.isArray(e.links) ? e.links : [];
        // Prefer a post-game page (summary/boxscore/recap) — it carries the
        // final result the oracle reads. Fall back to a constructed match URL.
        const post = links.find(
          (l: any) =>
            Array.isArray(l.rel) &&
            (l.rel.includes("summary") || l.rel.includes("boxscore") || l.rel.includes("recap")),
        )?.href;
        const resolutionUrl = post || `https://www.espn.com/${matchPath}/_/gameId/${e.id}`;
        return {
          id:            String(e.id ?? ""),
          name:          String(e.name ?? fallbackName),
          startDate:     String(e.date ?? ""),
          startMs:       Date.parse(String(e.date ?? "")),
          resolutionUrl,
          status:        String(e.status?.type?.detail ?? "scheduled"),
        };
      })
      .filter((ev) =>
        ev.id &&
        ev.resolutionUrl &&
        Number.isFinite(ev.startMs) &&
        ev.startMs > nowMs &&
        ev.startMs <= latestStartMs
      );
  } catch (err) {
    console.warn(`[market-creator] ESPN fetch failed (${url}):`, err);
    return [];
  }
}

async function fetchSportsEvents(): Promise<{ text: string; events: SportEvent[] }> {
  // World Cup first (timely + high interest), then NBA. The off-season sport
  // simply returns nothing and drops out.
  const [worldCup, nba] = await Promise.all([
    fetchEspnScoreboard(
      "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard",
      "World Cup match",
      "soccer/match",
    ),
    fetchEspnScoreboard(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
      "NBA game",
      "nba/boxscore",
    ),
  ]);

  const events = [...worldCup, ...nba].slice(0, 8);
  if (events.length === 0) return { text: "No upcoming games found", events: [] };

  const text = events.map((ev) => `${ev.name} — starts ${ev.startDate} — ${ev.status}`).join("\n");
  return { text, events };
}

// A fixed roster of liquid large-caps. No live price feed is needed: claims are
// framed as intraday direction ("up on the day at the deadline?"), which the
// oracle reads off the stockanalysis.com page's day-change. Markets closed →
// the LLM still drafts forward-looking ones; low-confidence ones refund.
const STOCK_TICKERS: Array<{ symbol: string; name: string }> = [
  { symbol: "AAPL", name: "Apple" },
  { symbol: "NVDA", name: "NVIDIA" },
  { symbol: "TSLA", name: "Tesla" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "GOOGL", name: "Alphabet" },
  { symbol: "AMZN", name: "Amazon" },
];

function fetchStockEvents(): { text: string; events: StockEvent[] } {
  const events: StockEvent[] = STOCK_TICKERS.map((s) => ({
    symbol:        s.symbol,
    name:          s.name,
    resolutionUrl: `https://stockanalysis.com/stocks/${s.symbol.toLowerCase()}/`,
  }));
  const text = events.map((e) => `${e.name} (${e.symbol}) → ${e.resolutionUrl}`).join("\n");
  return { text, events };
}

// ── Claude drafts claims ──────────────────────────────────────────────────────

// ── Create claim on-chain ─────────────────────────────────────────────────────

/**
 * Open one market. Returns the explorer link on success, null on refusal.
 *
 * The 18-element positional tuple the EVM ABI required is gone: the generated
 * bindings take a NAMED `CreateParams` struct, so the bug class that hid here —
 * flat args encoded against a one-parameter function, invisible until autonomous
 * mode was first enabled because shadow mode never reached the call — is now a
 * compile error instead of a runtime rejection.
 */
async function createClaim(candidate: ClaimCandidate): Promise<string | null> {
  // Floor the WHOLE expression: sports candidates get kickoff-pinned
  // fractional deadlineHours, and the contract takes whole seconds.
  const deadline = Math.floor(Date.now() / 1000 + candidate.deadlineHours * 3600);

  const params: CreateClaimParams = {
    question:              candidate.question,
    creator_position:      candidate.creatorPosition,
    counter_position:      candidate.counterPosition,
    resolution_url:        candidate.resolutionUrl,
    deadline,
    stake_amount:          CREATOR_STAKE_USDC,
    category:              candidate.category,
    market_type:           candidate.marketType,
    odds_mode:             "pool",
    settlement_rule:       candidate.settlementRule,
    max_challengers:       100,
    visibility:            "public",
    agent_owner_recipient: FEE_RECIPIENT,
  };

  if (!SIDE_EFFECTS.createClaim) {
    console.log(`[market-creator] DRY_RUN — would call create_claim with:`);
    console.log(`[market-creator] ${JSON.stringify(params)}`);
    return "(dry-run)";
  }

  // Check the USDC bankroll. Fees are XLM and separate, so staking cannot strand
  // the creator for fees.
  const balances = await readAgentBalances(CREATOR_ADDR);
  if (balances.usdc === null) {
    console.warn(`[market-creator] No USDC trustline — run "npm run agents:fund"`);
    return null;
  }
  if (balances.usdc < CREATOR_STAKE_USDC * 2) {
    console.warn(
      `[market-creator] Insufficient USDC (${balances.usdc.toFixed(2)}) for ${candidate.question.slice(0, 40)}`
    );
    return null;
  }

  try {
    const rawResult = await withBackoff("market_creator", () => createClaimOnChain(CREATOR.signer, {
      question:              candidate.question,
      creator_position:      candidate.creatorPosition,
      counter_position:      candidate.counterPosition,
      resolution_url:        candidate.resolutionUrl,
      deadline,
      stake_amount:          CREATOR_STAKE_USDC,
      category:              candidate.category,
      market_type:           candidate.marketType,
      odds_mode:             "pool",
      settlement_rule:       candidate.settlementRule,
      max_challengers:       DEFAULT_MAX_CHALLENGERS,
      visibility:            "public",
      agent_owner_recipient: FEE_RECIPIENT,
    }), { policy: CREATOR_BACKOFF });
    const result = rawResult as { claimId: number; txHash: string; explorerUrl?: string } | undefined;
    if (!result) return null;
    console.log(`[market-creator]   claim id #${result.claimId}`);
    return result.explorerUrl ?? result.txHash;
  } catch (err) {
    if (err instanceof BackoffError) {
      console.warn(`[market-creator] ${describeBackoffError(err)}`);
      return null;
    }
    console.error(`[market-creator] Failed to create claim:`, err);
    return null;
  }
}

// ── Cancel sweep + joinable count ─────────────────────────────────────────────
// `cancelClaim` is creator-only and only valid while the claim is still OPEN
// (no challengers). It has no deadline guard, so we add one ourselves: only
// cancel claims whose deadline has passed — otherwise we'd kill markets that
// might still get a challenger. Stake is refunded by the contract on cancel.
//
// The same single-pass walk also counts JOINABLE claims (state ∈ {OPEN,ACTIVE}
// && deadline > now). This is the right inventory signal — getPlatformStats
// returns `claimCount - totalResolved`, which lumps CANCELLED and abandoned
// expired-OPEN claims (created by other addresses, no challenger, no
// cancellation rights) into "unresolved" and falsely saturates the cap.
//
// `capSourceAvailable` is false when the walk could not produce a usable
// snapshot. The caller must read that as "skip this run", never as "no open
// markets" — the latter silently disables every cap computed from the snapshot.

async function sweepAndCount(): Promise<{ cancelled: number; joinable: number; joinableClaims: ExistingClaimSignature[]; creatorExposureClaims: CategoryExposureClaim[]; capSourceAvailable: boolean }> {
  let total: number;
  try {
    total = await getClaimCount();
  } catch (err) {
    console.warn("[market-creator] Failed to read the claim count for sweep:", err);
    return {
      cancelled: 0,
      joinable: 0,
      joinableClaims: [],
      creatorExposureClaims: [],
      capSourceAvailable: false,
    };
  }
  if (!Number.isFinite(total) || total < 0) {
    console.warn(
      `[market-creator] Claim count ${String(total)} is not a usable total — ` +
        `treating the cap snapshot as unavailable.`,
    );
    return {
      cancelled: 0,
      joinable: 0,
      joinableClaims: [],
      creatorExposureClaims: [],
      capSourceAvailable: false,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  let cancelled = 0;
  let joinable = 0;
  const joinableClaims: ExistingClaimSignature[] = [];
  const creatorExposureClaims: CategoryExposureClaim[] = [];

  for (let id = 1; id <= total; id++) {
    // One read for the whole claim, and it comes back with NAMED fields — so the
    // `claim[8]` / `claim[9]` / `claim[13]` positional indexing that a struct
    // reorder would have silently shifted is gone.
    const claim = await readClaimRaw(id);
    if (!claim) continue;

    if ((claim.state === "open" || claim.state === "active") && claim.deadline > now) {
      joinable++;
      joinableClaims.push({
        id,
        category:         claim.category.toLowerCase().trim(),
        questionKey:      normalizeComparableText(claim.question),
        resolutionUrlKey: normalizeResolutionUrl(claim.resolution_url),
      });
    }

    // Snapshot every claim for exposure accounting. Filtering (creator, live
    // state, deadline, malformed stakes) happens in sumCreatorOpenExposure so
    // the worker and the unit tests share one definition of "open exposure".
    // The category rides along so the same snapshot can be bucketed per
    // category without a second claim walk.
    creatorExposureClaims.push({
      id,
      creator: claim.creator,
      state: claim.state,
      deadline: claim.deadline,
      creatorStakeUsdc: claim.creator_stake,
      reservedCreatorLiabilityUsdc: claim.reserved_creator_liability,
      category: String(claim.category ?? ""),
    });

    // EXACT comparison: a Stellar `G…` strkey is case-sensitive base32, so
    // lowercasing both sides (as the EVM version did) would match nothing and the
    // creator would never sweep its own stale markets.
    if (claim.creator !== CREATOR_ADDR) continue;
    if (claim.state !== "open") continue;
    if (claim.deadline > now) continue;

    if (!SIDE_EFFECTS.cancelClaim) {
      console.log(
        `[market-creator] DRY_RUN — would cancel stale claim #${id} (expired, no challenger)`,
      );
      continue;
    }

    console.log(`[market-creator] Cancelling stale claim #${id} (expired, no challenger)`);
    try {
      const rawResult = await withBackoff("market_creator", () => cancelClaim(CREATOR.signer, id), {
        policy: CREATOR_BACKOFF,
      });
      const result = rawResult as { txHash: string; explorerUrl?: string } | undefined;
      if (!result) continue;
      console.log(`[market-creator] ✓ Cancelled #${id} — ${result.explorerUrl ?? result.txHash}`);
      cancelled++;
      if (CANCEL_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, CANCEL_DELAY_MS));
      }
    } catch (err) {
      if (err instanceof BackoffError) {
        console.warn(`[market-creator] ${describeBackoffError(err)}`);
      } else {
        console.error(`[market-creator] Failed to cancel #${id}:`, err);
      }
    }
  }
  return { cancelled, joinable, joinableClaims, creatorExposureClaims, capSourceAvailable: true };
}

/**
 * Persist one proposal in the canonical mode schema.
 *
 * Never throws: a worker must not stop creating markets because the proposal log is
 * unreachable. A missing proposal costs precision measurement; a crashed worker
 * costs the whole run.
 *
 * Proposals enter the review queue with status 'queued' — human review (or an
 * automated policy) must approve before publish when not in autonomous mode.
 */
async function recordProposal(
  candidate: ClaimCandidate,
  disposition: "create" | "shadow",
): Promise<string | null> {
  const deadline = Math.floor(Date.now() / 1000) + Math.round(candidate.deadlineHours * 3600);
  const mode = toCanonicalMode({
    marketType: candidate.marketType,
    oddsMode: "pool",
    maxChallengers: DEFAULT_MAX_CHALLENGERS,
  });
  // Deterministic id from the market's identity, so a retried run inserts nothing
  // new — shadow precision must not be measured against duplicates.
  const proposalId = sha256Hex(
    [candidate.question, candidate.resolutionUrl, String(deadline), candidate.category].join(
      UNIT_SEPARATOR,
    ),
  );

  try {
    await insertMarketProposal({
      proposal_id: proposalId,
      created_at: Date.now(),
      question: candidate.question,
      creator_position: candidate.creatorPosition,
      counter_position: candidate.counterPosition,
      category: candidate.category,
      subject_type: mode.subjectType,
      settlement_mode: mode.settlementMode,
      product_modifiers: mode.productModifiers,
      mode_rationale:
        mode.unsupported !== undefined
          ? `unsupported stored rules: ${JSON.stringify(mode.unsupported)}`
          : `public multi-participant topic drafted from ${candidate.sourceType}`,
      stake_policy: {
        creatorStakeUsdc: CREATOR_STAKE_USDC,
        maxChallengers: DEFAULT_MAX_CHALLENGERS,
        challengerPayoutBps: 0,
      },
      context_pack_hash: null,
      resolution_url: candidate.resolutionUrl,
      settlement_rule: candidate.settlementRule,
      deadline,
      quality_score: candidate.qualityScore,
      preflight_verdict: {},
      disposition,
      blocked_by: null,
      claim_id: null,
      review_status: "queued",
      queued_at: Date.now(),
      claimed_at: null,
      reviewed_at: null,
      reviewer: null,
      failure_reason: null,
    });
    return proposalId;
  } catch (err) {
    console.warn(
      "[market-creator] Proposal log unavailable; continuing without it:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const balances = await readAgentBalances(CREATOR_ADDR);

  console.log(`\n[market-creator] ── Run at ${new Date().toISOString()}`);
  console.log(`[market-creator] Creator : ${CREATOR_ADDR}`);
  console.log(
    `[market-creator] Balance : ${(balances.xlm ?? 0).toFixed(4)} XLM · ` +
      `${balances.usdc === null ? "no USDC trustline" : `${balances.usdc.toFixed(4)} USDC`}`,
  );

  // Single-pass sweep: cancels creator's stale expired-OPEN claims AND counts
  // joinable inventory (state ∈ {OPEN,ACTIVE} && deadline > now) on the same
  // claim walk. Joinable count drives the cap — getPlatformStats was wrong
  // here because it counted CANCELLED and abandoned expired-OPEN claims as
  // "unresolved" and deadlocked the creator at the cap forever.
  const { cancelled, joinable, joinableClaims, creatorExposureClaims, capSourceAvailable } =
    await sweepAndCount();

  const nowSeconds = Math.floor(Date.now() / 1000);
  // Every cap below is computed from this snapshot. If the claim walk did not
  // produce one, publishing without the check would be worse than not
  // publishing: it would fail open on the exposure ceiling AND the per-category
  // caps. So the run is skipped, not degraded.
  const capSummary = summariseCreatorCaps({
    available: capSourceAvailable,
    claims: creatorExposureClaims,
    creatorAddress: CREATOR_ADDR,
    nowSeconds,
  });
  if (!capSummary.publishable) {
    console.warn(
      "[market-creator] Claim snapshot unavailable — per-category caps cannot be " +
        "resolved. Skipping this run instead of publishing without a cap check (fail closed).",
    );
    return;
  }

  if (cancelled > 0) {
    console.log(`[market-creator] Cancelled ${cancelled} stale claim(s) — stake refunded.`);
  }

  const exposureSum = sumCreatorOpenExposure({
    claims: creatorExposureClaims,
    creatorAddress: CREATOR_ADDR,
    nowSeconds,
  });
  let openExposureUsdc = exposureSum.openExposureUsdc;
  const exposureSlots = marketsRemainingUnderCap({
    openExposureUsdc,
    stakeUsdc: CREATOR_STAKE_USDC,
    maxOpenExposureUsdc: MAX_OPEN_EXPOSURE_USDC,
  });
  console.log(
    `[market-creator] Creator open exposure: ${openExposureUsdc.toFixed(4)} USDC ` +
      `(cap: ${MAX_OPEN_EXPOSURE_USDC}, live claims: ${exposureSum.countedClaimIds.length}, ` +
      `slots left: ${exposureSlots})`,
  );
  const categorySummary = Object.entries(capSummary.byCategory)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, bucket]) => `${category}=${bucket.openMarkets}/${bucket.openExposureUsdc} USDC`)
    .join(", ");
  console.log(`[market-creator] Open by category: ${categorySummary || "none"}`);
  if (capSummary.unclassifiedClaimIds.length > 0) {
    // Not attributed to any per-category cap; they still count toward the global
    // exposure ceiling above, so this is a visibility note rather than a hole.
    console.warn(
      `[market-creator] ${capSummary.unclassifiedClaimIds.length} live claim(s) have no ` +
        `usable category and are not attributed to a per-category cap.`,
    );
  }
  if (exposureSlots <= 0) {
    console.log(
      `[market-creator] Open exposure ≥ cap — skipping this run ` +
        `(${openExposureUsdc} / ${MAX_OPEN_EXPOSURE_USDC} USDC).`,
    );
    return;
  }

  console.log(`[market-creator] Joinable on-chain: ${joinable} (cap: ${MAX_ACTIVE_CLAIMS})`);
  if (joinable >= MAX_ACTIVE_CLAIMS) {
    console.log(`[market-creator] Inventory ≥ cap — skipping this run.`);
    return;
  }
  const headroom = Math.max(0, MAX_ACTIVE_CLAIMS - joinable);
  const toCreate = Math.min(MAX_CLAIMS_PER_RUN, headroom, exposureSlots);

  // Fetch source data in parallel
  console.log("[market-creator] Fetching market data...");
  const [crypto, sports, weather, launches] = await Promise.all([
    fetchCryptoEvents(),
    fetchSportsEvents(),
    fetchWeatherEvents(),
    fetchLaunchEvents(),
  ]);
  const stocks = fetchStockEvents();
  console.log(
    `[market-creator] Sources: crypto=${crypto.events.length} pairs, ` +
    `sports=${sports.events.length} games, stocks=${stocks.events.length} tickers, ` +
    `weather=${weather.events.length} cities, launches=${launches.events.length}`
  );

  console.log("[market-creator] Drafting claim candidates...");
  const draftedCandidates = await draftClaimCandidates({
    cryptoText:   crypto.text,
    cryptoEvents: crypto.events,
    sportsText:   sports.text,
    sportsEvents: sports.events,
    stocksText:   stocks.text,
    stocksEvents: stocks.events,
    weatherText:   weather.text,
    weatherEvents: weather.events,
    launchText:    launches.text,
    launchEvents:  launches.events,
  });
  const candidates = filterDuplicateCandidates(draftedCandidates, joinableClaims);

  if (candidates.length === 0) {
    console.log("[market-creator] No high-quality candidates this run.");
    return;
  }

  const approvedCandidates = await applyCouncilPreflight(candidates);

  if (approvedCandidates.length === 0) {
    console.log("[market-creator] No candidates passed council preflight this run.");
    return;
  }

  console.log(`[market-creator] ${approvedCandidates.length} candidates ready to create:`);
  approvedCandidates.forEach((c, i) => {
    console.log(`  ${i + 1}. [${c.qualityScore}] ${c.question.slice(0, 70)}...`);
  });

  let created = 0;
  const selected = approvedCandidates.slice(0, toCreate);
  for (let i = 0; i < selected.length; i++) {
    const candidate = selected[i];

    const exposureGate = checkCreatorExposureCap({
      openExposureUsdc,
      stakeUsdc: CREATOR_STAKE_USDC,
      maxOpenExposureUsdc: MAX_OPEN_EXPOSURE_USDC,
    });
    if (!exposureGate.allowed) {
      console.log(
        `[market-creator] Exposure cap blocks further creates — ${exposureGate.blockedBy} ` +
          `(policy max ${CREATOR_POLICY.maxOpenExposureUsdc} USDC).`,
      );
      break;
    }

    // Per-category cap + operational kill switch for the candidate's category.
    // `continue` rather than `break`: a full crypto bucket does not mean a
    // weather candidate is over its own cap. The bucket read is refreshed
    // optimistically after each successful create below.
    const categoryKey = normalizeCategory(candidate.category);
    const categoryBucket =
      (categoryKey ? capSummary.byCategory[categoryKey] : undefined) ?? {
        openMarkets: 0,
        openExposureUsdc: 0,
        claimIds: [],
      };
    const categoryGate = checkCategoryCreatorCap({
      category: candidate.category,
      policy: CREATOR_POLICY.categoryCaps,
      openMarkets: categoryBucket.openMarkets,
      openExposureUsdc: categoryBucket.openExposureUsdc,
      stakeUsdc: CREATOR_STAKE_USDC,
      // Same source of truth the API write paths use, so one env var stops a
      // category everywhere instead of only on the browser path.
      categoryEnabled: isCategoryEnabled(candidate.category),
    });
    if (!categoryGate.allowed) {
      console.log(`[market-creator] Per-category cap blocks this candidate — ${categoryGate.blockedBy}`);
      continue;
    }

    // Record the decision in the canonical schema BEFORE acting on it (§10.4), so
    // a run that dies mid-create still leaves the proposal it was acting on.
    const proposalId = await recordProposal(candidate, SHADOW_MODE ? "shadow" : "create");

    if (SHADOW_MODE) {
      // The roadmap's gate: proposal-only until shadow precision is measured
      // against human review. Nothing is published, and the proposal says why.
      console.log(
        `[market-creator] SHADOW — proposed only, not published: "${candidate.question.slice(0, 60)}..." ` +
          `(proposal ${proposalId ?? "unrecorded"})`,
      );
      continue;
    }

    console.log(`\n[market-creator] Creating: "${candidate.question.slice(0, 60)}..."`);
    const link = await createClaim(candidate);
    if (link) {
      console.log(`[market-creator] ✓ Created — ${link}`);
      created++;
      // Optimistic local accounting: the next iteration must not wait for another
      // full claim walk to honour the cap inside this run.
      openExposureUsdc = exposureGate.nextExposureUsdc;
      bumpCategoryUsage(capSummary.byCategory, candidate.category, CREATOR_STAKE_USDC);
    }
    if (i < selected.length - 1 && CREATE_DELAY_MS > 0) {
      console.log(`[market-creator] Cooling down ${(CREATE_DELAY_MS / 60000).toFixed(1)} min before next market...`);
      await new Promise((r) => setTimeout(r, CREATE_DELAY_MS));
    }
  }

  if (SHADOW_MODE) {
    console.log(
      `[market-creator] SHADOW MODE — ${selected.length} proposal(s) recorded, 0 published. ` +
        `Set MARKET_CREATOR_AUTONOMOUS=1 once review precision has been measured.`,
    );
  } else {
    const verb = DRY_RUN ? "Would create" : "Created";
    console.log(`\n[market-creator] ${verb} ${created}/${approvedCandidates.length} approved markets this run.`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const balances = await readAgentBalances(CREATOR_ADDR);
  if (!balances.exists) {
    throw new Error(
      `creator account ${CREATOR_ADDR} does not exist on the ledger — run: npm run agents:fund`,
    );
  }

  console.log("═══════════════════════════════════════════════");
  console.log("  Mimir Market Creator Agent (local Stellar keypair signer)");
  console.log(`  Contract   : ${CONTRACT_ID}`);
  console.log(`  Creator    : ${CREATOR_ADDR}`);
  console.log(`  Fees       : ${(balances.xlm ?? 0).toFixed(4)} XLM`);
  console.log(`  Bankroll   : ${balances.usdc === null ? "no USDC trustline" : `${balances.usdc.toFixed(4)} USDC`}`);
  console.log(`  Fee to     : ${FEE_RECIPIENT ?? "(none — markets pay no agent-owner fee)"}`);
  console.log(`  Network    : Stellar ${STELLAR_NETWORK}`);
  console.log(`  LLM        : ${activeLLMProvider()} / ${activeLLMModel()} · key=${activeLLMKeyFingerprint()}`);
  console.log(`  Stake/mkt  : ${CREATOR_STAKE_USDC} USDC`);
  console.log(`  Max/run    : ${MAX_CLAIMS_PER_RUN} claims`);
  console.log(`  Active cap : ${MAX_ACTIVE_CLAIMS} unresolved (skip run above this)`);
  console.log(`  Challengers: ${DEFAULT_MAX_CHALLENGERS} per market (contract max ${CONTRACT_MAX_CHALLENGERS})`);
  console.log(`  Exposure   : ${MAX_OPEN_EXPOSURE_USDC} USDC open-creator ceiling`);
  console.log(`  Cat caps   : ${describeCategoryCapPolicy(CREATOR_POLICY.categoryCaps)}`);
  console.log(`  Preflight  : ${PREFLIGHT_ENABLED ? `on via ${PREFLIGHT_BASE_URL}` : "off"}`);
  console.log(`  Dry run    : ${DRY_RUN ? "on — no transactions, no x402 payments" : "off"}`);
  console.log(`  Create gap : ${CREATE_DELAY_MS / 1000}s`);
  console.log(`  Cancel gap : ${CANCEL_DELAY_MS / 1000}s`);
  console.log(`  Interval   : every ${RUN_INTERVAL_HOURS}h`);
  console.log(`  Run jitter : ±${(POLL_JITTER_MS / 1000).toFixed(0)}s`);
  console.log("═══════════════════════════════════════════════\n");

  const safeRun = () =>
    reportingPoll("market_creator", "market-creator", RUN_INTERVAL_HOURS * 3600, run, {
      pause: "market_creator_worker",
    });

  await runWorkerLoop({
    worker: "market_creator",
    intervalMs: RUN_INTERVAL_MS,
    jitterMs: POLL_JITTER_MS,
    cycle: safeRun,
  });
}

main().catch((err) => {
  console.error("[market-creator] Fatal:", err);
  process.exit(1);
});

