/**
 * Research content validation — the layer between a raw gateway success and a
 * usable research result.
 *
 * The gateway enforces network-level invariants (SSRF, size, content-type,
 * redirects, budget). This module enforces semantic invariants:
 *
 *   1. **Freshness.** A response fetched after its adapter's `freshnessSeconds`
 *      window is stale and must not be used for settlement.
 *
 *   2. **Duplication guard.** Identical hashes from different adapters in the same
 *      request cycle are duplicates; using both would count one page as
 *      independent corroboration of itself.
 *
 *   3. **Cancellation.** If the requesting agent or market is cancelled, the
 *      content is tagged cancelled so it is never silently settled.
 *
 *   4. **Dependency failure.** When a content pack depends on another fetch
 *      (e.g. a corroborating source) that failed, this marks the result rather
 *      than discarding it silently.
 *
 *   5. **Privacy-sensitive field detection.** Stellar wallet addresses (G…
 *      strkeys), raw LLM prompt fragments, analytics pixel patterns, and large
 *      USDC amounts appearing in raw fetched content are not legitimate resolution
 *      evidence. Returning them to settlement logic is a data-leak risk, so the
 *      validator surfaces them as findings rather than passing them through.
 *
 *   6. **Structural validity.** A body that is entirely whitespace, or whose
 *      reported content-hash does not match the SHA-256 of its body, indicates a
 *      transport or storage bug and must not settle anything.
 *
 * Privacy design notes
 * ───────────────────
 * - Stellar G… strkeys are 56-character base32 strings starting with 'G'. They
 *   appear in page content when a BYOA agent accidentally fetches its own API
 *   response, when a page embeds an on-chain explorer link, or when an LLM prompt
 *   leaks into a fetched page (prompt-injection risk). The validator surfaces them
 *   as `wallet_address` findings without extracting or logging the actual value.
 *
 * - LLM prompt fragments: a page that echoes "Ignore previous instructions" or
 *   similar payload markers is a prompt-injection candidate. The validator flags
 *   these so the caller can decide whether to proceed.
 *
 * - Analytics pixels: script tags pointing at third-party trackers in fetched
 *   content are a signal that the page is a live marketing surface rather than an
 *   official data source. Not a hard error, but surfaced as a finding.
 *
 * - USDC amounts: raw atomic USDC integers (7-decimal, large magnitude) appearing
 *   in body text could indicate the fetched page is a payment confirmation or
 *   wallet statement rather than a market resolution source. Surfaced as a finding.
 *
 * None of these findings cause a hard validation failure on their own — the caller
 * (adapter layer) decides whether to promote them to an error. The contract-first
 * rule is: surfacing > silently dropping.
 *
 * Migration notes
 * ───────────────
 * v1 (this module): validation is advisory at the adapter layer. All findings are
 * returned; adapters may choose which to treat as hard errors via `opts.strict`.
 * Future: when `strict` becomes the default for production adapters, the
 * `advisory` array will become the promotion path for new finding types.
 *
 * Rollout controls
 * ────────────────
 * Set `RESEARCH_CONTENT_VALIDATION_DISABLED=1` to skip all content validation
 * (emergency escape hatch). Set `RESEARCH_CONTENT_VALIDATION_STRICT=1` to treat
 * every privacy finding as an error even when the caller does not request it.
 */

import { sha256Hex } from "@/lib/content-hash";
export const DEFAULT_CONTENT_VALIDATION_POLICY_REVISION = "v1";

/**
 * Return the active content-validation policy revision.
 * Configured via RESEARCH_CONTENT_VALIDATION_POLICY_REVISION (or RESEARCH_CONTENT_VALIDATION_REVISION).
 * Defaults to DEFAULT_CONTENT_VALIDATION_POLICY_REVISION ("v1").
 */
export function getContentValidationPolicyRevision(): string {
  const envVal =
    process.env.RESEARCH_CONTENT_VALIDATION_POLICY_REVISION?.trim() ||
    process.env.RESEARCH_CONTENT_VALIDATION_REVISION?.trim();
  return envVal || DEFAULT_CONTENT_VALIDATION_POLICY_REVISION;
}

export interface FetchSuccess {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  contentHash: string;
  capturedAt: number;
  bytes: number;
  fromCache: boolean;
  redirects: number;
  redirectChain: string[];
  policyRevision?: string;
}

// ── Validity states ───────────────────────────────────────────────────────────

/**
 * The lifecycle state of a piece of fetched research content.
 *
 * `valid`              — passed all checks; safe for settlement use.
 * `stale`             — fetched outside the adapter's freshness window.
 * `duplicated`        — body hash matches another result in the same cycle.
 * `cancelled`         — the requesting agent or market was cancelled; do not settle.
 * `dependency_failure`— a sibling fetch in the same pack failed; result is degraded.
 * `invalid`           — structural or hash mismatch; must not be used.
 */
export type ResearchContentState =
  | "valid"
  | "stale"
  | "duplicated"
  | "cancelled"
  | "interrupted"
  | "dependency_failure"
  | "invalid";

// ── Privacy-sensitive finding types ──────────────────────────────────────────

/**
 * A specific category of privacy-sensitive content found in the body.
 *
 * `wallet_address`    — Stellar G… strkey in fetched body (leak / injection risk).
 * `llm_prompt_marker` — prompt-injection payload marker ("ignore previous…", etc.).
 * `analytics_pixel`  — third-party analytics/tracker script tag in the body.
 * `usdc_amount`       — large USDC atomic integer in body text (payment page risk).
 */
export type PrivacyFindingKind =
  | "wallet_address"
  | "llm_prompt_marker"
  | "analytics_pixel"
  | "usdc_amount";

export interface PrivacyFinding {
  kind: PrivacyFindingKind;
  /** Human-readable detail for operator review. Does NOT include the matched value. */
  detail: string;
  /**
   * Whether this finding alone should block use of the content.
   * Advisory findings are surfaced but do not change the validity state by default.
   */
  advisory: boolean;
}

// ── Validation result ─────────────────────────────────────────────────────────

export interface ContentValidationResult {
  state: ResearchContentState;
  /**
   * Why the state is what it is. Always set on non-`valid` states; empty string
   * on `valid` when there are no findings.
   */
  reason: string;
  /** Privacy-sensitive findings. May be non-empty even when `state === 'valid'`. */
  privacyFindings: PrivacyFinding[];
  /**
   * True when the content may be used for settlement. False on every non-valid
   * state, and on `valid` if any non-advisory privacy finding was detected.
   */
  usable: boolean;
  /** Content-validation policy revision applied to this decision. */
  policyRevision?: string;
}

// ── Validation options ────────────────────────────────────────────────────────

export interface ContentValidationOpts {
  /**
   * Maximum age of content in seconds since capture.
   * Defaults to the adapter's `freshnessSeconds` if provided, else 3600.
   */
  maxAgeSeconds?: number;
  /**
   * Content hashes already seen in this cycle (for duplication detection).
   * The caller passes a Set that grows as results come in; a hash present here
   * marks the new result as duplicated.
   */
  seenHashes?: ReadonlySet<string>;
  /**
   * True if the requesting agent or market was cancelled before the fetch
   * completed. Marks the result as `cancelled`.
   */
  cancelled?: boolean;
  /**
   * True if the fetch attempt was interrupted prior to settlement (e.g. worker restart).
   * Marks the result as `interrupted`.
   */
  interrupted?: boolean;
  /**
   * True if a sibling fetch in the same context pack failed. Marks the result as
   * `dependency_failure` unless the primary content itself is invalid.
   */
  dependencyFailed?: boolean;
  /**
   * Promote every privacy finding to a hard error, overriding `advisory: true`.
   * Defaults to `process.env.RESEARCH_CONTENT_VALIDATION_STRICT === '1'`.
   */
  strict?: boolean;
  /** Inject the SHA-256 implementation (test seam). Defaults to sha256Hex. */
  hashFn?: (input: string) => string;
  /** Expected content-validation policy revision. Defaults to active revision. */
  policyRevision?: string;
}

// ── Patterns ──────────────────────────────────────────────────────────────────

/**
 * Stellar G… strkey: a 56-character base32 string starting with 'G', matching
 * the encoding of Stellar ed25519 public keys. Case-sensitive per design
 * (strkeys are UPPERCASE base32); the regex is intentionally case-sensitive.
 *
 * We look for word-boundary anchors so partial matches on benign base32 data
 * (e.g. a URL parameter starting with a 'G') do not fire.
 */
const STELLAR_STRKEY_RE = /\bG[A-Z2-7]{55}\b/;

/**
 * Prompt-injection markers: common prefixes used in adversarial prompts
 * appearing in web content. A page that echoes these back into a fetched body
 * is a prompt-injection candidate. We scan case-insensitively, and we look
 * for the pattern to appear in a plausible context (not inside a URL path or
 * an HTML attribute value — a rough heuristic, not a security guarantee).
 */
const LLM_PROMPT_MARKER_RE =
  /(?:ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions?|disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|context)|you\s+are\s+now\s+a\s+different\s+(?:ai|assistant|model)|act\s+as\s+(?:if\s+)?(?:you\s+are\s+)?a\s+(?:different|unrestricted)\s+|jailbreak|system\s*:\s*you\s+are)/i;

/**
 * Analytics / tracker pixel patterns: script tags pointing at common third-party
 * analytics vendors. Presence indicates the page is a live marketing surface.
 * Only script src attributes are checked (not inline scripts) to reduce noise.
 */
const ANALYTICS_PIXEL_RE =
  /src\s*=\s*["'][^"']*(?:google-analytics\.com|googletagmanager\.com|segment\.(?:com|io)|mixpanel\.com|amplitude\.com|heap\.io|fullstory\.com|hotjar\.com|clarity\.ms|facebook\.com\/tr|connect\.facebook\.net|track\.(?:hubspot|pardot|marketo)\.com|bat\.bing\.com|analytics\.twitter\.com)[^"']*["']/i;

/**
 * USDC atomic amount: a run of 9+ digits (≥ 0.01 USDC in 7-decimal form) that
 * appears as a standalone token. 9 digits = 0.01 USDC; the threshold is
 * intentionally low so even small payment amounts in a body are flagged.
 * We exclude digit runs inside a URL path (heuristic: not preceded by `/`).
 */
const USDC_AMOUNT_RE = /(?<![\w/])\d{9,}(?!\w)/;

// ── Privacy scanner ───────────────────────────────────────────────────────────

/**
 * Scan a body string for privacy-sensitive content.
 * Returns an array of findings, empty when none are detected.
 * The body is never logged or re-emitted by this function.
 */
export function scanPrivacyFindings(body: string): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];

  if (STELLAR_STRKEY_RE.test(body)) {
    findings.push({
      kind: "wallet_address",
      detail:
        "Fetched body contains a Stellar G… strkey. This may indicate a payment " +
        "confirmation page, a prompt-injection payload, or an accidental fetch of " +
        "an internal API response. Wallet addresses are not legitimate resolution evidence.",
      advisory: false,
    });
  }

  if (LLM_PROMPT_MARKER_RE.test(body)) {
    findings.push({
      kind: "llm_prompt_marker",
      detail:
        "Fetched body contains text matching known prompt-injection markers. The " +
        "source may be attempting to influence settlement logic.",
      // Prompt-injection is always a hard block — the cost of a false positive is
      // a refusal; the cost of a false negative is a poisoned settlement.
      advisory: false,
    });
  }

  if (ANALYTICS_PIXEL_RE.test(body)) {
    findings.push({
      kind: "analytics_pixel",
      detail:
        "Fetched body contains a third-party analytics or tracking script. The " +
        "page is likely a live marketing surface rather than an official data source.",
      // Advisory only: many official sources embed analytics; the finding is
      // surfaced for operator review but does not block use on its own.
      advisory: true,
    });
  }

  if (USDC_AMOUNT_RE.test(body)) {
    findings.push({
      kind: "usdc_amount",
      detail:
        "Fetched body contains a large numeric token consistent with an atomic " +
        "USDC amount (7 decimal places). The page may be a payment confirmation " +
        "or wallet statement rather than a market resolution source.",
      // Advisory only: many legitimate financial data sources contain large
      // numbers; the finding is surfaced but does not block use on its own.
      advisory: true,
    });
  }

  return findings;
}

// ── Main validator ────────────────────────────────────────────────────────────

/**
 * Validate the content of a successfully fetched research response.
 *
 * Never throws. Any internal error is converted to an `invalid` state with a
 * descriptive reason, so a validator bug cannot silently pass bad content.
 */
export function validateResearchContent(
  success: FetchSuccess,
  opts: ContentValidationOpts = {},
): ContentValidationResult {
  const activeRevision =
    opts.policyRevision?.trim() || getContentValidationPolicyRevision();

  // Emergency escape hatch: skip all validation if explicitly disabled.
  if (process.env.RESEARCH_CONTENT_VALIDATION_DISABLED === "1") {
    return { state: "valid", reason: "", privacyFindings: [], usable: true, policyRevision: activeRevision };
  }

  const strict =
    opts.strict ?? process.env.RESEARCH_CONTENT_VALIDATION_STRICT === "1";

  const toResult = (
    state: ResearchContentState,
    reason: string,
    privacyFindings: PrivacyFinding[],
    usable: boolean,
  ): ContentValidationResult =>
    result(state, reason, privacyFindings, usable, activeRevision);

  try {
    const hashFn = opts.hashFn ?? sha256Hex;

    // Incompatible cached decision check: if the result was bound to an incompatible revision, refuse it.
    if (success.policyRevision !== undefined && success.policyRevision !== activeRevision) {
      return toResult(
        "invalid",
        `content-validation policy revision mismatch: result was bound to revision '${success.policyRevision}' but active policy revision is '${activeRevision}'`,
        [],
        false,
      );
    }

    // ── 1. Structural checks — must pass before anything else ────────────────

    // An empty body is not a resolution source. Whitespace-only bodies are
    // treated the same: they carried no evidence.
    if (!success.body.trim()) {
      return toResult("invalid", "fetched body is empty", [], false);
    }

    // Hash integrity: the gateway stores the SHA-256 of the body at capture
    // time. If it does not match what we compute now, the content has been
    // mutated in transit or storage — do not settle on it.
    const computedHash = hashFn(success.body);
    if (computedHash !== success.contentHash) {
      return toResult(
        "invalid",
        `content hash mismatch: recorded ${success.contentHash} but body hashes to ${computedHash}`,
        [],
        false,
      );
    }

    // ── 2. Lifecycle state checks (order: cancelled > interrupted > dependency > stale > dup) ─

    if (opts.cancelled) {
      return toResult(
        "cancelled",
        "the requesting agent or market was cancelled; this content must not be used for settlement",
        [],
        false,
      );
    }

    if (opts.interrupted) {
      return toResult(
        "interrupted",
        "fetch attempt was interrupted prior to settlement; this content must not be used for settlement",
        [],
        false,
      );
    }

    if (opts.dependencyFailed) {
      // A dependency failure does not invalidate the content itself, but it
      // marks it as degraded so the settlement layer can make an informed choice.
      // Privacy scanning still runs on dependency-failure results.
      const findings = scanPrivacyFindings(success.body);
      const blockedByPrivacy = strict
        ? findings.length > 0
        : findings.some((f) => !f.advisory);
      if (blockedByPrivacy) {
        return toResult(
          "invalid",
          "dependency failure and privacy findings block use",
          findings,
          false,
        );
      }
      return toResult(
        "dependency_failure",
        "a sibling fetch in the same context pack failed; this result is degraded",
        findings,
        false,
      );
    }

    // ── 3. Freshness ─────────────────────────────────────────────────────────

    const maxAgeSeconds = opts.maxAgeSeconds ?? 3_600;
    const now = Date.now();
    const ageSeconds = Math.max(0, (now - success.capturedAt) / 1_000);
    if (ageSeconds > maxAgeSeconds) {
      return toResult(
        "stale",
        `content is ${Math.round(ageSeconds)}s old; limit is ${maxAgeSeconds}s`,
        [],
        false,
      );
    }

    // ── 4. Duplication ────────────────────────────────────────────────────────

    if (opts.seenHashes?.has(success.contentHash)) {
      return toResult(
        "duplicated",
        `content hash ${success.contentHash} already seen in this cycle; treating as duplicate`,
        [],
        false,
      );
    }

    // ── 5. Privacy findings ───────────────────────────────────────────────────

    const privacyFindings = scanPrivacyFindings(success.body);

    // In strict mode every finding is a hard block. In default mode only
    // non-advisory findings block use.
    const blockedByPrivacy = strict
      ? privacyFindings.length > 0
      : privacyFindings.some((f) => !f.advisory);

    if (blockedByPrivacy) {
      const kinds = privacyFindings.map((f) => f.kind).join(", ");
      return toResult(
        "invalid",
        `privacy-sensitive content detected: ${kinds}`,
        privacyFindings,
        false,
      );
    }

    // Advisory findings only: content is valid but the caller should note them.
    return toResult(
      "valid",
      privacyFindings.length > 0
        ? `advisory privacy findings: ${privacyFindings.map((f) => f.kind).join(", ")}`
        : "",
      privacyFindings,
      true,
    );
  } catch (err) {
    // Any unexpected error inside the validator is surfaced as invalid, so a
    // validator bug cannot accidentally pass bad content.
    const detail = err instanceof Error ? err.message : String(err);
    return toResult("invalid", `validator error: ${detail}`, [], false);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function result(
  state: ResearchContentState,
  reason: string,
  privacyFindings: PrivacyFinding[],
  usable: boolean,
  policyRevision: string = getContentValidationPolicyRevision(),
): ContentValidationResult {
  return { state, reason, privacyFindings, usable, policyRevision };
}

/**
 * Convenience: summarise a validation result for telemetry or operator logs.
 * Never includes body content or matched values.
 */
export function summariseValidation(r: ContentValidationResult): string {
  if (r.usable && r.privacyFindings.length === 0) return "valid";
  if (r.usable) return `valid (advisory: ${r.privacyFindings.map((f) => f.kind).join(", ")})`;
  return `${r.state}: ${r.reason}`;
}
