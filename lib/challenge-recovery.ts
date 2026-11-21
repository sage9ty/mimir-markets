/**
 * Recovery state for challenge submissions with an uncertain outcome.
 *
 * A user-signed `challenge_claim` can leave the client without a verdict:
 * the wallet reports the transaction as sent but the result never unwraps, or
 * the RPC budget expires while the transaction is still in flight. Stellar is
 * final on inclusion, so "unknown" is temporary — but until the hash is
 * observed on-chain (or the record expires) the UI must NOT offer a second
 * stake action, because the first one may have landed.
 *
 * Design rules (mirrors lib/settlement-retry.ts on the worker side):
 *  - The transaction hash is the identity shown to the user; it is never
 *    re-submitted. Recovery means *checking*, bounded by a status-check budget.
 *  - Fail closed: an unknown outcome blocks new stakes until it resolves or the
 *    record expires. Exhausting the check budget does NOT unblock.
 *  - Pure transitions + a localStorage store, framework-free so the whole
 *    policy is unit-testable with plain `node:test` (no DOM, no React).
 */

import { StellarTransactionError } from "./settlement-retry";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChallengeRecoveryStatus = "unknown" | "succeeded" | "failed";

export interface ChallengeRecoveryRecord {
  /** Market the challenge was submitted against. */
  vsId: number;
  /** Submitted transaction hash — the identity displayed in the panel. */
  txHash: string;
  /** Wallet that signed the submission (lower-cased for matching). */
  address: string;
  /** Stake submitted, in USDC display units (integer contract units on chain). */
  stakeAmount: number;
  /** Epoch ms when the submission was recorded. */
  submittedAtMs: number;
  /** Last known outcome. `unknown` blocks a second stake action. */
  status: ChallengeRecoveryStatus;
  /** Status checks consumed from the bounded budget. */
  statusChecks: number;
}

/** What one bounded status check observed about the transaction. */
export interface ChallengeStatusOutcome {
  succeeded: boolean;
  failed: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Status-check budget per record. Each check is a single RPC read of the tx;
 * at the 5 s ledger cadence this covers ~25 s of automatic observation before
 * the panel hands the user the explorer link.
 */
export const CHALLENGE_RECOVERY_MAX_STATUS_CHECKS = 5;

/** One Stellar ledger close between automatic status checks. */
export const CHALLENGE_RECOVERY_CHECK_INTERVAL_MS = 5_000;

/**
 * Records older than this stop blocking. A Soroban transaction that never
 * landed is long expired by then, and a permanent block on a stale hash would
 * be worse than the small double-submit risk of a re-read guard chain.
 */
export const CHALLENGE_RECOVERY_MAX_AGE_MS = 30 * 60 * 1000;

const STORAGE_KEY = "proven_challenge_recovery";

// ── Pure transitions ──────────────────────────────────────────────────────────

export function createChallengeRecoveryRecord(input: {
  vsId: number;
  txHash: string;
  address: string;
  stakeAmount: number;
  now?: number;
}): ChallengeRecoveryRecord {
  return {
    vsId: input.vsId,
    txHash: input.txHash,
    address: input.address.trim().toLowerCase(),
    stakeAmount: input.stakeAmount,
    submittedAtMs: input.now ?? Date.now(),
    status: "unknown",
    statusChecks: 0,
  };
}

/**
 * Apply one status-check observation. The check counter always advances so the
 * budget is consumed even by inconclusive reads; a definitive on-chain status
 * ends the unknown phase.
 */
export function applyChallengeStatusOutcome(
  record: ChallengeRecoveryRecord,
  outcome: ChallengeStatusOutcome,
): ChallengeRecoveryRecord {
  const status: ChallengeRecoveryStatus = outcome.succeeded
    ? "succeeded"
    : outcome.failed
      ? "failed"
      : record.status === "unknown"
        ? "unknown"
        : record.status;
  return {
    ...record,
    status,
    statusChecks: record.statusChecks + 1,
  };
}

/** True while automatic status checks remain in the bounded budget. */
export function hasChallengeStatusBudget(
  record: ChallengeRecoveryRecord,
): boolean {
  return record.statusChecks < CHALLENGE_RECOVERY_MAX_STATUS_CHECKS;
}

export function isChallengeRecoveryExpired(
  record: ChallengeRecoveryRecord,
  now = Date.now(),
): boolean {
  return now - record.submittedAtMs >= CHALLENGE_RECOVERY_MAX_AGE_MS;
}

/**
 * The gate for "no second stake while the first outcome is unknown".
 *
 * Fail closed: an unexpired `unknown` record blocks even when the status-check
 * budget is exhausted — the outcome is still unobserved, and the panel's
 * explorer link remains the recovery path.
 */
export function isChallengeRecoveryBlocking(
  record: ChallengeRecoveryRecord | null,
  now = Date.now(),
): boolean {
  if (!record) return false;
  if (record.status !== "unknown") return false;
  return !isChallengeRecoveryExpired(record, now);
}

/**
 * Extract the submitted transaction hash from an error thrown by the contract
 * boundary. `sendCall` attaches the hash to `StellarTransactionError` precisely
 * so an uncertain outcome can be reconciled instead of blindly resubmitted.
 * Returns null when no hash was observed (nothing to recover against).
 */
export function challengeRecoveryTxHashFromError(err: unknown): string | null {
  if (err instanceof StellarTransactionError && isTxHash(err.txHash)) {
    return err.txHash;
  }
  if (err && typeof err === "object") {
    const candidate = (err as Record<string, unknown>).txHash;
    if (isTxHash(candidate)) return candidate;
  }
  return null;
}

function isTxHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

// ── Persistence ───────────────────────────────────────────────────────────────
//
// Same best-effort localStorage pattern as lib/pending-vs.ts: SSR-safe,
// corrupt-entry-safe, quota-safe. One record per (vsId, wallet).

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isRecordShape(value: unknown): value is ChallengeRecoveryRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.vsId === "number" &&
    isTxHash(r.txHash) &&
    typeof r.address === "string" &&
    typeof r.stakeAmount === "number" &&
    typeof r.submittedAtMs === "number" &&
    (r.status === "unknown" || r.status === "succeeded" || r.status === "failed") &&
    typeof r.statusChecks === "number"
  );
}

function readAll(): ChallengeRecoveryRecord[] {
  if (!hasLocalStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    const now = Date.now();
    return items.filter(
      (item): item is ChallengeRecoveryRecord =>
        isRecordShape(item) && !isChallengeRecoveryExpired(item, now),
    );
  } catch {
    return [];
  }
}

function writeAll(items: ChallengeRecoveryRecord[]): void {
  if (!hasLocalStorage()) return;
  try {
    if (items.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage may be unavailable or full; recovery is best-effort.
  }
}

/** Persist a recovery record, replacing any prior record for the same market+wallet. */
export function saveChallengeRecoveryRecord(record: ChallengeRecoveryRecord): void {
  const items = readAll().filter(
    (r) => !(r.vsId === record.vsId && r.address === record.address),
  );
  items.unshift(record);
  writeAll(items);
}

/**
 * Read the live recovery record for a market+wallet, or null. Expired and
 * malformed records are dropped on read; a resolved record is still returned so
 * the panel can show the confirmed outcome before dismissal.
 */
export function readChallengeRecoveryRecord(
  vsId: number,
  address: string | null | undefined,
): ChallengeRecoveryRecord | null {
  if (!address) return null;
  const normalized = address.trim().toLowerCase();
  if (!normalized) return null;
  return readAll().find((r) => r.vsId === vsId && r.address === normalized) ?? null;
}

/** Remove the recovery record for a market+wallet (e.g. after dismissal). */
export function clearChallengeRecoveryRecord(
  vsId: number,
  address: string | null | undefined,
): void {
  if (!address) return;
  const normalized = address.trim().toLowerCase();
  writeAll(readAll().filter((r) => !(r.vsId === vsId && r.address === normalized)));
}
