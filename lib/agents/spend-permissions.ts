/**
 * Owner-signed spend permissions — the money bound on an API key.
 *
 * The key says who is calling; this says how much they may move and until when. The
 * owner signs it once in their own wallet, so Mimir never holds a key that can reach
 * their funds, and revoking is theirs to do at any time.
 *
 * Two independent ceilings apply to every funded action and both must pass:
 *
 *   permission  what the owner authorised on chain — an allowance with an expiry.
 *               Authoritative.
 *   agent limit what the platform caps regardless of what the owner signed
 *               (per position, per day, open exposure). A generous permission
 *               cannot raise these.
 *
 * ── The Stellar mechanism, and where it differs from Base's ──────────────────
 *
 * The on-chain leg is the USDC Stellar Asset Contract's own token-interface
 * `approve(from, spender, amount, expiration_ledger)` — the SAC exposes the
 * SEP-41 allowance pair, so a standing, capped, expiring delegation is a native
 * primitive here and does not need a bespoke permission contract.
 *
 * One genuine difference, and it is why the period accounting below is OURS and
 * not the chain's: a SAC allowance is a SINGLE DECREASING BUCKET with an
 * expiration ledger. It does not refresh. Base Account spend permissions refresh
 * every `periodSeconds`, and that rolling-window shape is what the product
 * promises an owner ("up to 20 USDC a day"), so it is kept — enforced in Mimir's
 * ledger, with the chain enforcing the absolute ceiling and the expiry underneath.
 * The two together are strictly tighter than either alone: exceeding the period
 * budget is refused here without a chain round trip, and exceeding the approved
 * total is refused by the SAC even if this ledger were wrong.
 *
 * Note also that Mimir's own staking path does NOT use an allowance at all —
 * `challenge_claim` carries per-invocation auth for exactly the staked amount (see
 * `lib/contract.ts`). Allowances exist here only for the delegated case: an agent
 * that cannot sign for itself and spends from an owner's account.
 */

import { sha256Hex } from "@/lib/content-hash";
import { getUsdcSacId, isAccountAddress, isContractAddress } from "@/lib/stellar";

export interface SpendPermissionRecord {
  /** Local canonical key, not an on-chain identifier. */
  permissionHash: string;
  agentId: string;
  /** The `G…` account the allowance is drawn from. */
  account: string;
  /** Who may draw it — Mimir's configured spender (`G…` or `C…`). */
  spender: string;
  /** Must be the USDC SAC contract id. */
  token: string;
  allowanceAtomic: bigint;
  periodSeconds: number;
  /** Unix seconds. */
  startAt: number;
  endAt: number;
  /**
   * Ledger sequence the on-chain `approve` expires at, when the owner has already
   * submitted it. Optional because the record is accepted before the approve
   * lands — the spend path re-reads `allowance()` anyway.
   */
  expirationLedger?: number;
  salt: string;
  /**
   * Opaque bytes the owner included in what they signed.
   *
   * Carried through verbatim and never interpreted. Kept because it is part of the
   * signed payload — dropping it would change what a re-verification hashes — and
   * because `lib/db.ts` persists it.
   */
  extraData: string;
  /** Base64 Ed25519 signature (SEP-43) over the grant. */
  signature: string;
  /** Verbatim permission object as signed, so a re-check hashes the same bytes. */
  permissionJson: string;
  createdAt: number;
  revokedAt?: number;
  revokedReason?: string;
}

export type PermissionRejection =
  | "wrong_token"
  | "wrong_spender"
  | "not_started"
  | "expired"
  | "revoked"
  | "zero_allowance"
  | "bad_period"
  | "allowance_exhausted";

/**
 * Mimir's spender address. Unset means funded actions cannot be delegated at all.
 *
 * Accepts a `G…` account or a `C…` contract: the spender in a SAC allowance is an
 * `Address`, which either satisfies, and a contract spender is the shape a future
 * routing contract would take.
 */
export function configuredSpender(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = (env.SPEND_PERMISSION_SPENDER ?? env.AGENT_SPENDER_ADDRESS ?? "")
    .split(/\s+#/)[0]
    .trim();
  if (!raw) return null;
  return isAccountAddress(raw) || isContractAddress(raw) ? raw : null;
}

/**
 * The token every permission must be denominated in. Null when USDC is
 * unconfigured.
 *
 * Reads the env on every call rather than capturing `USDC_SAC_ID` at import time.
 * That module-level const is fixed the moment `lib/usdc.ts` is first imported, so
 * capturing it here would freeze this module's notion of "the USDC contract" to
 * whatever the environment happened to be at import — which breaks any process
 * that configures itself after its first import, and made this module untestable
 * without a dynamic import.
 */
function requiredToken(): string | null {
  const sacId = getUsdcSacId();
  return isContractAddress(sacId) ? sacId : null;
}

/**
 * Stable identity for a permission, so re-submitting the same grant updates the row
 * instead of creating a second budget for the same money.
 *
 * No case folding on any address: strkeys are case-sensitive base32, and folding
 * them would let two different-but-equal-looking grants collide on one key.
 */
export function permissionKey(input: {
  account: string; spender: string; token: string; allowanceAtomic: bigint;
  periodSeconds: number; startAt: number; endAt: number; salt: string;
}): string {
  return sha256Hex([
    input.account.trim(), input.spender.trim(), input.token.trim(),
    input.allowanceAtomic.toString(), String(input.periodSeconds),
    String(input.startAt), String(input.endAt), input.salt,
  ].join("|"));
}

/**
 * Start of the period a moment falls in. Before `start` there is no period yet, so
 * the caller must treat that as not-yet-active rather than as period zero.
 */
export function currentPeriodStart(
  permission: Pick<SpendPermissionRecord, "startAt" | "periodSeconds">,
  nowSeconds: number,
): number {
  if (nowSeconds < permission.startAt) return permission.startAt;
  const elapsed = nowSeconds - permission.startAt;
  return permission.startAt + Math.floor(elapsed / permission.periodSeconds) * permission.periodSeconds;
}

/** Static validity of the grant itself, independent of how much has been spent. */
export function checkPermission(
  permission: SpendPermissionRecord,
  nowSeconds: number,
  spender: string | null,
): { ok: true } | { ok: false; reason: PermissionRejection } {
  if (permission.revokedAt) return { ok: false, reason: "revoked" };
  const token = requiredToken();
  // An unconfigured USDC contract id must not degrade into "any token passes":
  // the comparison would be against the empty string and match nothing real, but
  // being explicit keeps a misconfigured deployment from looking like a bad grant.
  if (!token || permission.token.trim() !== token) return { ok: false, reason: "wrong_token" };
  if (!spender || permission.spender.trim() !== spender.trim()) {
    return { ok: false, reason: "wrong_spender" };
  }
  if (permission.allowanceAtomic <= 0n) return { ok: false, reason: "zero_allowance" };
  if (!Number.isInteger(permission.periodSeconds) || permission.periodSeconds <= 0) {
    return { ok: false, reason: "bad_period" };
  }
  if (nowSeconds < permission.startAt) return { ok: false, reason: "not_started" };
  if (nowSeconds >= permission.endAt) return { ok: false, reason: "expired" };
  return { ok: true };
}

export interface SpendDecision {
  allowed: boolean;
  reason?: PermissionRejection;
  /** Left in the current period after this spend would land. */
  remainingAtomic: bigint;
  periodStart: number;
  periodEndsAt: number;
}

/**
 * Would this amount fit? Answers with the remaining allowance either way, because
 * "no" without a number is an agent that cannot decide whether to wait or to stop.
 */
/**
 * ── In-flight intents (#885) ─────────────────────────────────────────────
 * `spentThisPeriodAtomic` must include the atomic stake of every copy
 * execution intent still in `pending` or `unknown` state
 * (`reservedSpendAtomic(intents)` in `lib/copy-trading`). The chain allowance
 * is authoritative and will move once the submit lands, but the local period
 * budget must reserve the stake the moment the intent is persisted —
 * otherwise the same budget can authorise two submissions whose outcome is
 * unknown, and only one of them can be real.
 *
 * The reservation is dropped when the intent reconciles to `confirmed`; the
 * intent must NOT be added again on top of the confirmed spend, or the budget
 * would count the same stake twice.
 */
export function evaluateSpend(args: {
  permission: SpendPermissionRecord;
  spentThisPeriodAtomic: bigint;
  amountAtomic: bigint;
  nowSeconds: number;
  spender: string | null;
}): SpendDecision {
  const { permission, spentThisPeriodAtomic, amountAtomic, nowSeconds, spender } = args;
  const periodStart = currentPeriodStart(permission, nowSeconds);
  const periodEndsAt = Math.min(periodStart + permission.periodSeconds, permission.endAt);
  const remainingBefore = permission.allowanceAtomic > spentThisPeriodAtomic
    ? permission.allowanceAtomic - spentThisPeriodAtomic
    : 0n;

  const valid = checkPermission(permission, nowSeconds, spender);
  if (!valid.ok) {
    return { allowed: false, reason: valid.reason, remainingAtomic: remainingBefore, periodStart, periodEndsAt };
  }
  if (amountAtomic <= 0n || amountAtomic > remainingBefore) {
    return { allowed: false, reason: "allowance_exhausted", remainingAtomic: remainingBefore, periodStart, periodEndsAt };
  }
  return { allowed: true, remainingAtomic: remainingBefore - amountAtomic, periodStart, periodEndsAt };
}

/** Shape accepted from the browser after the owner signs, before we trust any of it. */
export interface SpendPermissionGrant {
  account?: unknown;
  spender?: unknown;
  token?: unknown;
  allowance?: unknown;
  period?: unknown;
  start?: unknown;
  end?: unknown;
  expirationLedger?: unknown;
  salt?: unknown;
  extraData?: unknown;
  signature?: unknown;
  permission?: unknown;
}

function asStellarAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isAccountAddress(trimmed) || isContractAddress(trimmed) ? trimmed : null;
}

/** Accounts only — an allowance is drawn from a `G…` balance, not a contract. */
function asAccount(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isAccountAddress(trimmed) ? trimmed : null;
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

function asSeconds(value: unknown): number | null {
  const n = asBigInt(value);
  if (n === null) return null;
  const num = Number(n);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
}

/**
 * Parse and validate a grant into a record.
 *
 * Rejects on any field it cannot read rather than defaulting: a silently defaulted
 * expiry or allowance is a budget nobody agreed to.
 */
export function parseSpendPermissionGrant(args: {
  agentId: string;
  grant: SpendPermissionGrant;
  spender: string | null;
  now: number;
}): { ok: true; record: SpendPermissionRecord } | { ok: false; error: string } {
  const { agentId, grant, spender, now } = args;
  const account = asAccount(grant.account);
  if (!account) return { ok: false, error: "account must be a Stellar account (G…)" };
  const grantSpender = asStellarAddress(grant.spender);
  if (!grantSpender) return { ok: false, error: "spender must be a Stellar address" };
  if (!spender) return { ok: false, error: "server has no configured spend permission spender" };
  if (grantSpender !== spender) return { ok: false, error: "spender does not match this deployment" };

  const requiredUsdc = requiredToken();
  if (!requiredUsdc) return { ok: false, error: "server has no configured USDC contract id" };
  const token = asStellarAddress(grant.token) ?? requiredUsdc;
  if (token !== requiredUsdc) return { ok: false, error: "only USDC permissions are accepted" };

  const allowanceAtomic = asBigInt(grant.allowance);
  if (allowanceAtomic === null || allowanceAtomic <= 0n) return { ok: false, error: "allowance must be a positive atomic amount" };
  const periodSeconds = asSeconds(grant.period);
  if (!periodSeconds) return { ok: false, error: "period must be positive seconds" };
  const startAt = asSeconds(grant.start);
  const endAt = asSeconds(grant.end);
  if (startAt === null || endAt === null) return { ok: false, error: "start and end must be unix seconds" };
  if (endAt <= startAt) return { ok: false, error: "end must follow start" };
  if (endAt * 1000 <= now) return { ok: false, error: "permission has already expired" };

  // Base64 as SEP-43 returns it. The bytes are verified against `account` by
  // `verifyAgentSignature`; this only rejects an obviously non-signature.
  const signature = typeof grant.signature === "string" && /^[A-Za-z0-9+/]{16,}={0,2}$/.test(grant.signature.trim())
    ? grant.signature.trim() : null;
  if (!signature) return { ok: false, error: "owner signature is required" };

  const salt = asBigInt(grant.salt)?.toString() ?? "0";
  const extraData = typeof grant.extraData === "string" ? grant.extraData : "";
  const expirationLedger = asSeconds(grant.expirationLedger) ?? undefined;

  return {
    ok: true,
    record: {
      permissionHash: permissionKey({ account, spender: grantSpender, token, allowanceAtomic, periodSeconds, startAt, endAt, salt }),
      agentId, account, spender: grantSpender, token, allowanceAtomic, periodSeconds,
      startAt, endAt, salt, extraData, signature,
      ...(expirationLedger !== undefined ? { expirationLedger } : {}),
      // Stored verbatim: a re-verification has to hash the object the owner
      // actually signed, not one we rebuilt from parsed parts.
      permissionJson: JSON.stringify(grant.permission ?? grant),
      createdAt: now,
    },
  };
}
