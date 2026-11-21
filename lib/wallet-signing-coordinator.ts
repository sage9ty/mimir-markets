/**
 * Cross-tab wallet signing coordinator.
 *
 * Prevents overlapping wallet signing prompts across open browser tabs (and within
 * the same tab) for the same Stellar public account while allowing independent
 * accounts to sign concurrently and sequential prompts to proceed once released.
 *
 * Security & privacy invariant:
 *   Persisted storage and cross-tab broadcast payloads ONLY contain non-secret
 *   public operation metadata (`operationId`, normalized public `account`, `tabId`,
 *   `operationKind`, `status`, `acquiredAt`, `heartbeatAt`, `expiresAt`, and
 *   optional recovery metadata `uncertainAt` / `recoveryReason`). Unsigned/signed
 *   XDR, secret seeds, auth tokens, messages, and private notes are NEVER stored.
 *
 * Recovery invariant:
 *   If an owning tab unloads (`pagehide` / `beforeunload`) while an operation is
 *   still active or its lease expires (`now > expiresAt`), the coordinator moves
 *   that operation into a bounded `"uncertain_recovery"` state instead of silently
 *   stealing the lock. Subsequent signing attempts for that account stay blocked
 *   until the user explicitly acknowledges recovery (`acknowledgeUncertainRecovery` /
 *   `dismissSigningRecovery`) or opts into a retry.
 */

export const WALLET_SIGNING_STORAGE_KEY = "mimir:wallet-signing-coordinator:v1";
export const WALLET_SIGNING_CHANNEL_NAME = "mimir:wallet-signing-coordinator";
export const WALLET_SIGNING_DEFAULT_LEASE_TTL_MS = 30_000;
export const WALLET_SIGNING_DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
export const WALLET_SIGNING_DEFAULT_RECOVERY_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const WALLET_SIGNING_DEFAULT_MAX_RECORDS = 16;
export const WALLET_SIGNING_MAX_STORAGE_BYTES = 16_384;

const MAX_ID_LENGTH = 128;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const STELLAR_STRKEY_PATTERN = /^[GCM][A-Za-z2-7]{55,68}$/i;
const STELLAR_SECRET_PATTERN = /^S[A-Z2-7]{55}$/i;

export type WalletSigningOperationKind =
  | "sign_transaction"
  | "sign_auth_entry"
  | "sign_message"
  | "enable_trustline";

export type WalletSigningRecordStatus = "active" | "uncertain_recovery";

export type WalletSigningRecoveryReason = "tab_unloaded" | "lease_expired";

export type WalletSigningBlockReason =
  | "active_in_other_tab"
  | "active_in_same_tab"
  | "uncertain_recovery"
  | "invalid_account"
  | "capacity_exceeded";

export interface WalletSigningOperationRecord {
  readonly operationId: string;
  readonly account: string;
  readonly tabId: string;
  readonly operationKind: WalletSigningOperationKind;
  readonly status: WalletSigningRecordStatus;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
  readonly uncertainAt?: number;
  readonly recoveryReason?: WalletSigningRecoveryReason;
}

export interface WalletSigningAccountState {
  readonly account: string;
  readonly status: "idle" | WalletSigningRecordStatus;
  readonly activeOperation: WalletSigningOperationRecord | null;
  readonly uncertainRecovery: WalletSigningOperationRecord | null;
  readonly isOwnedByCurrentTab: boolean;
  readonly isBlockedByOtherTab: boolean;
}

export interface WalletSigningSnapshot {
  readonly tabId: string;
  readonly records: readonly WalletSigningOperationRecord[];
  readonly activeOperations: readonly WalletSigningOperationRecord[];
  readonly uncertainRecoveries: readonly WalletSigningOperationRecord[];
}

export interface WalletSigningStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WalletSigningChannel {
  postMessage(message: unknown): void;
  addEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  close?: () => void;
}

export interface WalletSigningEventTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface WalletSigningTimers {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface WalletSigningCoordinatorOptions {
  storage?: WalletSigningStorage | null;
  channel?: WalletSigningChannel | null;
  events?: WalletSigningEventTarget | null;
  now?: () => number;
  tabId?: string;
  createOperationId?: () => string;
  storageKey?: string;
  channelName?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  recoveryRetentionMs?: number;
  maxRecords?: number;
  maxStorageBytes?: number;
  autoHeartbeat?: boolean;
  timers?: WalletSigningTimers | false;
}

export interface WalletSigningAcquireOptions {
  account: string;
  operationKind: WalletSigningOperationKind;
  /** Opt-in retry flag: clears a pending `uncertain_recovery` record for this account before acquiring. */
  acknowledgeUncertainRecovery?: boolean;
  /** Optional guard when opting into retry so only the observed uncertain operation is cleared. */
  expectedRecoveryOperationId?: string;
}

export interface WalletSigningAcknowledgeOptions {
  operationId?: string;
}

export interface WalletSigningLease {
  readonly operationId: string;
  readonly account: string;
  readonly tabId: string;
  readonly operationKind: WalletSigningOperationKind;
  readonly record: WalletSigningOperationRecord;
  heartbeat(): WalletSigningOperationRecord | null;
  release(): boolean;
  markUncertain(reason?: WalletSigningRecoveryReason): WalletSigningOperationRecord | null;
}

export type WalletSigningAcquireResult =
  | { readonly acquired: true; readonly lease: WalletSigningLease }
  | {
      readonly acquired: false;
      readonly reason: WalletSigningBlockReason;
      readonly account: string;
      readonly record: WalletSigningOperationRecord | null;
      readonly message: string;
    };

export interface WalletSigningCoordinator {
  readonly tabId: string;
  tryAcquire(options: WalletSigningAcquireOptions): WalletSigningAcquireResult;
  acquire(options: WalletSigningAcquireOptions): WalletSigningLease;
  heartbeat(account: string, operationId: string): WalletSigningOperationRecord | null;
  release(account: string, operationId: string): boolean;
  markUncertain(
    account: string,
    operationId: string,
    reason?: WalletSigningRecoveryReason,
  ): WalletSigningOperationRecord | null;
  acknowledgeUncertainRecovery(
    account: string,
    options?: WalletSigningAcknowledgeOptions,
  ): WalletSigningOperationRecord | null;
  dismissSigningRecovery(
    account: string,
    options?: WalletSigningAcknowledgeOptions,
  ): WalletSigningOperationRecord | null;
  runOperation<T>(
    options: WalletSigningAcquireOptions,
    fn: (lease: WalletSigningLease) => Promise<T>,
  ): Promise<T>;
  reconcile(): WalletSigningSnapshot;
  getAccountState(account: string): WalletSigningAccountState;
  getSnapshot(): WalletSigningSnapshot;
  subscribe(listener: (snapshot: WalletSigningSnapshot) => void): () => void;
  dispose(): void;
}

interface PersistedCoordinatorState {
  version: 1;
  operations: Record<string, WalletSigningOperationRecord>;
}

const VALID_OPERATION_KINDS = new Set<WalletSigningOperationKind>([
  "sign_transaction",
  "sign_auth_entry",
  "sign_message",
  "enable_trustline",
]);

const VALID_RECOVERY_REASONS = new Set<WalletSigningRecoveryReason>([
  "tab_unloaded",
  "lease_expired",
]);

export class WalletSigningCoordinatorError extends Error {
  readonly code: WalletSigningBlockReason;
  readonly account: string;
  readonly record: WalletSigningOperationRecord | null;

  constructor(
    code: WalletSigningBlockReason,
    account: string,
    record: WalletSigningOperationRecord | null,
    message: string,
  ) {
    super(message);
    this.name = "WalletSigningCoordinatorError";
    this.code = code;
    this.account = account;
    this.record = record;
  }
}

export function isWalletSigningCoordinatorError(
  value: unknown,
): value is WalletSigningCoordinatorError {
  return (
    value instanceof WalletSigningCoordinatorError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { name?: unknown }).name === "WalletSigningCoordinatorError" &&
      typeof (value as { code?: unknown }).code === "string")
  );
}

/**
 * Normalize a public Stellar account identifier for coordinator tracking.
 *
 * Canonicalizes Stellar StrKeys (`G…` / `C…` / `M…`) to uppercase base32 so
 * `record.account` always remains a valid Stellar address while matching inputs
 * with extraneous whitespace or inconsistent case. Rejects blank inputs,
 * secret seeds (`S…`), whitespace/control characters, and payload-sized strings.
 */
export function normalizeSigningAccountAddress(address: string): string {
  if (typeof address !== "string") return "";
  const trimmed = address.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return "";
  if (!SAFE_ID_PATTERN.test(trimmed)) return "";
  if (STELLAR_SECRET_PATTERN.test(trimmed)) return "";
  if (STELLAR_STRKEY_PATTERN.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return trimmed;
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value)
  );
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sanitizeRecord(candidate: unknown): WalletSigningOperationRecord | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const raw = candidate as Record<string, unknown>;
  if (!isSafeIdentifier(raw.operationId)) return null;
  if (typeof raw.account !== "string") return null;
  const account = normalizeSigningAccountAddress(raw.account);
  if (!account) return null;
  if (!isSafeIdentifier(raw.tabId)) return null;
  if (
    typeof raw.operationKind !== "string" ||
    !VALID_OPERATION_KINDS.has(raw.operationKind as WalletSigningOperationKind)
  ) {
    return null;
  }
  if (raw.status !== "active" && raw.status !== "uncertain_recovery") {
    return null;
  }
  if (
    !isFiniteNonNegativeNumber(raw.acquiredAt) ||
    !isFiniteNonNegativeNumber(raw.heartbeatAt) ||
    !isFiniteNonNegativeNumber(raw.expiresAt)
  ) {
    return null;
  }

  if (raw.status === "uncertain_recovery") {
    const uncertainAt = isFiniteNonNegativeNumber(raw.uncertainAt)
      ? raw.uncertainAt
      : raw.expiresAt;
    const recoveryReason =
      typeof raw.recoveryReason === "string" &&
      VALID_RECOVERY_REASONS.has(raw.recoveryReason as WalletSigningRecoveryReason)
        ? (raw.recoveryReason as WalletSigningRecoveryReason)
        : "lease_expired";
    return {
      operationId: raw.operationId,
      account,
      tabId: raw.tabId,
      operationKind: raw.operationKind as WalletSigningOperationKind,
      status: "uncertain_recovery",
      acquiredAt: raw.acquiredAt,
      heartbeatAt: raw.heartbeatAt,
      expiresAt: raw.expiresAt,
      uncertainAt,
      recoveryReason,
    };
  }

  return {
    operationId: raw.operationId,
    account,
    tabId: raw.tabId,
    operationKind: raw.operationKind as WalletSigningOperationKind,
    status: "active",
    acquiredAt: raw.acquiredAt,
    heartbeatAt: raw.heartbeatAt,
    expiresAt: raw.expiresAt,
  };
}

function emptyState(): PersistedCoordinatorState {
  return { version: 1, operations: {} };
}

function cloneRecord(record: WalletSigningOperationRecord): WalletSigningOperationRecord {
  return record.status === "uncertain_recovery"
    ? {
        operationId: record.operationId,
        account: record.account,
        tabId: record.tabId,
        operationKind: record.operationKind,
        status: "uncertain_recovery",
        acquiredAt: record.acquiredAt,
        heartbeatAt: record.heartbeatAt,
        expiresAt: record.expiresAt,
        uncertainAt: record.uncertainAt,
        recoveryReason: record.recoveryReason,
      }
    : {
        operationId: record.operationId,
        account: record.account,
        tabId: record.tabId,
        operationKind: record.operationKind,
        status: "active",
        acquiredAt: record.acquiredAt,
        heartbeatAt: record.heartbeatAt,
        expiresAt: record.expiresAt,
      };
}

function parsePersistedState(
  raw: string | null,
  maxStorageBytes: number,
): { state: PersistedCoordinatorState; malformed: boolean } {
  if (!raw) return { state: emptyState(), malformed: false };
  if (raw.length > maxStorageBytes) {
    return { state: emptyState(), malformed: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: emptyState(), malformed: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: emptyState(), malformed: true };
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.version !== 1) {
    return { state: emptyState(), malformed: true };
  }
  if (
    !envelope.operations ||
    typeof envelope.operations !== "object" ||
    Array.isArray(envelope.operations)
  ) {
    return { state: emptyState(), malformed: true };
  }

  const operations: Record<string, WalletSigningOperationRecord> = {};
  let malformed = false;
  for (const [key, value] of Object.entries(
    envelope.operations as Record<string, unknown>,
  )) {
    const clean = sanitizeRecord(value);
    if (!clean || normalizeSigningAccountAddress(key) !== clean.account) {
      malformed = true;
      continue;
    }
    operations[clean.account] = clean;
  }

  return { state: { version: 1, operations }, malformed };
}

function blockMessageFor(
  reason: WalletSigningBlockReason,
  record: WalletSigningOperationRecord | null,
): string {
  switch (reason) {
    case "active_in_other_tab":
      return "A wallet signing prompt is already open for this account in another tab. Finish or close that prompt before starting another.";
    case "active_in_same_tab":
      return "A wallet signing prompt is already active for this account in this tab. Finish it before starting another.";
    case "uncertain_recovery": {
      const opNote = record?.operationKind
        ? ` (${record.operationKind})`
        : "";
      return `A previous wallet signing prompt${opNote} for this account ended unexpectedly and may have completed or aborted. Acknowledge recovery before starting a new prompt.`;
    }
    case "invalid_account":
      return "A valid public Stellar account address is required before coordinating wallet signing.";
    case "capacity_exceeded":
      return "Too many concurrent wallet signing operations are active across accounts. Finish an active prompt before starting another.";
  }
}

function defaultId(prefix: string, nowMs: number): string {
  const randomUuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${randomUuid}`.slice(0, MAX_ID_LENGTH);
}

function resolveBrowserStorage(): WalletSigningStorage | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    if (
      storage &&
      typeof storage.getItem === "function" &&
      typeof storage.setItem === "function" &&
      typeof storage.removeItem === "function"
    ) {
      return storage;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveBrowserChannel(channelName: string): {
  channel: WalletSigningChannel | null;
  owned: boolean;
} {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return { channel: null, owned: false };
  }
  try {
    const bc = new BroadcastChannel(channelName);
    const channel: WalletSigningChannel = {
      postMessage: (message) => bc.postMessage(message),
      addEventListener: (_type, listener) => bc.addEventListener("message", listener),
      removeEventListener: (_type, listener) => bc.removeEventListener("message", listener),
      close: () => bc.close(),
    };
    return { channel, owned: true };
  } catch {
    return { channel: null, owned: false };
  }
}

export function createWalletSigningCoordinator(
  options: WalletSigningCoordinatorOptions = {},
): WalletSigningCoordinator {
  const now = options.now ?? (() => Date.now());
  const storageKey = options.storageKey ?? WALLET_SIGNING_STORAGE_KEY;
  const channelName = options.channelName ?? WALLET_SIGNING_CHANNEL_NAME;
  const leaseTtlMs = Math.max(1, Math.floor(options.leaseTtlMs ?? WALLET_SIGNING_DEFAULT_LEASE_TTL_MS));
  const heartbeatIntervalMs = Math.max(
    0,
    Math.floor(options.heartbeatIntervalMs ?? WALLET_SIGNING_DEFAULT_HEARTBEAT_INTERVAL_MS),
  );
  const recoveryRetentionMs = Math.max(
    0,
    Math.floor(options.recoveryRetentionMs ?? WALLET_SIGNING_DEFAULT_RECOVERY_RETENTION_MS),
  );
  const maxRecords = Math.max(1, Math.floor(options.maxRecords ?? WALLET_SIGNING_DEFAULT_MAX_RECORDS));
  const maxStorageBytes = Math.max(
    512,
    Math.floor(options.maxStorageBytes ?? WALLET_SIGNING_MAX_STORAGE_BYTES),
  );
  const tabId = isSafeIdentifier(options.tabId)
    ? options.tabId
    : defaultId("tab", now());
  const createOperationId =
    options.createOperationId ?? (() => defaultId("op", now()));

  const storage: WalletSigningStorage | null =
    "storage" in options ? (options.storage ?? null) : resolveBrowserStorage();

  const resolvedChannel =
    "channel" in options
      ? { channel: options.channel ?? null, owned: false }
      : resolveBrowserChannel(channelName);
  const channel = resolvedChannel.channel;
  const ownsChannel = resolvedChannel.owned;

  const events: WalletSigningEventTarget | null =
    "events" in options
      ? (options.events ?? null)
      : typeof window !== "undefined"
        ? window
        : null;

  const timers: WalletSigningTimers | null =
    options.timers === false || options.autoHeartbeat === false
      ? null
      : (options.timers ?? {
          setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
          clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
        });

  // In-memory fallback mirror when `storage` is unavailable or throws (e.g. private browsing).
  let fallbackState: PersistedCoordinatorState = emptyState();
  let storageHealthy = storage !== null;

  const activeHeartbeatTimers = new Map<string, unknown>();
  const subscribers = new Set<(snapshot: WalletSigningSnapshot) => void>();
  let lastStructuralFingerprint = "";
  let disposed = false;

  function readStateFromBackend(): {
    state: PersistedCoordinatorState;
    malformed: boolean;
  } {
    if (!storage) {
      return { state: clonePersistedState(fallbackState), malformed: false };
    }
    try {
      const raw = storage.getItem(storageKey);
      storageHealthy = true;
      return parsePersistedState(raw, maxStorageBytes);
    } catch {
      storageHealthy = false;
      return { state: clonePersistedState(fallbackState), malformed: false };
    }
  }

  function clonePersistedState(
    source: PersistedCoordinatorState,
  ): PersistedCoordinatorState {
    const operations: Record<string, WalletSigningOperationRecord> = {};
    for (const [account, rec] of Object.entries(source.operations)) {
      operations[account] = cloneRecord(rec);
    }
    return { version: 1, operations };
  }

  function writeStateToBackend(state: PersistedCoordinatorState): void {
    fallbackState = clonePersistedState(state);
    if (!storage) return;

    const entries = Object.values(state.operations);
    try {
      if (entries.length === 0) {
        storage.removeItem(storageKey);
      } else {
        const cleanOperations: Record<string, WalletSigningOperationRecord> = {};
        for (const rec of entries) {
          cleanOperations[rec.account] = cloneRecord(rec);
        }
        const serialized = JSON.stringify({
          version: 1,
          operations: cleanOperations,
        } satisfies PersistedCoordinatorState);
        storage.setItem(storageKey, serialized);
      }
      storageHealthy = true;
    } catch {
      storageHealthy = false;
    }
  }

  function pruneAndReconcileState(
    state: PersistedCoordinatorState,
    currentTime: number,
  ): { state: PersistedCoordinatorState; changed: boolean } {
    let changed = false;
    const nextOps: Record<string, WalletSigningOperationRecord> = {};

    for (const [account, record] of Object.entries(state.operations)) {
      if (record.status === "active" && currentTime > record.expiresAt) {
        const uncertainAt = record.expiresAt;
        if (currentTime - uncertainAt <= recoveryRetentionMs) {
          nextOps[account] = {
            operationId: record.operationId,
            account: record.account,
            tabId: record.tabId,
            operationKind: record.operationKind,
            status: "uncertain_recovery",
            acquiredAt: record.acquiredAt,
            heartbeatAt: record.heartbeatAt,
            expiresAt: record.expiresAt,
            uncertainAt,
            recoveryReason: "lease_expired",
          };
        }
        changed = true;
        continue;
      }

      if (record.status === "uncertain_recovery") {
        const uncertainAt = record.uncertainAt ?? record.expiresAt;
        if (currentTime - uncertainAt > recoveryRetentionMs) {
          changed = true;
          continue;
        }
      }

      nextOps[account] = cloneRecord(record);
    }

    // Enforce bounded capacity: keep active leases first, then newest uncertain recoveries.
    const allEntries = Object.values(nextOps);
    if (allEntries.length > maxRecords) {
      changed = true;
      const active = allEntries
        .filter((entry) => entry.status === "active")
        .sort((a, b) => b.heartbeatAt - a.heartbeatAt)
        .slice(0, maxRecords);
      const remainingSlots = Math.max(0, maxRecords - active.length);
      const recoveries = allEntries
        .filter((entry) => entry.status === "uncertain_recovery")
        .sort(
          (a, b) =>
            (b.uncertainAt ?? b.expiresAt) - (a.uncertainAt ?? a.expiresAt),
        )
        .slice(0, remainingSlots);

      const boundedOps: Record<string, WalletSigningOperationRecord> = {};
      for (const entry of [...active, ...recoveries]) {
        boundedOps[entry.account] = entry;
      }
      return { state: { version: 1, operations: boundedOps }, changed: true };
    }

    return { state: { version: 1, operations: nextOps }, changed };
  }

  function buildSnapshot(state: PersistedCoordinatorState): WalletSigningSnapshot {
    const records = Object.values(state.operations)
      .map(cloneRecord)
      .sort((a, b) => a.acquiredAt - b.acquiredAt || a.account.localeCompare(b.account));
    return {
      tabId,
      records,
      activeOperations: records.filter((rec) => rec.status === "active"),
      uncertainRecoveries: records.filter((rec) => rec.status === "uncertain_recovery"),
    };
  }

  function structuralFingerprint(snapshot: WalletSigningSnapshot): string {
    return JSON.stringify(
      snapshot.records.map((rec) => ({
        operationId: rec.operationId,
        account: rec.account,
        tabId: rec.tabId,
        operationKind: rec.operationKind,
        status: rec.status,
        recoveryReason: rec.recoveryReason ?? null,
      })),
    );
  }

  function emitChannelChange(
    reason: "acquired" | "released" | "uncertain_recovery" | "acknowledged",
    record: WalletSigningOperationRecord,
  ): void {
    if (!channel) return;
    try {
      channel.postMessage({
        type: "wallet-signing-state-changed",
        tabId,
        reason,
        account: record.account,
        operationId: record.operationId,
        operationKind: record.operationKind,
        status: record.status,
        at: now(),
      });
    } catch {
      // Best-effort cross-tab broadcast; localStorage remains authoritative.
    }
  }

  function notifySubscribers(snapshot: WalletSigningSnapshot, force = false): void {
    const fingerprint = structuralFingerprint(snapshot);
    if (!force && fingerprint === lastStructuralFingerprint) return;
    lastStructuralFingerprint = fingerprint;
    for (const listener of subscribers) {
      try {
        listener(snapshot);
      } catch {
        // Isolate subscriber errors.
      }
    }
  }

  function stopHeartbeat(operationId: string): void {
    const handle = activeHeartbeatTimers.get(operationId);
    if (handle !== undefined && timers) {
      timers.clearInterval(handle);
    }
    activeHeartbeatTimers.delete(operationId);
  }

  function startHeartbeat(account: string, operationId: string): void {
    if (!timers || heartbeatIntervalMs <= 0 || disposed) return;
    stopHeartbeat(operationId);
    const handle = timers.setInterval(() => {
      if (disposed) {
        stopHeartbeat(operationId);
        return;
      }
      const refreshed = heartbeat(account, operationId);
      if (!refreshed) {
        stopHeartbeat(operationId);
      }
    }, heartbeatIntervalMs);

    if (
      handle &&
      typeof handle === "object" &&
      typeof (handle as { unref?: () => void }).unref === "function"
    ) {
      (handle as { unref: () => void }).unref();
    }
    activeHeartbeatTimers.set(operationId, handle);
  }

  function reconcileInternal(notify = true): PersistedCoordinatorState {
    const currentTime = now();
    const { state: parsed, malformed } = readStateFromBackend();
    const { state: next, changed } = pruneAndReconcileState(parsed, currentTime);

    // Stop any local heartbeat timers whose operations are no longer active under this tab.
    for (const opId of activeHeartbeatTimers.keys()) {
      const match = Object.values(next.operations).find(
        (rec) => rec.operationId === opId && rec.tabId === tabId && rec.status === "active",
      );
      if (!match) {
        stopHeartbeat(opId);
      }
    }

    if (changed || malformed) {
      writeStateToBackend(next);
    }
    if (notify) {
      notifySubscribers(buildSnapshot(next));
    }
    return next;
  }

  function markUncertain(
    account: string,
    operationId: string,
    reason: WalletSigningRecoveryReason = "lease_expired",
  ): WalletSigningOperationRecord | null {
    const normalized = normalizeSigningAccountAddress(account);
    if (!normalized || !isSafeIdentifier(operationId)) return null;
    stopHeartbeat(operationId);

    const currentTime = now();
    const { state } = readStateFromBackend();
    const existing = state.operations[normalized];
    if (
      !existing ||
      existing.operationId !== operationId ||
      existing.tabId !== tabId ||
      existing.status !== "active"
    ) {
      return null;
    }

    const uncertain: WalletSigningOperationRecord = {
      operationId: existing.operationId,
      account: existing.account,
      tabId: existing.tabId,
      operationKind: existing.operationKind,
      status: "uncertain_recovery",
      acquiredAt: existing.acquiredAt,
      heartbeatAt: existing.heartbeatAt,
      expiresAt: existing.expiresAt,
      uncertainAt: currentTime,
      recoveryReason: reason,
    };
    state.operations[normalized] = uncertain;
    writeStateToBackend(state);
    emitChannelChange("uncertain_recovery", uncertain);
    notifySubscribers(buildSnapshot(state));
    return cloneRecord(uncertain);
  }

  function heartbeat(
    account: string,
    operationId: string,
  ): WalletSigningOperationRecord | null {
    const normalized = normalizeSigningAccountAddress(account);
    if (!normalized || !isSafeIdentifier(operationId)) return null;

    const currentTime = now();
    const { state } = readStateFromBackend();
    const existing = state.operations[normalized];
    if (
      !existing ||
      existing.operationId !== operationId ||
      existing.tabId !== tabId ||
      existing.status !== "active"
    ) {
      stopHeartbeat(operationId);
      return null;
    }

    if (currentTime > existing.expiresAt) {
      const transitioned: WalletSigningOperationRecord = {
        operationId: existing.operationId,
        account: existing.account,
        tabId: existing.tabId,
        operationKind: existing.operationKind,
        status: "uncertain_recovery",
        acquiredAt: existing.acquiredAt,
        heartbeatAt: existing.heartbeatAt,
        expiresAt: existing.expiresAt,
        uncertainAt: existing.expiresAt,
        recoveryReason: "lease_expired",
      };
      state.operations[normalized] = transitioned;
      stopHeartbeat(operationId);
      writeStateToBackend(state);
      emitChannelChange("uncertain_recovery", transitioned);
      notifySubscribers(buildSnapshot(state));
      return null;
    }

    const updated: WalletSigningOperationRecord = {
      operationId: existing.operationId,
      account: existing.account,
      tabId: existing.tabId,
      operationKind: existing.operationKind,
      status: "active",
      acquiredAt: existing.acquiredAt,
      heartbeatAt: currentTime,
      expiresAt: currentTime + leaseTtlMs,
    };
    state.operations[normalized] = updated;
    writeStateToBackend(state);
    return cloneRecord(updated);
  }

  function release(account: string, operationId: string): boolean {
    const normalized = normalizeSigningAccountAddress(account);
    stopHeartbeat(operationId);
    if (!normalized || !isSafeIdentifier(operationId)) return false;

    const { state } = readStateFromBackend();
    const existing = state.operations[normalized];
    if (
      !existing ||
      existing.operationId !== operationId ||
      existing.tabId !== tabId ||
      existing.status !== "active"
    ) {
      return false;
    }

    delete state.operations[normalized];
    writeStateToBackend(state);
    emitChannelChange("released", existing);
    notifySubscribers(buildSnapshot(state));
    return true;
  }

  function acknowledgeUncertainRecovery(
    account: string,
    ackOptions: WalletSigningAcknowledgeOptions = {},
  ): WalletSigningOperationRecord | null {
    const normalized = normalizeSigningAccountAddress(account);
    if (!normalized) return null;

    const state = reconcileInternal(false);
    const existing = state.operations[normalized];
    if (!existing || existing.status !== "uncertain_recovery") {
      notifySubscribers(buildSnapshot(state));
      return null;
    }
    if (
      ackOptions.operationId &&
      existing.operationId !== ackOptions.operationId
    ) {
      notifySubscribers(buildSnapshot(state));
      return null;
    }

    delete state.operations[normalized];
    writeStateToBackend(state);
    emitChannelChange("acknowledged", existing);
    notifySubscribers(buildSnapshot(state));
    return cloneRecord(existing);
  }

  function tryAcquire(
    acquireOptions: WalletSigningAcquireOptions,
  ): WalletSigningAcquireResult {
    const normalized = normalizeSigningAccountAddress(acquireOptions.account);
    if (!normalized) {
      return {
        acquired: false,
        reason: "invalid_account",
        account: "",
        record: null,
        message: blockMessageFor("invalid_account", null),
      };
    }

    if (!VALID_OPERATION_KINDS.has(acquireOptions.operationKind)) {
      throw new Error(`Unsupported signing operation kind: ${String(acquireOptions.operationKind)}`);
    }

    const state = reconcileInternal(false);
    const existing = state.operations[normalized];

    if (existing) {
      if (existing.status === "active") {
        const reason: WalletSigningBlockReason =
          existing.tabId === tabId ? "active_in_same_tab" : "active_in_other_tab";
        notifySubscribers(buildSnapshot(state));
        return {
          acquired: false,
          reason,
          account: normalized,
          record: cloneRecord(existing),
          message: blockMessageFor(reason, existing),
        };
      }

      if (existing.status === "uncertain_recovery") {
        const expectedId = acquireOptions.expectedRecoveryOperationId;
        const canRetry =
          acquireOptions.acknowledgeUncertainRecovery === true &&
          (!expectedId || expectedId === existing.operationId);
        if (!canRetry) {
          notifySubscribers(buildSnapshot(state));
          return {
            acquired: false,
            reason: "uncertain_recovery",
            account: normalized,
            record: cloneRecord(existing),
            message: blockMessageFor("uncertain_recovery", existing),
          };
        }
        delete state.operations[normalized];
      }
    }

    // Evict oldest uncertain recoveries if adding a new account would exceed maxRecords.
    if (!state.operations[normalized] && Object.keys(state.operations).length >= maxRecords) {
      const oldestRecoveries = Object.values(state.operations)
        .filter((entry) => entry.status === "uncertain_recovery")
        .sort(
          (a, b) =>
            (a.uncertainAt ?? a.expiresAt) - (b.uncertainAt ?? b.expiresAt),
        );
      for (const candidate of oldestRecoveries) {
        if (Object.keys(state.operations).length < maxRecords) break;
        delete state.operations[candidate.account];
      }
      if (Object.keys(state.operations).length >= maxRecords) {
        notifySubscribers(buildSnapshot(state));
        return {
          acquired: false,
          reason: "capacity_exceeded",
          account: normalized,
          record: null,
          message: blockMessageFor("capacity_exceeded", null),
        };
      }
    }

    const currentTime = now();
    const rawOpId = createOperationId();
    const operationId = isSafeIdentifier(rawOpId)
      ? rawOpId
      : defaultId("op", currentTime);

    const record: WalletSigningOperationRecord = {
      operationId,
      account: normalized,
      tabId,
      operationKind: acquireOptions.operationKind,
      status: "active",
      acquiredAt: currentTime,
      heartbeatAt: currentTime,
      expiresAt: currentTime + leaseTtlMs,
    };

    state.operations[normalized] = record;
    writeStateToBackend(state);

    // Post-write read-back check to catch two-tab write races when storage is active.
    if (storage && storageHealthy) {
      const { state: verified } = readStateFromBackend();
      const verifiedRecord = verified.operations[normalized];
      if (
        verifiedRecord &&
        (verifiedRecord.operationId !== record.operationId ||
          verifiedRecord.tabId !== tabId)
      ) {
        const raceReason: WalletSigningBlockReason =
          verifiedRecord.status === "uncertain_recovery"
            ? "uncertain_recovery"
            : verifiedRecord.tabId === tabId
              ? "active_in_same_tab"
              : "active_in_other_tab";
        notifySubscribers(buildSnapshot(verified));
        return {
          acquired: false,
          reason: raceReason,
          account: normalized,
          record: cloneRecord(verifiedRecord),
          message: blockMessageFor(raceReason, verifiedRecord),
        };
      }
    }

    startHeartbeat(normalized, operationId);
    emitChannelChange("acquired", record);
    notifySubscribers(buildSnapshot(state));

    let released = false;
    const lease: WalletSigningLease = {
      operationId,
      account: normalized,
      tabId,
      operationKind: record.operationKind,
      get record() {
        const current = getAccountState(normalized).activeOperation;
        return current && current.operationId === operationId
          ? current
          : cloneRecord(record);
      },
      heartbeat: () => heartbeat(normalized, operationId),
      release: () => {
        if (released) return false;
        released = true;
        return release(normalized, operationId);
      },
      markUncertain: (reason = "tab_unloaded") => {
        if (released) return null;
        released = true;
        return markUncertain(normalized, operationId, reason);
      },
    };

    return { acquired: true, lease };
  }

  function acquire(acquireOptions: WalletSigningAcquireOptions): WalletSigningLease {
    const result = tryAcquire(acquireOptions);
    if (!result.acquired) {
      throw new WalletSigningCoordinatorError(
        result.reason,
        result.account,
        result.record,
        result.message,
      );
    }
    return result.lease;
  }

  async function runOperation<T>(
    acquireOptions: WalletSigningAcquireOptions,
    fn: (lease: WalletSigningLease) => Promise<T>,
  ): Promise<T> {
    const lease = acquire(acquireOptions);
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  }

  function getAccountState(account: string): WalletSigningAccountState {
    const normalized = normalizeSigningAccountAddress(account);
    const state = reconcileInternal(false);
    if (!normalized) {
      return {
        account: "",
        status: "idle",
        activeOperation: null,
        uncertainRecovery: null,
        isOwnedByCurrentTab: false,
        isBlockedByOtherTab: false,
      };
    }
    const existing = state.operations[normalized];
    if (!existing) {
      return {
        account: normalized,
        status: "idle",
        activeOperation: null,
        uncertainRecovery: null,
        isOwnedByCurrentTab: false,
        isBlockedByOtherTab: false,
      };
    }
    if (existing.status === "uncertain_recovery") {
      return {
        account: normalized,
        status: "uncertain_recovery",
        activeOperation: null,
        uncertainRecovery: cloneRecord(existing),
        isOwnedByCurrentTab: false,
        isBlockedByOtherTab: false,
      };
    }
    const isOwnedByCurrentTab = existing.tabId === tabId;
    return {
      account: normalized,
      status: "active",
      activeOperation: cloneRecord(existing),
      uncertainRecovery: null,
      isOwnedByCurrentTab,
      isBlockedByOtherTab: !isOwnedByCurrentTab,
    };
  }

  function getSnapshot(): WalletSigningSnapshot {
    return buildSnapshot(reconcileInternal(false));
  }

  function reconcile(): WalletSigningSnapshot {
    return buildSnapshot(reconcileInternal(true));
  }

  function subscribe(listener: (snapshot: WalletSigningSnapshot) => void): () => void {
    if (subscribers.size === 0) {
      lastStructuralFingerprint = structuralFingerprint(getSnapshot());
    }
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }

  function handleTabUnload(): void {
    if (disposed) return;
    const currentTime = now();
    const { state } = readStateFromBackend();
    const transitionedRecords: WalletSigningOperationRecord[] = [];

    for (const [account, record] of Object.entries(state.operations)) {
      if (record.status === "active" && record.tabId === tabId) {
        stopHeartbeat(record.operationId);
        const uncertain: WalletSigningOperationRecord = {
          operationId: record.operationId,
          account: record.account,
          tabId: record.tabId,
          operationKind: record.operationKind,
          status: "uncertain_recovery",
          acquiredAt: record.acquiredAt,
          heartbeatAt: record.heartbeatAt,
          expiresAt: record.expiresAt,
          uncertainAt: currentTime,
          recoveryReason: "tab_unloaded",
        };
        state.operations[account] = uncertain;
        transitionedRecords.push(uncertain);
      }
    }

    if (transitionedRecords.length === 0) return;

    writeStateToBackend(state);
    for (const rec of transitionedRecords) {
      emitChannelChange("uncertain_recovery", rec);
    }
    notifySubscribers(buildSnapshot(state));
  }

  const onStorageEvent = (event: unknown): void => {
    if (disposed) return;
    if (event && typeof event === "object" && "key" in event) {
      const key = (event as { key?: string | null }).key;
      if (key !== null && key !== undefined && key !== storageKey) {
        return;
      }
    }
    const state = reconcileInternal(false);
    notifySubscribers(buildSnapshot(state));
  };

  const onUnloadEvent = (): void => {
    handleTabUnload();
  };

  const onChannelMessage = (event: { data: unknown }): void => {
    if (disposed) return;
    const payload = event?.data as { type?: unknown; tabId?: unknown } | null;
    if (!payload || payload.type !== "wallet-signing-state-changed") return;
    if (payload.tabId === tabId) return;
    const state = reconcileInternal(false);
    notifySubscribers(buildSnapshot(state));
  };

  if (events) {
    events.addEventListener("storage", onStorageEvent);
    events.addEventListener("pagehide", onUnloadEvent);
    events.addEventListener("beforeunload", onUnloadEvent);
  }

  let attachedOnMessage = false;
  let previousOnMessage: ((event: { data: unknown }) => void) | null = null;
  if (channel) {
    if (typeof channel.addEventListener === "function") {
      channel.addEventListener("message", onChannelMessage);
    } else {
      previousOnMessage = channel.onmessage ?? null;
      attachedOnMessage = true;
      channel.onmessage = (event) => {
        previousOnMessage?.(event);
        onChannelMessage(event);
      };
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const opId of [...activeHeartbeatTimers.keys()]) {
      stopHeartbeat(opId);
    }
    if (events) {
      events.removeEventListener("storage", onStorageEvent);
      events.removeEventListener("pagehide", onUnloadEvent);
      events.removeEventListener("beforeunload", onUnloadEvent);
    }
    if (channel) {
      if (typeof channel.removeEventListener === "function") {
        channel.removeEventListener("message", onChannelMessage);
      } else if (attachedOnMessage) {
        channel.onmessage = previousOnMessage;
      }
      if (ownsChannel && typeof channel.close === "function") {
        try {
          channel.close();
        } catch {
          // ignore
        }
      }
    }
    subscribers.clear();
  }

  return {
    tabId,
    tryAcquire,
    acquire,
    heartbeat,
    release,
    markUncertain,
    acknowledgeUncertainRecovery,
    dismissSigningRecovery: acknowledgeUncertainRecovery,
    runOperation,
    reconcile,
    getAccountState,
    getSnapshot,
    subscribe,
    dispose,
  };
}

let browserCoordinatorSingleton: WalletSigningCoordinator | null = null;
let ssrNoopCoordinator: WalletSigningCoordinator | null = null;

/**
 * Shared browser singleton coordinator for the current tab (or an SSR-safe
 * memory-only coordinator when invoked outside a browser environment).
 */
export function getBrowserWalletSigningCoordinator(): WalletSigningCoordinator {
  if (typeof window === "undefined") {
    if (!ssrNoopCoordinator) {
      ssrNoopCoordinator = createWalletSigningCoordinator({
        storage: null,
        channel: null,
        events: null,
        autoHeartbeat: false,
      });
    }
    return ssrNoopCoordinator;
  }

  if (!browserCoordinatorSingleton) {
    browserCoordinatorSingleton = createWalletSigningCoordinator();
  }
  return browserCoordinatorSingleton;
}

/**
 * Associate a coordinated `signTransaction` wrapper with its uncoordinated
 * implementation so multi-step flows (such as `ensureUsdcTrustline`) that hold
 * a dedicated operation lease (`enable_trustline`) can invoke the underlying
 * signer without self-deadlocking on a nested `sign_transaction` lease.
 */
const uncoordinatedSignTransactions = new WeakMap<
  (...args: never[]) => unknown,
  (...args: never[]) => unknown
>();

export function registerUncoordinatedSignTransaction<
  T extends (...args: never[]) => unknown,
>(coordinatedFn: T, uncoordinatedFn: T): void {
  uncoordinatedSignTransactions.set(coordinatedFn, uncoordinatedFn);
}

export function resolveUncoordinatedSignTransaction<
  T extends (...args: never[]) => unknown,
>(fn: T): T {
  return (uncoordinatedSignTransactions.get(fn) as T | undefined) ?? fn;
}
