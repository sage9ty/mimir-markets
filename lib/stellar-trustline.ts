"use client";

/**
 * The one setup step between a fresh Stellar wallet and staking: a USDC
 * trustline.
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 *
 * The EVM version of this file created a Base Account **sub account** and held a
 * scoped P256 key in browser storage, purely so `approve(USDC)` and the stake
 * could be sent as one ERC-5792 batch and mirroring did not cost two wallet
 * prompts per position.
 *
 * On Soroban that entire mechanism has nothing to optimise. Authorisation is per
 * invocation: `challenge_claim` carries auth permitting exactly one USDC transfer
 * of exactly the staked amount, so there is no allowance to pre-grant and no
 * second transaction to batch with. **Staking is one signature, for every wallet,
 * with no setup.** The sub account, the browser-held key and the batch are all
 * deleted rather than ported — there is no custody question left to answer.
 *
 * What is left is a genuine first-time step: a Stellar account can only hold USDC
 * once it has a trustline to the issuer. That is a classic `changeTrust`
 * operation.
 *
 * ── Why it is NOT one transaction with the stake ─────────────────────────────
 *
 * The obvious design — one envelope holding `changeTrust` + the contract
 * invocation, one signature — is impossible, and not because of an SDK gap.
 * A Stellar transaction carrying a Soroban operation must carry EXACTLY ONE
 * operation, at the protocol level. Verified against the installed
 * `@stellar/stellar-sdk` 16.2.0 rather than assumed:
 *
 *   node_modules/@stellar/stellar-sdk/lib/esm/rpc/transaction.js
 *     isSorobanTransaction(): `if (tx.operations.length !== 1) return false`
 *     assembleTransaction():  throws TypeError
 *       "unsupported transaction: must contain exactly one invokeHostFunction,
 *        extendFootprintTtl, or restoreFootprint operation"
 *     and, in `assembleTransaction`'s own comment:
 *       "in soroban contract tx, there can only be single operation in the tx"
 *
 * `TransactionBuilder.addOperation()` will happily accept both — the builder does
 * not enforce it — so this fails at simulation, or at stellar-core, not at build
 * time. Which is exactly why it is written down here.
 *
 * So the flow is: add the trustline (one signature, once per account, classic
 * transaction), then stake (one signature, every time, Soroban transaction).
 * Worst case for a brand-new account is two signatures TOTAL, once — better than
 * the EVM path's two per stake, and it needs no key custody at all.
 */

import {
  BASE_FEE,
  Operation,
  TransactionBuilder,
  type Horizon,
} from "@stellar/stellar-sdk";

import {
  NETWORK_PASSPHRASE,
  createHorizonServer,
  isAccountAddress,
  type StellarSigner,
} from "./stellar";
import { USDC_CODE, USDC_ISSUER, usdcAsset } from "./usdc";
import {
  getBrowserWalletSigningCoordinator,
  resolveUncoordinatedSignTransaction,
  type WalletSigningCoordinator,
} from "./wallet-signing-coordinator";

export type TrustlineStatus =
  /** Trustline present: the account can hold and stake USDC. */
  | "ready"
  /** Account exists and is funded, but holds no USDC trustline yet. */
  | "missing"
  /**
   * No account on the ledger at all. A Stellar account has to be funded with XLM
   * before it can do anything, including adding a trustline — deliberately
   * distinct from "missing", because the fix is different (get XLM, not click a
   * button here).
   */
  | "unfunded"
  /** Horizon could not be reached. Never reported as "missing". */
  | "unknown";

export interface TrustlineState {
  status: TrustlineStatus;
  /** Display USDC held, when a trustline exists. */
  balance: number | null;
}

export interface HorizonBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  last_modified_ledger?: number;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  is_clawback_enabled?: boolean;
  liquidity_pool_id?: string;
  sponsor?: string;
}

export interface HorizonAccount {
  balances: readonly HorizonBalanceLine[];
}

export type HorizonAccountLoader = (address: string) => Promise<HorizonAccount>;

export interface ReadUsdcTrustlineOptions {
  loadAccount?: HorizonAccountLoader;
  server?: { loadAccount: HorizonAccountLoader };
}

function resolveAccountLoader(
  options: HorizonAccountLoader | ReadUsdcTrustlineOptions,
): HorizonAccountLoader {
  if (typeof options === "function") return options;
  if (options.loadAccount) return (address) => options.loadAccount!(address);
  if (options.server) return (address) => options.server!.loadAccount(address);
  return (address) => createHorizonServer().loadAccount(address);
}

/**
 * Read the USDC trustline straight from Horizon.
 *
 * Horizon rather than the SAC balance read in `lib/usdc.ts`: that helper folds
 * "no trustline", "no account" and "RPC hiccup" all into `null`, and this is the
 * one place where telling them apart is the whole point.
 */
export async function readUsdcTrustline(
  address: string,
  options: HorizonAccountLoader | ReadUsdcTrustlineOptions = {},
): Promise<TrustlineState> {
  if (!isAccountAddress(address)) return { status: "unknown", balance: null };
  const loadAccount = resolveAccountLoader(options);
  try {
    const account = await loadAccount(address);
    const line = account.balances.find(
      (balance): balance is Horizon.HorizonApi.BalanceLineAsset =>
        (balance.asset_type === "credit_alphanum4" || balance.asset_type === "credit_alphanum12") &&
        balance.asset_code === USDC_CODE &&
        balance.asset_issuer === USDC_ISSUER,
    );
    if (!line) return { status: "missing", balance: null };
    return { status: "ready", balance: Number(line.balance) };
  } catch (cause) {
    // Horizon answers a missing account with 404. Anything else is a transport
    // problem and must not be reported as a missing trustline — that would show
    // an "add trustline" button to someone who already has one.
    const status = (cause as { response?: { status?: number } })?.response?.status;
    if (status === 404) return { status: "unfunded", balance: null };
    return { status: "unknown", balance: null };
  }
}

export interface TrustlineHorizonClient {
  loadAccount: (
    address: string,
  ) => Promise<ConstructorParameters<typeof TransactionBuilder>[0] & HorizonAccount>;
  submitTransaction: (
    transaction: ReturnType<typeof TransactionBuilder.fromXDR>,
  ) => Promise<{ hash: string }>;
}

export interface EnsureUsdcTrustlineOptions {
  /**
   * Optional cross-tab coordinator override (for deterministic tests or custom
   * scopes; defaults to the browser singleton in browser contexts and `null`
   * on the server).
   */
  coordinator?: WalletSigningCoordinator | null;
  /** Opt-in retry flag to clear a pending `uncertain_recovery` before prompting. */
  acknowledgeUncertainRecovery?: boolean;
  /** Optional operationId guard paired with {@link acknowledgeUncertainRecovery}. */
  expectedRecoveryOperationId?: string;
  /** Optional Horizon client override for deterministic offline testing. */
  horizon?: TrustlineHorizonClient;
}

/**
 * Add the USDC trustline, signed by the connected wallet.
 *
 * One classic `changeTrust` operation, one signature, submitted through Horizon
 * (Soroban RPC does not accept classic-only transactions for submission in a way
 * that gains anything here). Idempotent from the caller's point of view: a
 * trustline that already exists returns immediately without prompting.
 */
export async function ensureUsdcTrustline(
  signer: StellarSigner,
  options: EnsureUsdcTrustlineOptions = {},
): Promise<{ added: boolean; hash?: string }> {
  const existing = await readUsdcTrustline(
    signer.publicKey,
    options.horizon ? { server: options.horizon } : {},
  );
  if (existing.status === "ready") return { added: false };
  if (existing.status === "unfunded") {
    throw new Error(
      "This account does not exist on the Stellar ledger yet. Fund it with XLM first, then add the USDC trustline.",
    );
  }

  const coordinator =
    options.coordinator !== undefined
      ? options.coordinator
      : typeof window !== "undefined"
        ? getBrowserWalletSigningCoordinator()
        : null;

  const execute = async (): Promise<{ added: boolean; hash?: string }> => {
    const horizon = options.horizon ?? createHorizonServer();
    const account = await horizon.loadAccount(signer.publicKey);

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.changeTrust({ asset: usdcAsset() }))
      // 180s rather than the 30s used for simulation-only envelopes: this one is
      // actually submitted, and a hardware wallet confirmation can take a while.
      .setTimeout(180)
      .build();

    const signTx = resolveUncoordinatedSignTransaction(signer.signTransaction);
    const { signedTxXdr } = await signTx(transaction.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
      address: signer.publicKey,
    });

    const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
    const result = await horizon.submitTransaction(signed);
    return { added: true, hash: result.hash };
  };

  if (!coordinator) {
    return execute();
  }

  return coordinator.runOperation(
    {
      account: signer.publicKey,
      operationKind: "enable_trustline",
      acknowledgeUncertainRecovery: options.acknowledgeUncertainRecovery,
      expectedRecoveryOperationId: options.expectedRecoveryOperationId,
    },
    execute,
  );
}


// ── Decoupled submit / confirm (#769) ────────────────────────────────────────
//
// `ensureUsdcTrustline` above awaits `horizon.submitTransaction` and returns
// after the tx is already in a ledger. That is fine for a caller that stays
// on the screen, but a *resumable* setup needs the two steps separate: the
// classic trustline transaction must be submittable on its own, and the
// caller must be able to leave and come back before we treat it as ready.
//
// The two functions below provide that split without changing
// `ensureUsdcTrustline` — its behaviour and return shape are byte-identical.

/** Terminal or in-flight state of a decoupled trustline submission. */
export type TrustlineTransactionOutcome =
  | { status: "submitted"; hash: string }
  | { status: "confirmed"; hash: string }
  | { status: "failed"; reason: string };

/**
 * Build, sign and submit the classic USDC changeTrust — and stop there.
 *
 * The returned `hash` identifies the submission so the caller can persist
 * `pendingTrustlineIntent` and await confirmation later. No polling, no
 * confirmation wait: the caller decides when to call
 * {@link awaitUsdcTrustlineConfirmation}.
 *
 * An account that already holds the trustline is a no-op that returns the
 * "submitted" state with a synthetic hash so callers have one shape to
 * handle. The intent behind this (#769) is idempotency, not a real ledger
 * write, so no signature is prompted.
 */
export async function submitUsdcTrustline(
  signer: StellarSigner,
): Promise<TrustlineTransactionOutcome> {
  const existing = await readUsdcTrustline(signer.publicKey);
  if (existing.status === "ready") {
    return { status: "submitted", hash: "" };
  }
  if (existing.status === "unfunded") {
    return {
      status: "failed",
      reason:
        "This account does not exist on the Stellar ledger yet. Fund it with XLM first, then add the USDC trustline.",
    };
  }

  const horizon = createHorizonServer();
  const account = await horizon.loadAccount(signer.publicKey);

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: usdcAsset() }))
    .setTimeout(180)
    .build();

  const { signedTxXdr } = await signer.signTransaction(transaction.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: signer.publicKey,
  });

  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
  try {
    const result = await horizon.submitTransaction(signed);
    return { status: "submitted", hash: result.hash };
  } catch (cause) {
    return {
      status: "failed",
      reason:
        cause instanceof Error
          ? cause.message
          : "Trustline submission failed.",
    };
  }
}

/**
 * Wait until the USDC trustline is present on chain, or fail.
 *
 * Polls the same Horizon read used by {@link readUsdcTrustline}; it does not
 * re-read the transaction hash. That is deliberate: the *observable* fact the
 * caller needs is "can this account hold USDC now?", which is exactly what
 * `readUsdcTrustline` answers. A trustline that appeared via another tab,
 * another device, or a wallet's built-in helper is the same outcome and must
 * resume the intent the same way.
 *
 * Bounded by `timeoutMs` (default 60s) so a stalled Horizon cannot hang a
 * resumption forever. Returns `{ status: "confirmed" }` as soon as the line
 * is present, and `{ status: "failed" }` on timeout or an unfunded account.
 */
export async function awaitUsdcTrustlineConfirmation(
  address: string,
  options: { timeoutMs?: number; intervalMs?: number; loadAccount?: HorizonAccountLoader } = {},
): Promise<TrustlineTransactionOutcome> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const loader = options.loadAccount;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const state = await readUsdcTrustline(address, loader ? { loadAccount: loader } : {});
    if (state.status === "ready") {
      return { status: "confirmed", hash: "" };
    }
    if (state.status === "unfunded") {
      return {
        status: "failed",
        reason: "Account is not funded on the Stellar ledger.",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    status: "failed",
    reason: `Trustline did not appear within ${timeoutMs}ms.`,
  };
}
