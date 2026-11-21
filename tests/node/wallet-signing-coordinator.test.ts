import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Account } from "@stellar/stellar-sdk";
import type { SignTransaction } from "@stellar/stellar-sdk/contract";

import {
  WALLET_SIGNING_STORAGE_KEY,
  createWalletSigningCoordinator,
  isWalletSigningCoordinatorError,
  normalizeSigningAccountAddress,
  registerUncoordinatedSignTransaction,
  resolveUncoordinatedSignTransaction,
  type WalletSigningChannel,
  type WalletSigningCoordinator,
  type WalletSigningCoordinatorOptions,
  type WalletSigningEventTarget,
  type WalletSigningSnapshot,
  type WalletSigningStorage,
  type WalletSigningTimers,
} from "../../lib/wallet-signing-coordinator";
import { ensureUsdcTrustline, type TrustlineHorizonClient } from "../../lib/stellar-trustline";
import {
  WALLET_SIGNING_OPERATION_MESSAGE_KEYS,
  type WalletContextValue,
} from "../../lib/wallet";

// Valid Stellar StrKey test fixtures (public G... keys, distinct from any S... seed).
const ACCOUNT_A = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const ACCOUNT_B = "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D";
const ACCOUNT_C = "GB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E";
const INITIAL_NOW = 1_700_000_000_000;

interface SharedTestHarness {
  storage: WalletSigningStorage;
  rawMap: Map<string, string>;
  now: () => number;
  setNow: (ms: number) => void;
  advanceBy: (deltaMs: number) => void;
  createTab: (
    tabId: string,
    overrides?: Partial<WalletSigningCoordinatorOptions>,
  ) => {
    coordinator: WalletSigningCoordinator;
    emitEvent: (type: string, event?: unknown) => void;
    snapshots: WalletSigningSnapshot[];
  };
  postedMessages: Array<{ senderTabId: string; data: unknown }>;
  disposeAll: () => void;
}

function createFakeTimers(getNow: () => number) {
  let nextId = 1;
  const scheduled = new Map<
    number,
    { id: number; callback: () => void; intervalMs: number; nextAt: number }
  >();

  const timers: WalletSigningTimers = {
    setInterval(callback, delayMs) {
      const id = nextId++;
      const intervalMs = Math.max(1, delayMs);
      scheduled.set(id, {
        id,
        callback,
        intervalMs,
        nextAt: getNow() + intervalMs,
      });
      return id;
    },
    clearInterval(handle) {
      if (typeof handle === "number") {
        scheduled.delete(handle);
      }
    },
  };

  function runDue(targetMs: number, setNow: (ms: number) => void) {
    while (true) {
      let earliest:
        | { id: number; callback: () => void; intervalMs: number; nextAt: number }
        | undefined;
      for (const entry of scheduled.values()) {
        if (entry.nextAt <= targetMs && (!earliest || entry.nextAt < earliest.nextAt)) {
          earliest = entry;
        }
      }
      if (!earliest) break;
      setNow(earliest.nextAt);
      earliest.nextAt += earliest.intervalMs;
      earliest.callback();
    }
    setNow(targetMs);
  }

  return { timers, scheduled, runDue };
}

function createSharedHarness(initialNow = INITIAL_NOW): SharedTestHarness {
  let currentNow = initialNow;
  let opCounter = 0;
  const rawMap = new Map<string, string>();
  const postedMessages: Array<{ senderTabId: string; data: unknown }> = [];
  const channelListeners = new Set<(event: { data: unknown }) => void>();
  const eventTargets: Array<{
    listeners: Map<string, Set<(event: unknown) => void>>;
  }> = [];
  const coordinators: WalletSigningCoordinator[] = [];
  const fakeTimers = createFakeTimers(() => currentNow);

  const storage: WalletSigningStorage = {
    getItem(key) {
      return rawMap.has(key) ? (rawMap.get(key) ?? null) : null;
    },
    setItem(key, value) {
      rawMap.set(key, String(value));
    },
    removeItem(key) {
      rawMap.delete(key);
    },
  };

  function createTab(
    tabId: string,
    overrides: Partial<WalletSigningCoordinatorOptions> = {},
  ) {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    eventTargets.push({ listeners });

    const events: WalletSigningEventTarget = {
      addEventListener(type, listener) {
        let bucket = listeners.get(type);
        if (!bucket) {
          bucket = new Set();
          listeners.set(type, bucket);
        }
        bucket.add(listener);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
    };

    const channel: WalletSigningChannel = {
      postMessage(data) {
        postedMessages.push({ senderTabId: tabId, data });
        for (const listener of channelListeners) {
          listener({ data });
        }
      },
      addEventListener(_type, listener) {
        channelListeners.add(listener);
      },
      removeEventListener(_type, listener) {
        channelListeners.delete(listener);
      },
    };

    const coordinator = createWalletSigningCoordinator({
      storage,
      channel,
      events,
      timers: fakeTimers.timers,
      now: () => currentNow,
      tabId,
      createOperationId: () => `op-${++opCounter}`,
      ...overrides,
    });
    coordinators.push(coordinator);

    const snapshots: WalletSigningSnapshot[] = [];
    coordinator.subscribe((snap) => snapshots.push(snap));

    function emitEvent(type: string, event?: unknown) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener(event);
      }
    }

    return { coordinator, emitEvent, snapshots };
  }

  return {
    storage,
    rawMap,
    now: () => currentNow,
    setNow(ms) {
      currentNow = ms;
    },
    advanceBy(deltaMs) {
      if (deltaMs < 0) throw new Error("deltaMs must be non-negative");
      fakeTimers.runDue(currentNow + deltaMs, (ms) => {
        currentNow = ms;
      });
    },
    createTab,
    postedMessages,
    disposeAll() {
      for (const c of coordinators) c.dispose();
    },
  };
}

test("single-tab acquire/release lifecycle and sequential operations", async () => {
  const harness = createSharedHarness();
  try {
    const { coordinator } = harness.createTab("tab-a");

    const lease = coordinator.acquire({
      account: `  ${ACCOUNT_A}  `,
      operationKind: "sign_transaction",
    });

    assert.equal(lease.account, ACCOUNT_A);
    assert.equal(lease.tabId, "tab-a");
    assert.equal(lease.operationKind, "sign_transaction");
    assert.equal(lease.record.status, "active");
    assert.equal(lease.record.acquiredAt, INITIAL_NOW);
    assert.equal(lease.record.heartbeatAt, INITIAL_NOW);
    assert.equal(lease.record.expiresAt, INITIAL_NOW + 30_000);

    const stateWhileActive = coordinator.getAccountState(ACCOUNT_A);
    assert.equal(stateWhileActive.status, "active");
    assert.equal(stateWhileActive.isOwnedByCurrentTab, true);
    assert.equal(stateWhileActive.isBlockedByOtherTab, false);

    // Same-tab overlapping prompt on the same account is also blocked.
    assert.throws(
      () =>
        coordinator.acquire({
          account: ACCOUNT_A,
          operationKind: "sign_message",
        }),
      (err) =>
        isWalletSigningCoordinatorError(err) && err.code === "active_in_same_tab",
    );

    assert.equal(lease.release(), true);
    // Second release is an idempotent no-op.
    assert.equal(lease.release(), false);
    assert.equal(coordinator.getAccountState(ACCOUNT_A).status, "idle");
    assert.equal(harness.rawMap.get(WALLET_SIGNING_STORAGE_KEY), undefined);

    // Sequential signing request proceeds cleanly after release, even when fn throws.
    await assert.rejects(
      () =>
        coordinator.runOperation(
          { account: ACCOUNT_A, operationKind: "sign_message" },
          async () => {
            throw new Error("wallet unavailable");
          },
        ),
      /wallet unavailable/,
    );
    assert.equal(coordinator.getAccountState(ACCOUNT_A).status, "idle");

    // Next sequential operation works immediately.
    const nextValue = await coordinator.runOperation(
      { account: ACCOUNT_A, operationKind: "enable_trustline" },
      async (opLease) => opLease.operationKind,
    );
    assert.equal(nextValue, "enable_trustline");
    assert.equal(coordinator.getAccountState(ACCOUNT_A).status, "idle");
  } finally {
    harness.disposeAll();
  }
});

test("cross-tab lock blocks overlapping prompts on same account while permitting independent accounts concurrently", () => {
  const harness = createSharedHarness();
  try {
    const tabA = harness.createTab("tab-a");
    const tabB = harness.createTab("tab-b");

    const leaseA = tabA.coordinator.acquire({
      account: ACCOUNT_A,
      operationKind: "sign_transaction",
    });

    // Tab B received reactive BroadcastChannel notification.
    assert.equal(tabB.snapshots.length, 1);
    const stateB = tabB.coordinator.getAccountState(ACCOUNT_A);
    assert.equal(stateB.status, "active");
    assert.equal(stateB.isOwnedByCurrentTab, false);
    assert.equal(stateB.isBlockedByOtherTab, true);

    // Same account in Tab B is blocked (even with lowercase input variation).
    const blocked = tabB.coordinator.tryAcquire({
      account: ACCOUNT_A.toLowerCase(),
      operationKind: "sign_message",
    });
    assert.equal(blocked.acquired, false);
    if (!blocked.acquired) {
      assert.equal(blocked.reason, "active_in_other_tab");
      assert.equal(blocked.account, ACCOUNT_A);
      assert.equal(blocked.record?.tabId, "tab-a");
      assert.equal(blocked.record?.operationId, leaseA.operationId);
      // Error wording must not mimic wallet rejection/unsupported patterns.
      assert.equal(/reject|denied|cancel|declined|unsupported/i.test(blocked.message), false);
    }

    // Independent account B in Tab B can sign concurrently without conflict.
    const leaseB = tabB.coordinator.acquire({
      account: ACCOUNT_B,
      operationKind: "enable_trustline",
    });
    assert.equal(leaseB.account, ACCOUNT_B);
    assert.equal(tabA.coordinator.getSnapshot().activeOperations.length, 2);

    // After Tab A releases account A, Tab B can acquire account A sequentially.
    leaseA.release();
    const leaseBOnA = tabB.coordinator.acquire({
      account: ACCOUNT_A,
      operationKind: "sign_message",
    });
    assert.equal(leaseBOnA.tabId, "tab-b");
    assert.equal(leaseBOnA.operationKind, "sign_message");

    leaseB.release();
    leaseBOnA.release();
    assert.equal(harness.rawMap.size, 0);
  } finally {
    harness.disposeAll();
  }
});

test("nonsecret assertion: storage and broadcast payloads never persist XDR, secrets, tokens, or notes", () => {
  const harness = createSharedHarness();
  try {
    const tabA = harness.createTab("tab-a");
    const sensitiveXdr = "AAAAAgAAAABtestUnsignedTxXdrPayloadXYZ123==";
    const sensitiveSignedXdr = "AAAAAgAAAABtestSignedTxXdrPayloadXYZ999==";
    const sensitiveSecret = "secret_seed_value_must_never_appear";
    const sensitiveToken = "bearer_auth_token_must_never_appear";
    const sensitiveNote = "private_user_memo_must_never_appear";
    const sensitiveMessage = "Mimir raw signMessage body must not persist";

    // Even if a buggy caller passes extra secret fields via type assertion,
    // the coordinator strictly whitelists public non-secret fields only.
    const lease = tabA.coordinator.acquire({
      account: ACCOUNT_A,
      operationKind: "sign_transaction",
      xdr: sensitiveXdr,
      signedTxXdr: sensitiveSignedXdr,
      secret: sensitiveSecret,
      authToken: sensitiveToken,
      privateNote: sensitiveNote,
      message: sensitiveMessage,
    } as never);

    const serializedStorage = harness.rawMap.get(WALLET_SIGNING_STORAGE_KEY);
    assert.ok(serializedStorage, "storage should contain non-secret lease entry");

    const serializedBroadcasts = JSON.stringify(harness.postedMessages);
    for (const forbidden of [
      sensitiveXdr,
      sensitiveSignedXdr,
      sensitiveSecret,
      sensitiveToken,
      sensitiveNote,
      sensitiveMessage,
      "signedTxXdr",
      "authToken",
      "privateNote",
    ]) {
      assert.equal(
        serializedStorage.includes(forbidden),
        false,
        `serialized storage must never contain ${forbidden}`,
      );
      assert.equal(
        serializedBroadcasts.includes(forbidden),
        false,
        `broadcast channel must never contain ${forbidden}`,
      );
    }

    const parsed = JSON.parse(serializedStorage) as {
      version: number;
      operations: Record<string, Record<string, unknown>>;
    };
    assert.equal(parsed.version, 1);
    assert.deepEqual(Object.keys(parsed.operations[ACCOUNT_A] ?? {}).sort(), [
      "account",
      "acquiredAt",
      "expiresAt",
      "heartbeatAt",
      "operationId",
      "operationKind",
      "status",
      "tabId",
    ]);

    // Attempting to pass a Stellar secret seed shape or XDR-like string as account fails closed.
    const dynamicSeed = "S" + "A".repeat(55);
    assert.equal(normalizeSigningAccountAddress(dynamicSeed), "");
    assert.equal(normalizeSigningAccountAddress(sensitiveXdr), "");
    assert.throws(
      () =>
        tabA.coordinator.acquire({
          account: dynamicSeed,
          operationKind: "sign_transaction",
        }),
      (err) => isWalletSigningCoordinatorError(err) && err.code === "invalid_account",
    );

    lease.release();
  } finally {
    harness.disposeAll();
  }
});

test("tab disappearance (pagehide / beforeunload) transitions active lease into uncertain_recovery requiring explicit acknowledgment", () => {
  const harness = createSharedHarness();
  try {
    const tabA = harness.createTab("tab-a");
    const tabB = harness.createTab("tab-b");

    const leaseA = tabA.coordinator.acquire({
      account: ACCOUNT_A,
      operationKind: "sign_transaction",
    });

    // Simulate Tab A closing while wallet prompt is open (pagehide fires, then beforeunload).
    harness.advanceBy(2_000);
    tabA.emitEvent("pagehide");
    // Second unload event is idempotent and preserves the original uncertainAt.
    harness.advanceBy(500);
    tabA.emitEvent("beforeunload");

    // Tab B observes uncertain_recovery without silently stealing the lock.
    const stateInB = tabB.coordinator.getAccountState(ACCOUNT_A);
    assert.equal(stateInB.status, "uncertain_recovery");
    assert.equal(stateInB.activeOperation, null);
    assert.equal(stateInB.uncertainRecovery?.operationId, leaseA.operationId);
    assert.equal(stateInB.uncertainRecovery?.tabId, "tab-a");
    assert.equal(stateInB.uncertainRecovery?.operationKind, "sign_transaction");
    assert.equal(stateInB.uncertainRecovery?.recoveryReason, "tab_unloaded");
    assert.equal(stateInB.uncertainRecovery?.uncertainAt, INITIAL_NOW + 2_000);

    // Late release from Tab A cannot erase uncertain_recovery.
    assert.equal(leaseA.release(), false);
    assert.equal(tabB.coordinator.getAccountState(ACCOUNT_A).status, "uncertain_recovery");

    // Tab B cannot start a new signing prompt until user acknowledges recovery.
    assert.throws(
      () =>
        tabB.coordinator.acquire({
          account: ACCOUNT_A,
          operationKind: "sign_transaction",
        }),
      (err) =>
        isWalletSigningCoordinatorError(err) &&
        err.code === "uncertain_recovery" &&
        err.record?.operationId === leaseA.operationId,
    );

    // Mismatched operationId does not clear a newer/unseen recovery.
    assert.equal(
      tabB.coordinator.dismissSigningRecovery(ACCOUNT_A, { operationId: "wrong-op" }),
      null,
    );
    assert.equal(tabB.coordinator.getAccountState(ACCOUNT_A).status, "uncertain_recovery");

    // Explicit acknowledgment clears recovery so the next prompt can proceed.
    const cleared = tabB.coordinator.acknowledgeUncertainRecovery(ACCOUNT_A, {
      operationId: leaseA.operationId,
    });
    assert.equal(cleared?.operationId, leaseA.operationId);
    assert.equal(tabB.coordinator.getAccountState(ACCOUNT_A).status, "idle");

    const leaseB = tabB.coordinator.acquire({
      account: ACCOUNT_A,
      operationKind: "sign_transaction",
    });
    assert.equal(leaseB.tabId, "tab-b");
    leaseB.release();
  } finally {
    harness.disposeAll();
  }
});

test("heartbeat keeps active lease alive past initial TTL, while TTL expiry transitions to uncertain_recovery with opt-in retry", () => {
  const harness = createSharedHarness();
  try {
    const tabA = harness.createTab("tab-a");
    const tabB = harness.createTab("tab-b");

    const leaseA = tabA.coordinator.acquire({
      account: ACCOUNT_A,
      operationKind: "enable_trustline",
    });

    // Advance 40s with automatic heartbeats running (every 5s): lease stays active!
    harness.advanceBy(40_000);
    const activeState = tabB.coordinator.getAccountState(ACCOUNT_A);
    assert.equal(activeState.status, "active");
    assert.equal(activeState.activeOperation?.heartbeatAt, INITIAL_NOW + 40_000);
    assert.equal(activeState.activeOperation?.expiresAt, INITIAL_NOW + 70_000);

    // Tab B is still blocked while Tab A's heartbeat keeps the lease fresh.
    assert.throws(
      () =>
        tabB.coordinator.acquire({
          account: ACCOUNT_A,
          operationKind: "sign_transaction",
        }),
      (err) =>
        isWalletSigningCoordinatorError(err) && err.code === "active_in_other_tab",
    );

    // Now simulate Tab A freezing (dispose stops heartbeats without unloading).
    tabA.coordinator.dispose();
    // Manually check exact boundary: at now === expiresAt (70_000), still active;
    // at now > expiresAt (70_001), transitions to uncertain_recovery.
    harness.setNow(INITIAL_NOW + 70_000);
    assert.equal(tabB.coordinator.getAccountState(ACCOUNT_A).status, "active");

    harness.setNow(INITIAL_NOW + 70_001);
    const expiredState = tabB.coordinator.getAccountState(ACCOUNT_A);
    assert.equal(expiredState.status, "uncertain_recovery");
    assert.equal(expiredState.uncertainRecovery?.recoveryReason, "lease_expired");
    assert.equal(expiredState.uncertainRecovery?.uncertainAt, INITIAL_NOW + 70_000);

    // Default acquire without opt-in still blocks.
    assert.throws(
      () =>
        tabB.coordinator.acquire({
          account: ACCOUNT_A,
          operationKind: "sign_transaction",
        }),
      (err) =>
        isWalletSigningCoordinatorError(err) && err.code === "uncertain_recovery",
    );

    // Opt-in retry with expectedRecoveryOperationId atomically replaces the recovery.
    const retryLease = tabB.coordinator.acquire({
      account: ACCOUNT_A,
      operationKind: "sign_transaction",
      acknowledgeUncertainRecovery: true,
      expectedRecoveryOperationId: leaseA.operationId,
    });
    assert.equal(retryLease.tabId, "tab-b");
    assert.equal(retryLease.record.status, "active");
    retryLease.release();
  } finally {
    harness.disposeAll();
  }
});

test("bounded recovery retention and maxRecords eviction protect storage capacity", () => {
  const harness = createSharedHarness();
  try {
    const tabA = harness.createTab("tab-a", {
      maxRecords: 2,
      recoveryRetentionMs: 60_000,
      autoHeartbeat: false,
    });
    const tabB = harness.createTab("tab-b", {
      maxRecords: 2,
      recoveryRetentionMs: 60_000,
      autoHeartbeat: false,
    });

    // Account A and Account B enter uncertain_recovery at different times.
    tabA.coordinator.acquire({ account: ACCOUNT_A, operationKind: "sign_transaction" });
    harness.setNow(INITIAL_NOW + 1_000);
    tabA.emitEvent("pagehide");

    tabB.coordinator.acquire({ account: ACCOUNT_B, operationKind: "sign_message" });
    harness.setNow(INITIAL_NOW + 2_000);
    tabB.emitEvent("pagehide");

    assert.equal(tabB.coordinator.getSnapshot().uncertainRecoveries.length, 2);

    // Acquiring Account C with maxRecords=2 evicts the oldest uncertain_recovery (ACCOUNT_A).
    const leaseC = tabB.coordinator.acquire({
      account: ACCOUNT_C,
      operationKind: "sign_transaction",
    });
    const snapshot = tabB.coordinator.getSnapshot();
    assert.equal(snapshot.records.length, 2);
    assert.equal(tabB.coordinator.getAccountState(ACCOUNT_A).status, "idle");
    assert.equal(tabB.coordinator.getAccountState(ACCOUNT_B).status, "uncertain_recovery");
    assert.equal(tabB.coordinator.getAccountState(ACCOUNT_C).status, "active");

    // Advance past recoveryRetentionMs (60_000 ms from uncertainAt=INITIAL_NOW+2_000):
    // stale ACCOUNT_B recovery expires out of bounded retention, while active leaseC is heartbeated.
    leaseC.heartbeat();
    harness.setNow(INITIAL_NOW + 2_000 + 60_001);
    // Keep leaseC alive inside its 30s TTL: wait — heartbeat at +2_000 set expiresAt=+32_000,
    // so test retention pruning specifically when leaseC is released first.
    harness.setNow(INITIAL_NOW + 5_000);
    leaseC.release();
    harness.setNow(INITIAL_NOW + 2_000 + 60_001);
    assert.equal(tabB.coordinator.getAccountState(ACCOUNT_B).status, "idle");
    assert.equal(tabB.coordinator.getSnapshot().records.length, 0);
  } finally {
    harness.disposeAll();
  }
});

test("corrupted storage, malformed JSON, throwing storage, and write races recover gracefully", () => {
  const harness = createSharedHarness();
  try {
    const tabA = harness.createTab("tab-a");

    // Malformed JSON does not throw and recovers cleanly.
    harness.rawMap.set(WALLET_SIGNING_STORAGE_KEY, "{not-valid-json");
    assert.equal(tabA.coordinator.getAccountState(ACCOUNT_A).status, "idle");
    assert.deepEqual(tabA.coordinator.getSnapshot().records, []);

    // Non-object JSON, wrong schema version, and oversized payload recover cleanly.
    for (const badValue of [
      "[]",
      "123",
      JSON.stringify({ version: 99, operations: {} }),
      JSON.stringify({
        version: 1,
        operations: {
          [ACCOUNT_A]: { operationId: "op1", account: ACCOUNT_A, status: "bogus" },
          BAD_KEY: { bogus: true },
        },
      }),
      "x".repeat(20_000),
    ]) {
      harness.rawMap.set(WALLET_SIGNING_STORAGE_KEY, badValue);
      assert.doesNotThrow(() => tabA.coordinator.reconcile());
      assert.equal(tabA.coordinator.getSnapshot().records.length, 0);
    }

    // Injected secret fields in storage are scrubbed on reconcile.
    harness.rawMap.set(
      WALLET_SIGNING_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        operations: {
          [ACCOUNT_A]: {
            operationId: "op-clean",
            account: ACCOUNT_A,
            tabId: "tab-z",
            operationKind: "sign_transaction",
            status: "active",
            acquiredAt: INITIAL_NOW,
            heartbeatAt: INITIAL_NOW,
            expiresAt: INITIAL_NOW + 30_000,
            leakedSecret: "should-be-stripped",
          },
        },
      }),
    );
    const snap = tabA.coordinator.reconcile();
    assert.equal(snap.records.length, 1);
    assert.equal("leakedSecret" in snap.records[0]!, false);

    // Simulated write race: another tab overwrites storage during acquire.
    harness.rawMap.clear();
    const racingStorage: WalletSigningStorage = {
      getItem: harness.storage.getItem,
      removeItem: harness.storage.removeItem,
      setItem(key) {
        harness.rawMap.set(
          key,
          JSON.stringify({
            version: 1,
            operations: {
              [ACCOUNT_A]: {
                operationId: "op-winner",
                account: ACCOUNT_A,
                tabId: "competing-tab",
                operationKind: "sign_message",
                status: "active",
                acquiredAt: INITIAL_NOW,
                heartbeatAt: INITIAL_NOW,
                expiresAt: INITIAL_NOW + 30_000,
              },
            },
          }),
        );
      },
    };
    const racingTab = createWalletSigningCoordinator({
      storage: racingStorage,
      channel: null,
      events: null,
      now: harness.now,
      tabId: "tab-loser",
      autoHeartbeat: false,
    });
    assert.throws(
      () =>
        racingTab.acquire({
          account: ACCOUNT_A,
          operationKind: "sign_transaction",
        }),
      (err) =>
        isWalletSigningCoordinatorError(err) &&
        err.code === "active_in_other_tab" &&
        err.record?.tabId === "competing-tab",
    );
    racingTab.dispose();

    // Storage throwing QuotaExceededError/SecurityError degrades cleanly to in-memory lock.
    const brokenStorage: WalletSigningStorage = {
      getItem() {
        throw new Error("SecurityError: storage disabled");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {
        throw new Error("SecurityError: storage disabled");
      },
    };
    const resilientTab = createWalletSigningCoordinator({
      storage: brokenStorage,
      channel: null,
      events: null,
      now: harness.now,
      tabId: "tab-resilient",
      autoHeartbeat: false,
    });
    const memLease = resilientTab.acquire({
      account: ACCOUNT_A,
      operationKind: "sign_transaction",
    });
    assert.equal(resilientTab.getAccountState(ACCOUNT_A).isOwnedByCurrentTab, true);
    assert.equal(memLease.release(), true);
    assert.equal(resilientTab.getAccountState(ACCOUNT_A).status, "idle");
    resilientTab.dispose();
  } finally {
    harness.disposeAll();
  }
});

test("storage event triggers cross-tab reconciliation without BroadcastChannel", () => {
  const harness = createSharedHarness();
  try {
    const tabA = harness.createTab("tab-a", { channel: null });
    const tabB = harness.createTab("tab-b", { channel: null });

    const leaseA = tabA.coordinator.acquire({
      account: ACCOUNT_A,
      operationKind: "sign_message",
    });
    assert.equal(tabB.snapshots.length, 0);

    // Firing browser storage event on Tab B wakes subscribers immediately.
    tabB.emitEvent("storage", { key: WALLET_SIGNING_STORAGE_KEY });
    assert.equal(tabB.snapshots.length, 1);
    assert.equal(tabB.snapshots[0]?.activeOperations[0]?.operationId, leaseA.operationId);

    // Unrelated storage key does not trigger spurious updates.
    tabB.emitEvent("storage", { key: "other-unrelated-key" });
    assert.equal(tabB.snapshots.length, 1);

    leaseA.release();
    tabB.emitEvent("storage", { key: WALLET_SIGNING_STORAGE_KEY });
    assert.equal(tabB.snapshots.length, 2);
    assert.equal(tabB.snapshots[1]?.activeOperations.length, 0);
  } finally {
    harness.disposeAll();
  }
});

test("uncoordinated signTransaction registry and wallet i18n keys stay aligned", () => {
  const coordinated = async () => ({ signedTxXdr: "coord" });
  const raw = async () => ({ signedTxXdr: "raw" });
  const unregistered = async () => ({ signedTxXdr: "plain" });

  registerUncoordinatedSignTransaction(coordinated, raw);
  assert.equal(resolveUncoordinatedSignTransaction(coordinated), raw);
  assert.equal(resolveUncoordinatedSignTransaction(unregistered), unregistered);

  const en = JSON.parse(
    readFileSync(join(process.cwd(), "messages", "en.json"), "utf8"),
  ) as { wallet: Record<string, string> };

  for (const requiredKey of [
    "signingActiveOtherTabTitle",
    "signingActiveOtherTabHint",
    "signingRecoveryTitle",
    "signingRecoveryHint",
    "signingRecoveryAcknowledge",
    ...Object.values(WALLET_SIGNING_OPERATION_MESSAGE_KEYS),
  ]) {
    assert.equal(
      typeof en.wallet[requiredKey],
      "string",
      `messages/en.json wallet.${requiredKey} must exist`,
    );
    assert.ok(en.wallet[requiredKey]!.length > 0);
  }
});

test("ensureUsdcTrustline acquires enable_trustline without self-deadlocking and enforces cross-tab recovery", async () => {
  const harness = createSharedHarness();
  try {
    const tabA = harness.createTab("tab-a");
    const tabB = harness.createTab("tab-b");

    const baseAccount = Object.assign(new Account(ACCOUNT_A, "100"), {
      balances: [{ asset_type: "native", balance: "100.0000000" }],
    });

    const horizon: TrustlineHorizonClient = {
      async loadAccount() {
        return baseAccount as unknown as Awaited<
          ReturnType<TrustlineHorizonClient["loadAccount"]>
        >;
      },
      async submitTransaction() {
        return { hash: "trustline-tx-hash-1" };
      },
    };

    // Simulate WalletProvider's coordinated `signTransaction` + registered uncoordinated impl.
    const executeSignTx: SignTransaction = async (xdr) => {
      // While inside ensureUsdcTrustline, coordinator holds `enable_trustline` for ACCOUNT_A,
      // so another tab attempting to sign for ACCOUNT_A is blocked.
      const stateInTabB = tabB.coordinator.getAccountState(ACCOUNT_A);
      assert.equal(stateInTabB.status, "active");
      assert.equal(stateInTabB.activeOperation?.operationKind, "enable_trustline");
      assert.equal(stateInTabB.isBlockedByOtherTab, true);
      assert.throws(
        () =>
          tabB.coordinator.acquire({
            account: ACCOUNT_A,
            operationKind: "sign_transaction",
          }),
        (err) =>
          isWalletSigningCoordinatorError(err) && err.code === "active_in_other_tab",
      );
      return { signedTxXdr: xdr, signerAddress: ACCOUNT_A };
    };

    const coordinatedSignTx: SignTransaction = async (xdr, opts) =>
      tabA.coordinator.runOperation(
        { account: ACCOUNT_A, operationKind: "sign_transaction" },
        () => executeSignTx(xdr, opts),
      );
    registerUncoordinatedSignTransaction(coordinatedSignTx, executeSignTx);

    const res = await ensureUsdcTrustline(
      { publicKey: ACCOUNT_A, signTransaction: coordinatedSignTx },
      { coordinator: tabA.coordinator, horizon },
    );
    assert.deepEqual(res, { added: true, hash: "trustline-tx-hash-1" });
    assert.equal(tabA.coordinator.getAccountState(ACCOUNT_A).status, "idle");

    // If Tab A unloads while trustline setup is awaiting signature, Tab B sees uncertain_recovery
    // and ensureUsdcTrustline blocks until explicit opt-in or acknowledgment.
    const blockingSignTx: SignTransaction = async (xdr) => {
      tabA.emitEvent("pagehide");
      return { signedTxXdr: xdr, signerAddress: ACCOUNT_A };
    };
    await ensureUsdcTrustline(
      { publicKey: ACCOUNT_A, signTransaction: blockingSignTx },
      { coordinator: tabA.coordinator, horizon },
    );

    const recoveryState = tabB.coordinator.getAccountState(ACCOUNT_A);
    assert.equal(recoveryState.status, "uncertain_recovery");
    assert.equal(recoveryState.uncertainRecovery?.operationKind, "enable_trustline");

    const plainSignTxForTabB: SignTransaction = async (xdr) => {
      const stateInTabB = tabB.coordinator.getAccountState(ACCOUNT_A);
      assert.equal(stateInTabB.status, "active");
      assert.equal(stateInTabB.activeOperation?.operationKind, "enable_trustline");
      assert.equal(stateInTabB.isOwnedByCurrentTab, true);
      return { signedTxXdr: xdr, signerAddress: ACCOUNT_A };
    };
    const coordinatedSignTxForTabB: SignTransaction = async (xdr, opts) =>
      tabB.coordinator.runOperation(
        { account: ACCOUNT_A, operationKind: "sign_transaction" },
        () => plainSignTxForTabB(xdr, opts),
      );
    registerUncoordinatedSignTransaction(coordinatedSignTxForTabB, plainSignTxForTabB);

    await assert.rejects(
      () =>
        ensureUsdcTrustline(
          { publicKey: ACCOUNT_A, signTransaction: coordinatedSignTxForTabB },
          { coordinator: tabB.coordinator, horizon },
        ),
      (err) =>
        isWalletSigningCoordinatorError(err) && err.code === "uncertain_recovery",
    );

    const retryRes = await ensureUsdcTrustline(
      { publicKey: ACCOUNT_A, signTransaction: coordinatedSignTxForTabB },
      {
        coordinator: tabB.coordinator,
        horizon,
        acknowledgeUncertainRecovery: true,
        expectedRecoveryOperationId: recoveryState.uncertainRecovery?.operationId,
      },
    );
    assert.deepEqual(retryRes, { added: true, hash: "trustline-tx-hash-1" });
    assert.equal(tabB.coordinator.getAccountState(ACCOUNT_A).status, "idle");
  } finally {
    harness.disposeAll();
  }
});

test("WalletContextValue keeps all legacy fields intact and new signing fields optional", () => {
  const legacyCompatibleContext: WalletContextValue = {
    address: null,
    isConnected: false,
    isConnecting: false,
    connect: async () => {},
    disconnect: () => {},
    error: null,
    signTransaction: async () => ({ signedTxXdr: "" }),
    signAuthEntry: async () => ({ signedAuthEntry: "" }),
    signMessage: async () => "",
    signer: null,
    walletName: null,
    canSignMessages: false,
    canSignAuthEntries: false,
    networkWarning: null,
    transactionState: null,
    wallets: [],
    pendingTrustlineIntent: null,
    requestTrustlineThen: async () => {},
  };
  assert.equal(legacyCompatibleContext.signingOwnership, undefined);
  assert.equal(legacyCompatibleContext.signingRecovery, undefined);
});
