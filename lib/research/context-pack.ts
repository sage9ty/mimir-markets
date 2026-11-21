/**
 * MarketContextPack — everything needed to decide whether a claim is resolvable,
 * captured at the moment it was proposed.
 *
 * Two ideas drive the shape:
 *
 *  1. **A market is only as good as its resolution rule.** Most "the oracle got it
 *     wrong" disputes are really "the rule was ambiguous". So the pack forces the
 *     ambiguities out into named fields — threshold, units, rounding, timezone,
 *     geographic scope, void rule — instead of leaving them implied by prose.
 *
 *  2. **Only a hash goes on chain.** Storing the pack itself would be enormous and
 *     immutable-by-accident. `contextPackHash()` is a deterministic digest over
 *     canonically-ordered fields, so anyone holding the pack can prove it is the
 *     one the market committed to, while the pack stays editable off chain through
 *     explicit, audited versions.
 *
 * A source that later disappears is why `contentHash` and `excerpt` are captured
 * per source: the market can still be settled against what was actually read.
 */

import { isHash32Hex, sha256Hex } from "@/lib/content-hash";
import type { SubjectType } from "../market-modes";

export const CONTEXT_PACK_VERSION = 1;

export type TrustTier =
  /** The rule names this source as the one that decides. */
  | "primary"
  /** Independently confirms the primary. */
  | "corroborating"
  /** Read, but not trusted to decide anything. */
  | "unverified";

export interface ContextSource {
  url: string;
  domain: string;
  trustTier: TrustTier;
  /** When the gateway fetched it, epoch ms. */
  capturedAt: number;
  /** SHA-256 of the captured body, bare hex — survives the source going away. */
  contentHash: string;
  /** Short quote or structured fact the claim rests on. */
  excerpt: string;
  /** Source's own publication time when it exposes one, epoch ms. */
  publishedAt?: number;
  /** Timezone the source reports its times in, e.g. "UTC", "America/New_York". */
  sourceTimezone?: string;
}

/**
 * The parts of a settlement rule that are usually left implicit and then argued
 * about. Every field here is a question an oracle would otherwise have to guess.
 */
export interface ResolutionSpec {
  /** Plain-language rule, as it will be shown and committed. */
  rule: string;
  /** The comparison value, when the claim is numeric. */
  threshold?: number;
  /** What the threshold is measured in, e.g. "USD", "mm", "goals". */
  units?: string;
  /** How to round before comparing, e.g. "none", "2dp", "nearest integer". */
  rounding?: string;
  /** Which side of an exact tie wins. Ties are the classic dispute. */
  tieBreak?: "creator" | "challengers" | "draw";
  /** Timezone the deadline and any daily boundary are evaluated in. */
  timezone: string;
  /** Where the claim applies, when that could differ, e.g. "US only". */
  geographicScope?: string;
  /** Seconds after the deadline in which the source is expected to publish. */
  resolutionWindowSeconds?: number;
  /** Conditions under which the market refunds instead of picking a side. */
  voidRule?: string;
  /** Known edge cases the rule deliberately covers. */
  edgeCases: string[];
}

export interface MarketContextPack {
  packVersion: number;
  /** The claim as it will be published, already normalised. */
  claim: string;
  creatorPosition: string;
  counterPosition: string;
  subjectType: SubjectType;
  category: string;
  /** Entities the claim is about — used for duplicate detection, not display. */
  entities: string[];
  /** Deadline as a unix second, matching the contract. */
  deadline: number;
  resolution: ResolutionSpec;
  /** The one source the rule names as deciding. */
  primarySource: ContextSource;
  corroboratingSources: ContextSource[];
  /** The proposing agent's own confidence, in basis points. */
  confidenceBps: number;
  /** What the agent could not determine. Required — an empty list is a claim. */
  unresolvedQuestions: string[];
  createdAt: number;
  /** Bumped when the primary source or the rule changes. */
  revision: number;
}

// ── Freshness and corroboration ───────────────────────────────────────────────

export interface FreshnessAssessment {
  /** Age of the source's content at capture, seconds. Undefined when unknown. */
  ageSeconds?: number;
  /** True when the capture happened after the claim's deadline. */
  capturedAfterDeadline: boolean;
  /** True when the source published before the deadline it is meant to settle. */
  publishedBeforeDeadline: boolean;
}

export function assessFreshness(source: ContextSource, deadline: number): FreshnessAssessment {
  const deadlineMs = deadline * 1000;
  const ageSeconds =
    source.publishedAt !== undefined
      ? Math.max(0, Math.floor((source.capturedAt - source.publishedAt) / 1000))
      : undefined;
  return {
    ageSeconds,
    capturedAfterDeadline: source.capturedAt > deadlineMs,
    // A source that published before the deadline cannot report the outcome, and
    // this is a common way a market gets settled on stale data.
    publishedBeforeDeadline:
      source.publishedAt !== undefined && source.publishedAt < deadlineMs,
  };
}

export type CorroborationStatus =
  /** No independent source. */
  | "uncorroborated"
  /** At least one independent domain agrees. */
  | "corroborated"
  /** Sources present but all from the primary's own domain. */
  | "same_origin_only"
  /** An explicit conflict was recorded. */
  | "conflicting";

/**
 * Corroboration requires an INDEPENDENT domain. Three pages on one site are one
 * source wearing three hats, and treating them as three is how a single wrong
 * report becomes a settled market.
 */
export function assessCorroboration(pack: MarketContextPack, conflicts = false): CorroborationStatus {
  if (conflicts) return "conflicting";
  const trusted = pack.corroboratingSources.filter((source) => source.trustTier !== "unverified");
  if (trusted.length === 0) return "uncorroborated";
  const independent = trusted.filter((source) => source.domain !== pack.primarySource.domain);
  return independent.length > 0 ? "corroborated" : "same_origin_only";
}

// ── Validation ────────────────────────────────────────────────────────────────

export const MAX_CLAIM_CHARS = 500;
export const MAX_EXCERPT_CHARS = 600;
export const MAX_CORROBORATING_SOURCES = 8;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Non-blocking notes an operator should see in review. */
  warnings: string[];
}

function validateSource(source: ContextSource, label: string, errors: string[]): void {
  if (!/^https?:\/\//.test(source.url)) errors.push(`${label}.url must be http(s)`);
  if (!isHash32Hex(source.contentHash)) {
    errors.push(`${label}.contentHash must be a 32-byte SHA-256 hash`);
  }
  if (!Number.isFinite(source.capturedAt) || source.capturedAt <= 0) {
    errors.push(`${label}.capturedAt is required`);
  }
  if (!source.excerpt.trim()) {
    // Without an excerpt a vanished source leaves nothing to settle against.
    errors.push(`${label}.excerpt is required so the capture survives the source`);
  }
  if (source.excerpt.length > MAX_EXCERPT_CHARS) {
    errors.push(`${label}.excerpt exceeds ${MAX_EXCERPT_CHARS} characters`);
  }
}

export function validateContextPack(pack: MarketContextPack): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (pack.packVersion !== CONTEXT_PACK_VERSION) {
    errors.push(`unknown packVersion ${pack.packVersion}`);
  }
  if (!pack.claim.trim()) errors.push("claim is required");
  if (pack.claim.length > MAX_CLAIM_CHARS) errors.push(`claim exceeds ${MAX_CLAIM_CHARS} characters`);
  if (!pack.creatorPosition.trim() || !pack.counterPosition.trim()) {
    errors.push("both positions are required");
  }
  if (pack.creatorPosition.trim() === pack.counterPosition.trim()) {
    errors.push("the two positions must differ");
  }
  if (!Number.isInteger(pack.deadline) || pack.deadline <= 0) {
    errors.push("deadline must be a unix second");
  }
  if (
    !Number.isInteger(pack.confidenceBps) ||
    pack.confidenceBps < 0 ||
    pack.confidenceBps > 10_000
  ) {
    errors.push("confidenceBps must be an integer in 0..10000");
  }

  // Resolution spec — the fields that stop a dispute later.
  if (!pack.resolution.rule.trim()) errors.push("resolution.rule is required");
  if (!pack.resolution.timezone.trim()) {
    // "Closes above X on date D" is undecidable without one.
    errors.push("resolution.timezone is required — a dated claim is ambiguous without it");
  }
  if (pack.resolution.threshold !== undefined) {
    if (!pack.resolution.units?.trim()) {
      errors.push("a numeric threshold needs resolution.units");
    }
    if (!pack.resolution.rounding?.trim()) {
      errors.push("a numeric threshold needs resolution.rounding");
    }
    if (!pack.resolution.tieBreak) {
      // Exact equality with the threshold is the most common real dispute.
      errors.push("a numeric threshold needs resolution.tieBreak for exact equality");
    }
  }

  validateSource(pack.primarySource, "primarySource", errors);
  if (pack.primarySource.trustTier !== "primary") {
    errors.push("primarySource must have trustTier 'primary'");
  }
  if (pack.corroboratingSources.length > MAX_CORROBORATING_SOURCES) {
    errors.push(`too many corroboratingSources (max ${MAX_CORROBORATING_SOURCES})`);
  }
  pack.corroboratingSources.forEach((source, i) => {
    validateSource(source, `corroboratingSources[${i}]`, errors);
    if (source.trustTier === "primary") {
      errors.push(`corroboratingSources[${i}] must not claim trustTier 'primary'`);
    }
  });

  if (pack.unresolvedQuestions.length === 0) {
    // An agent claiming zero open questions is asserting certainty it does not have.
    warnings.push("no unresolvedQuestions recorded — confirm nothing was overlooked");
  }
  if (assessCorroboration(pack) === "uncorroborated") {
    warnings.push("no independent corroborating source");
  }
  if (assessCorroboration(pack) === "same_origin_only") {
    warnings.push("all corroboration comes from the primary source's own domain");
  }
  const freshness = assessFreshness(pack.primarySource, pack.deadline);
  if (freshness.publishedBeforeDeadline) {
    warnings.push("the primary source published before the deadline it must settle");
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── On-chain commitment ───────────────────────────────────────────────────────

/**
 * Canonical serialisation for hashing. Object key order and array order are both
 * fixed, so two encoders of the same pack produce the same digest — the point of
 * committing a hash at all.
 */
/**
 * ASCII unit/record separators. Named constants rather than inline literals: as
 * raw characters they are invisible in an editor and in grep, which makes the
 * hashing rule impossible to review.
 */
// Built from char codes on purpose: written as escapes the formatter turns them
// into raw control characters, which are invisible in an editor and in grep.
const FIELD_SEPARATOR = String.fromCharCode(0x1f);
const GROUP_SEPARATOR = String.fromCharCode(0x1e);

function canonicalize(pack: MarketContextPack): string {
  const source = (s: ContextSource) => [
    s.url,
    s.domain,
    s.trustTier,
    String(s.capturedAt),
    s.contentHash,
    s.excerpt,
    s.publishedAt === undefined ? "" : String(s.publishedAt),
    s.sourceTimezone ?? "",
  ];

  const parts: string[][] = [
    [String(pack.packVersion), String(pack.revision)],
    [pack.claim, pack.creatorPosition, pack.counterPosition],
    [pack.subjectType, pack.category],
    // Entities are sorted: the same set discovered in a different order is the
    // same context, and must not change the digest.
    [...pack.entities].map((e) => e.trim().toLowerCase()).sort(),
    [String(pack.deadline)],
    [
      pack.resolution.rule,
      pack.resolution.threshold === undefined ? "" : String(pack.resolution.threshold),
      pack.resolution.units ?? "",
      pack.resolution.rounding ?? "",
      pack.resolution.tieBreak ?? "",
      pack.resolution.timezone,
      pack.resolution.geographicScope ?? "",
      pack.resolution.resolutionWindowSeconds === undefined
        ? ""
        : String(pack.resolution.resolutionWindowSeconds),
      pack.resolution.voidRule ?? "",
    ],
    [...pack.resolution.edgeCases].sort(),
    source(pack.primarySource),
    // Corroborating sources are sorted by stable source identity (URL, then
    // domain), capture metadata (capture time, then content hash, then publish
    // time / timezone) and finally the remaining captured fields, so the digest
    // never depends on the order in which asynchronous fetches happened to
    // complete: the comparison is total, so no two distinct sources can tie.
    ...[...pack.corroboratingSources]
      .sort((a, b) => {
        const url = a.url.localeCompare(b.url);
        if (url !== 0) return url;
        const domain = a.domain.localeCompare(b.domain);
        if (domain !== 0) return domain;
        if (a.capturedAt !== b.capturedAt) return a.capturedAt - b.capturedAt;
        const contentHash = a.contentHash.localeCompare(b.contentHash);
        if (contentHash !== 0) return contentHash;
        const publishedA = a.publishedAt ?? 0;
        const publishedB = b.publishedAt ?? 0;
        if (publishedA !== publishedB) return publishedA - publishedB;
        const timezone = (a.sourceTimezone ?? "").localeCompare(b.sourceTimezone ?? "");
        if (timezone !== 0) return timezone;
        const trustTier = a.trustTier.localeCompare(b.trustTier);
        if (trustTier !== 0) return trustTier;
        return a.excerpt.localeCompare(b.excerpt);
      })
      .map(source),
    [String(pack.confidenceBps)],
    [...pack.unresolvedQuestions].sort(),
  ];

  // Real separators, not decorative ones. Joining with "" would make
  // (creatorPosition "ab", counterPosition "c") byte-identical to ("a", "bc"), so
  // two different markets could commit to the same hash — and a commitment two
  // inputs satisfy commits to nothing. U+001F and U+001E cannot occur in a URL or
  // in prose, so no field value can forge a boundary.
  return parts.map((group) => group.join(FIELD_SEPARATOR)).join(GROUP_SEPARATOR);
}

/**
 * The digest committed on chain. Deterministic over the pack's content, so the
 * pack can live off chain and still be provably the one the market used.
 */
export function contextPackHash(pack: MarketContextPack): string {
  return sha256Hex(canonicalize(pack));
}

/**
 * The short rule text worth putting on chain alongside the hash: enough for a
 * reader to see how the market settles without fetching the pack.
 */
export function onChainSettlementRule(pack: MarketContextPack, maxChars = 700): string {
  const bits = [pack.resolution.rule.trim()];
  if (pack.resolution.threshold !== undefined) {
    bits.push(
      `Threshold ${pack.resolution.threshold}${pack.resolution.units ? ` ${pack.resolution.units}` : ""}` +
        `${pack.resolution.rounding ? `, rounded ${pack.resolution.rounding}` : ""}` +
        `${pack.resolution.tieBreak ? `, exact ties to ${pack.resolution.tieBreak}` : ""}.`,
    );
  }
  bits.push(`Times in ${pack.resolution.timezone}.`);
  if (pack.resolution.geographicScope) bits.push(`Scope: ${pack.resolution.geographicScope}.`);
  if (pack.resolution.voidRule) bits.push(`Void if: ${pack.resolution.voidRule}`);
  bits.push(`Source: ${pack.primarySource.domain}.`);
  const text = bits.join(" ");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

// ── Revisions ─────────────────────────────────────────────────────────────────

export interface PackRevision {
  revision: number;
  previousHash: string;
  nextHash: string;
  /** Why the pack changed — required, so a silent edit is impossible. */
  reason: string;
  changedPrimarySource: boolean;
  at: number;
}

/**
 * Record a pack edit as an explicit, auditable revision.
 *
 * Changing the primary resolution source after a market is open changes what the
 * market means, so it is surfaced as its own flag rather than buried in a diff.
 */
export function reviseContextPack(
  previous: MarketContextPack,
  next: MarketContextPack,
  reason: string,
  at = Date.now(),
): { pack: MarketContextPack; revision: PackRevision } {
  const revised: MarketContextPack = { ...next, revision: previous.revision + 1 };
  return {
    pack: revised,
    revision: {
      revision: revised.revision,
      previousHash: contextPackHash(previous),
      nextHash: contextPackHash(revised),
      reason,
      changedPrimarySource: previous.primarySource.url !== next.primarySource.url,
      at,
    },
  };
}
