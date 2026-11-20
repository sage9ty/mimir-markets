/**
 * Dedupe helpers for market-creator candidates.
 *
 * Two candidates are considered duplicates when they share the same
 * (question, resolutionUrl, deadline, normalization policy version) signature.
 * The signature is normalised so that case, punctuation and whitespace
 * differences don't produce duplicates on-chain.
 *
 * The normalization policy version is included in the signature so that when
 * the normalization rules change, previously-seen keys are not silently reused
 * across policy generations. Bumping NORMALIZATION_POLICY_VERSION invalidates
 * all cached dedupe decisions computed under older policies.
 */

/**
 * Version of the normalization policy used to build candidate signatures.
 * Increment whenever normaliseQuestion / normaliseUrl / normaliseDeadline
 * change behaviour in a way that could alter signatures.
 */
export const NORMALIZATION_POLICY_VERSION = "v1";

export interface CandidateLike {
  question?: string;
  resolutionUrl?: string;
  deadline?: string;
  // Optional canonical fields that may be present on candidates.
  id?: string;
  title?: string;
  [key: string]: unknown;
}

function normaliseQuestion(question: string | undefined): string {
  if (!question) return "";
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseUrl(url: string | undefined): string {
  if (!url) return "";
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function normaliseDeadline(deadline: string | undefined): string {
  if (!deadline) return "";
  const ms = Date.parse(deadline);
  if (!Number.isFinite(ms)) return deadline.trim().toLowerCase();
  return new Date(ms).toISOString();
}

/**
 * Build a stable signature for a candidate. Used to detect duplicates
 * across the same run and against already-created markets.
 *
 * The signature is prefixed with the normalization policy version so that
 * keys produced under different policies never compare equal.
 */
export function buildCandidateSignature(
  candidate: CandidateLike,
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): string {
  const question = normaliseQuestion(candidate.question ?? candidate.title);
  const url = normaliseUrl(candidate.resolutionUrl);
  const deadline = normaliseDeadline(candidate.deadline);
  return `${policyVersion}|${question}|${url}|${deadline}`;
}

/**
 * Filter duplicate candidates while preserving input order.
 *
 * The first occurrence of a signature wins; subsequent ones are dropped.
 * An optional `seen` set can be passed in to also dedupe against candidates
 * that already exist on-chain or in a previous batch. Keys recorded under a
 * different normalization policy version will not match and are therefore
 * treated as incompatible rather than reused.
 */
export function filterDuplicateCandidates<T extends CandidateLike>(
  candidates: readonly T[],
  seen: Set<string> = new Set(),
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): T[] {
  const out: T[] = [];
  for (const candidate of candidates) {
    const sig = buildCandidateSignature(candidate, policyVersion);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(candidate);
  }
  return out;
}

/**
 * Drop cached dedupe keys that were produced under a different normalization
 * policy version. Keys are expected to carry their version as the prefix
 * before the first '|'. Returns the number of keys removed.
 */
export function invalidateIncompatibleKeys(
  seen: Set<string>,
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): number {
  let removed = 0;
  for (const key of [...seen]) {
    const sep = key.indexOf("|");
    const keyVersion = sep < 0 ? "" : key.slice(0, sep);
    if (keyVersion !== policyVersion) {
      seen.delete(key);
      removed++;
    }
  }
  return removed;
}
