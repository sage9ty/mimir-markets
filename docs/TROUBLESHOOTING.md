# Mimir Troubleshooting Guide

This guide collects causes, code references, and fixes for errors contributors, agent workers, and scripts encounter most often across Mimir's Stellar Testnet infrastructure.

---

## Table of Contents

- [Quick Reference](#quick-reference)
- [Common Error Entries](#common-error-entries)
  - [1. Missing USDC Trustline](#1-missing-usdc-trustline)
  - [2. Account Not Found on Ledger](#2-account-not-found-on-ledger)
  - [3. Friendbot Rate Limit (HTTP 429)](#3-friendbot-rate-limit-http-429)
  - [4. Bad Transaction Sequence Number (`tx_bad_seq`)](#4-bad-transaction-sequence-number-tx_bad_seq)
  - [5. Smart Contract Simulation Failure (`Error(Contract, #<code_number>)`)](#5-smart-contract-simulation-failure-errorcontract-code_number)
  - [6. Missing Database URL (`DATABASE_URL is not configured`)](#6-missing-database-url-database_url-is-not-configured)
  - [7. x402 Payment Too Old (`payment_too_old`)](#7-x402-payment-too-old-payment_too_old)
  - [8. x402 Payment Already Settled (`already_settled`)](#8-x402-payment-already-settled-already_settled)
  - [9. x402 Insufficient Payment Amount (`insufficient_amount`)](#9-x402-insufficient-payment-amount-insufficient_amount)
  - [10. Insufficient USDC Bankroll](#10-insufficient-usdc-bankroll)
  - [11. Oracle Settlement Operator-Paused](#11-oracle-settlement-operator-paused)
  - [12. Malformed Oracle Verdict / LLM Parse Failure](#12-malformed-oracle-verdict--llm-parse-failure)
  - [13. Horizon Unreachable or Transaction Not Found](#13-horizon-unreachable-or-transaction-not-found)
  - [14. Contract Not Initialized (`NotInitialized` Error #2)](#14-contract-not-initialized-notinitialized-error-2)
  - [15. Self-Challenge Rejection (`SelfChallenge` Error #14)](#15-self-challenge-rejection-selfchallenge-error-14)
  - [16. Duel Market Stake Mismatch (`DuelNeedsEqualStake` Error #19)](#16-duel-market-stake-mismatch-duelneedsequalstake-error-19)
  - [17. Deadline in Past / Not Yet Expired (#10 vs #22)](#17-deadline-in-past--not-yet-expired-10-vs-22)
  - [18. Metadata Exceeds Byte Budget (#41 / #42)](#18-metadata-exceeds-byte-budget-41--42)
  - [19. Unconfigured Council Personas](#19-unconfigured-council-personas)
  - [20. Uncertain Challenge Stake Submission (Recovery Panel)](#20-uncertain-challenge-stake-submission-recovery-panel)
- [Contract Error Code Reference](#contract-error-code-reference)
  - [`mimir-market` Error Codes (1–47)](#mimir-market-error-codes-147)
  - [`mimir-squad` Error Codes (1–32)](#mimir-squad-error-codes-132)

---

## Quick Reference

| Error Symptom / Message | Likely Cause | Quick Fix |
|---|---|---|
| `no USDC trustline — run npm run agents:fund` | Account has no trustline for testnet USDC | Run `npm run agents:fund` |
| `account does not exist on the ledger` | Public key generated but not funded on testnet | Run `npm run agents:fund` (Friendbot) |
| `friendbot 429 for <G...>` | Friendbot rate limit reached | Wait 1–2 minutes before retrying |
| `tx_bad_seq` | Sequence drift from concurrent worker submissions | Restart worker; serialize transactions |
| `Error(Contract, #22)` (`NotYetExpired`) | Resolving claim before deadline elapsed | Wait until claim deadline passes |
| `DATABASE_URL is not configured` | Missing Postgres connection string | Add `DATABASE_URL` to `.env.local` |
| `payment_too_old` | x402 payment landed >5 minutes ago | Submit fresh payment; sync clock via NTP |
| `already_settled` | Transaction hash presented more than once | Present unique payment transaction |
| `insufficient creator USDC` | Balance below required stake | Run `npm run agents:fund` or Circle faucet |
| `oracle_settlement capability paused` | Kill-switch `MIMIR_PAUSE_ORACLE_SETTLEMENT=1` active | Set `MIMIR_PAUSE_ORACLE_SETTLEMENT=0` |

---

## Common Error Entries

### 1. Missing USDC Trustline

- **Message**:
  - `no USDC trustline — run npm run agents:fund`
  - `[challenge] Oracle holds no USDC trustline — run npm run agents:fund`
  - `the oracle holds no USDC trustline — run npm run agents:fund first, or use the SDEX faucet`
  - `creator holds no USDC trustline — run npm run agents:fund`
- **Cause**: On Stellar, accounts cannot hold or transact in non-native assets without an explicit trustline to the asset's issuer. The account exists on testnet and holds native XLM, but lacks a trustline for Circle's Testnet USDC (`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`).
- **Fix**: Run `npm run agents:fund` (or `npm run stellar:keys`). This script connects to the testnet Horizon instance and submits a `changeTrust` operation for all agent wallets defined in `.env.local`. For personal browser wallets (e.g. Freighter), manually add testnet USDC in the asset management tab.
- **Code Location**:
  - `agents/oracle/index.ts:758` (`evaluateChallengeClaim`)
  - `agents/traders/index.ts:277` (`cycleTrader`)
  - `scripts/fund-from-oracle.ts:100, 141`
  - `scripts/fund-yapper.ts:65`
  - `scripts/seed-today.ts:203`

---

### 2. Account Not Found on Ledger

- **Message**:
  - `creator account <G...> does not exist on the ledger — run: npm run agents:fund`
  - `oracle account <G...> does not exist on the ledger — run: npm run agents:fund`
  - `[traders]   account does not exist — run npm run agents:fund`
  - `the oracle account does not exist yet — run npm run agents:fund (friendbot creates it)`
- **Cause**: Stellar uses an account-creation model: public keys generated locally do not exist on the ledger until another account (or Friendbot) submits a `createAccount` operation with at least the base reserve (1 XLM).
- **Fix**: Run `npm run agents:fund`. This automatically requests funding for missing accounts from Stellar Testnet Friendbot (`https://friendbot.stellar.org/?addr=<PUBLIC_KEY>`), creating the account on-chain with 10,000 testnet XLM. Individual accounts can also be funded via [Stellar Laboratory Account Creator](https://lab.stellar.org/account/fund).
- **Code Location**:
  - `agents/market-creator/index.ts:1270-1272` (`main`)
  - `agents/oracle/index.ts:925-927` (`main`)
  - `agents/traders/index.ts:274` (`cycleTrader`)
  - `scripts/seed-today.ts:201`
  - `scripts/topup-oracle-from-creator.ts:64`

---

### 3. Friendbot Rate Limit (HTTP 429)

- **Message**:
  - `friendbot 429 for <G...>: <response_body>`
  - `friendbot 504 for <G...>`
- **Cause**: The public Stellar Testnet Friendbot applies IP and address rate limits. Calling `agents:fund` repeatedly in a short duration or launching multiple key creation scripts triggers HTTP 429 (Too Many Requests).
- **Fix**:
  1. Wait 60–120 seconds before retrying `npm run agents:fund`.
  2. Because a single Friendbot grant supplies 10,000 XLM and operations cost ~0.00001 XLM (100 stroops), accounts rarely require topping up.
  3. If automation requires dedicated funding, point `STELLAR_FRIENDBOT_URL` to an internal or alternative Friendbot instance, or fund keys via [Stellar Lab](https://lab.stellar.org/account/fund).
- **Code Location**:
  - `lib/agent-wallets.ts:227` (`ensureFunded`)
  - `scripts/lib/stellar-funding.ts:99` (`createViaFriendbot`)
  - `scripts/stellar-keys.ts:75` (`fundWithFriendbot`)

---

### 4. Bad Transaction Sequence Number (`tx_bad_seq`)

- **Message**:
  - `tx_bad_seq`
  - `Transaction simulation failed: txBadSeq`
  - Horizon error response code `tx_bad_seq`
- **Cause**: Stellar strictly requires that each transaction sequence number equals `account.sequence + 1`. This error is emitted by Horizon / stellar-core when:
  1. Multiple processes or workers concurrently submit transactions using the same secret key without centralized sequence tracking.
  2. A previous transaction failed locally or timed out after incrementing an in-memory sequence counter, leaving a sequence hole.
  3. An out-of-band transaction was submitted from another client (e.g. manual CLI or wallet extension), causing local sequence state to drift.
- **Fix**:
  1. Avoid sharing the same secret seed across multiple concurrent processes or agent workers.
  2. In application code, use `SequenceManager` (`lib/agents/sequence-manager.ts`), which handles sequential reservation and automatically resyncs via `resync(address)` upon encountering `tx_bad_seq`.
  3. If an autonomous worker process logs `tx_bad_seq`, restart the worker so it performs a fresh sequence read from Horizon.
- **Code Location**:
  - `lib/agents/sequence-manager.ts:6-29, 187` (`SequenceManager.resync`)
  - `lib/settlement-retry.ts:235-243` (`classifySettlementError`)

---

### 5. Smart Contract Simulation Failure (`Error(Contract, #<code_number>)`)

- **Message**:
  - `Error(Contract, #22)`
  - `Error(Contract, #12)`
  - `resolve_claim: NotYetExpired`
  - `HostError: Error(Contract, #<num>)`
- **Cause**: Soroban contract invocations simulate transaction execution before submission. When a contract invariant or assertion fails, Soroban returns a host error containing the contract error code defined in `contracts-soroban/mimir-market/src/types.rs` or `contracts-soroban/mimir-squad/src/types.rs`.
- **Fix**:
  1. Extract the numeric code (e.g., `#22` corresponds to `NotYetExpired`; `#12` to `ClaimNotFound`; `#21` to `ClaimNotActive`; `#4` to `NotOracle`).
  2. Consult the [Contract Error Code Reference](#contract-error-code-reference) below for the exact precondition and remedy.
  3. For lifecycle errors such as `NotYetExpired`, wait until the claim's deadline has passed on-chain before retrying resolution.
- **Code Location**:
  - `lib/contract.ts:342-364` (`unwrap`)
  - `lib/contract.ts:455-478` (`sendCall`)
  - `lib/settlement-retry.ts:158-169, 215-233` (`numericContractCode`, `classifySettlementError`)

---

### 6. Missing Database URL (`DATABASE_URL is not configured`)

- **Message**:
  - `DATABASE_URL is not configured`
  - `DATABASE_URL is required — the read index has nowhere to live`
  - `DATABASE_URL is required — the read-index backup has nowhere to read from`
- **Cause**: Database-backed components—such as the read-index sync worker (`npm run sync`), migration scripts (`npm run migrate:up`), and index backup tools—require a Postgres connection string, but neither `DATABASE_URL` nor `TURSO_DATABASE_URL` is set in the environment.
- **Fix**:
  1. Add `DATABASE_URL="postgres://user:password@host/database?sslmode=require"` to `.env.local`.
  2. For local testing without a live database, core UI read operations fall back to chain RPC or in-process stubs, but workers executing `npm run sync` require a configured database.
- **Code Location**:
  - `lib/db.ts:741` (`getDbConnectionString`)
  - `agents/sync/index.ts:78` (`main`)
  - `lib/server/read-index-backup.ts:274` (`exportReadIndexBackup`)

---

### 7. x402 Payment Too Old (`payment_too_old`)

- **Message**:
  - `payment is <N>s old, the window is <M>s`
  - Verification failure: `invalidReason: "payment_too_old"`
- **Cause**: The buyer presented an x402 payment proof referencing a transaction that landed on the ledger earlier than `X402_PAYMENT_MAX_AGE_MS` (default 300,000ms / 5 minutes) ago. Mimir's seller scheme enforces this freshness window to prevent replay of old transactions.
- **Fix**:
  1. Generate and submit a fresh payment transaction immediately prior to presenting the payment proof.
  2. Verify system clock synchronization via NTP. Significant clock skew between buyer, seller, and Horizon nodes can cause transactions to appear expired immediately.
- **Code Location**:
  - `lib/x402/stellar-scheme.ts:215, 365-372` (`verifyStellarPayment`)
  - `lib/x402/config.ts:30` (`X402_PAYMENT_MAX_AGE_MS`)

---

### 8. x402 Payment Already Settled (`already_settled`)

- **Message**:
  - `<tx_hash> has already paid for a response`
  - Settlement failure: `invalidReason: "already_settled"` / `errorReason: "already_settled"`
- **Cause**: The transaction hash in the payment proof has already been settled and recorded in the database `payments_v2` table or the in-process replay cache (`consumed`). x402 payment transactions are strictly single-use per resource request.
- **Fix**:
  1. Issue a new on-chain payment transaction for each paid API request.
  2. In test fixtures and mock runners, call `resetConsumedSettlements()` between test suites to clear the in-process replay cache.
- **Code Location**:
  - `lib/x402/stellar-scheme.ts:218, 500-512, 649-655, 679-687` (`consumeSettlement`, `isSettlementConsumed`, `ExactStellarFacilitator.verify`, `ExactStellarFacilitator.settle`)

---

### 9. x402 Insufficient Payment Amount (`insufficient_amount`)

- **Message**:
  - `paid <X> USDC, quote is <Y> USDC`
  - Verification failure: `invalidReason: "insufficient_amount"`
- **Cause**: The Stellar payment operation transferred less USDC than demanded by the 402 HTTP challenge quote. This commonly occurs when an integration assumes 6 decimal places (EVM USDC standard) instead of 7 decimal places (Stellar Asset Contract standard, where 1 USDC = 10,000,000 atomic units / stroops).
- **Fix**: Denominate all Stellar USDC transfers with 7 decimals using `USDC_DECIMALS = 7` or `parseUsdcAtomic`. Ensure the transaction's payment operation amount is greater than or equal to `requirements.amount`.
- **Code Location**:
  - `lib/x402/stellar-scheme.ts:217, 418-423` (`verifyStellarPayment`)
  - `lib/usdc.ts:13-18` (`USDC_DECIMALS`, `parseUsdcAtomic`)

---

### 10. Insufficient USDC Bankroll

- **Message**:
  - `insufficient creator USDC — run npm run agents:fund`
  - `[challenge] Insufficient USDC (<X> USDC), skipping`
  - `[traders]   below <X> USDC, standing aside`
- **Cause**: The agent account has a valid USDC trustline, but its available USDC balance is lower than the required minimum stake (e.g. `MIN_STAKE = 2 USDC`, `CREATOR_STAKE_USDC`, or `persona.stakeUsdc`).
- **Fix**:
  1. Run `npm run agents:fund` to swap XLM for USDC on the testnet SDEX.
  2. Request testnet USDC for the wallet address directly from [Circle's Testnet Faucet](https://faucet.circle.com).
  3. Run `npm run stellar:usdc` to execute the built-in SDEX self-path-payment faucet.
- **Code Location**:
  - `scripts/seed-today.ts:206`
  - `agents/oracle/index.ts:761-764` (`evaluateChallengeClaim`)
  - `agents/traders/index.ts:280` (`cycleTrader`)

---

### 11. Oracle Settlement Operator-Paused

- **Message**:
  - `oracle_settlement capability paused`
  - `oracle settlement is operator-paused`
  - `MIMIR_PAUSE_ORACLE_SETTLEMENT=1`
- **Cause**: The emergency operational kill-switch `MIMIR_PAUSE_ORACLE_SETTLEMENT` is set to `1` in environment variables or active capability flags. The oracle worker classifies this as `paused` and defers transaction execution before evidence collection, LLM evaluation, or signing.
- **Fix**:
  1. Check the incident runbook at [`docs/AGENT_INCIDENT_RUNBOOK.md`](AGENT_INCIDENT_RUNBOOK.md).
  2. If the incident or maintenance window has passed and RPC/oracle balances are healthy, remove `MIMIR_PAUSE_ORACLE_SETTLEMENT=1` or set it to `0`.
  3. Validate posture with `npm run verify:status`.
- **Code Location**:
  - `lib/settlement-retry.ts:194-199, 285` (`classifySettlementError`, `settlementRetryDecision`)
  - `docs/AGENT_INCIDENT_RUNBOOK.md:21, 42`

---

### 12. Malformed Oracle Verdict / LLM Parse Failure

- **Message**:
  - `Oracle verdict invalid_json after <N> attempt(s): <detail>`
  - `Oracle verdict malformed after <N> attempt(s)`
  - `invalid-json after 2 attempts`
- **Cause**: The LLM returned non-JSON output, truncated content, or JSON that violates `VERDICT_LLM_SCHEMA` (such as an invalid winner side or missing reasoning). The settlement retry engine treats malformed verdicts as non-retryable and aborts the current run to prevent parser errors from becoming incorrect on-chain verdicts or refunds.
- **Fix**:
  1. Check LLM provider credentials (`GEMINI_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`).
  2. Confirm the configured model (`LLM_MODEL`) supports structured JSON output.
  3. Check the prompt length and claim question text for special characters or truncation. Re-running the oracle on the next polling cycle will retry evaluation.
- **Code Location**:
  - `agents/oracle/index.ts:365-367` (`evaluateClaimWithLLM`)
  - `lib/settlement-retry.ts:228-233, 287` (`classifySettlementError`, `settlementRetryDecision`)

---

### 13. Horizon Unreachable or Transaction Not Found

- **Message**:
  - `Horizon could not be read: <error>`
  - `<tx_hash> is not on the <network> ledger`
  - `Horizon operations read failed`
  - Verification failure: `reason: "horizon_unavailable"` / `reason: "transaction_not_found"`
- **Cause**:
  1. Horizon RPC is experiencing latency or temporary downtime.
  2. The transaction was queried immediately after submission before the Stellar ledger closed (typically 3–5 seconds).
  3. The transaction was submitted to a different network (e.g. public network instead of testnet).
- **Fix**:
  1. Verify `STELLAR_HORIZON_URL` in `.env.local` points to a healthy endpoint (default: `https://horizon-testnet.stellar.org`).
  2. Ensure client code awaits ledger close (~5 seconds) before querying transaction endpoints.
  3. Confirm the transaction was submitted to `stellar:testnet`.
- **Code Location**:
  - `lib/x402/stellar-scheme.ts:213, 219, 341-353, 377-383` (`verifyStellarPayment`)
  - `lib/stellar.ts:22-38` (`createHorizonServer`)

---

### 14. Contract Not Initialized (`NotInitialized` Error #2)

- **Message**:
  - `Error(Contract, #2)`
- **Cause**: The contract was deployed to the ledger, but `initialize(...)` has not yet been invoked. Calls to functions such as `create_claim`, `challenge_claim`, or `resolve_claim` will fail until the contract is initialized with its token and admin parameters.
- **Fix**: Run `npm run deploy:contract` or execute the initialization script (`deploy/deploy.ts`). If testing against a newly deployed contract ID, verify that initialization completed successfully.
- **Code Location**:
  - `contracts-soroban/mimir-market/src/types.rs:365` (`Error::NotInitialized`)
  - `contracts-soroban/mimir-squad/src/types.rs:86` (`Error::NotInitialized`)

---

### 15. Self-Challenge Rejection (`SelfChallenge` Error #14)

- **Message**:
  - `Error(Contract, #14)`
  - `SelfChallenge`
- **Cause**: The creator of a market claim attempted to challenge their own market claim. The contract explicitly forbids creators from taking the counter-position against themselves.
- **Fix**: Use a separate challenger or trader keypair (`TRADER_SECRET_*`) to challenge the claim. Do not submit challenges using `MARKET_CREATOR_SECRET`.
- **Code Location**:
  - `contracts-soroban/mimir-market/src/types.rs:377` (`Error::SelfChallenge`)

---

### 16. Duel Market Stake Mismatch (`DuelNeedsEqualStake` Error #19)

- **Message**:
  - `Error(Contract, #19)`
  - `DuelNeedsEqualStake`
- **Cause**: In a 1v1 duel market (`market_type == "duel"`), the challenger's stake must exactly match the creator's initial stake (`creator_stake`).
- **Fix**: Query the claim using `get_claim(id)` and supply the exact matching stake amount when calling `challenge_claim`.
- **Code Location**:
  - `contracts-soroban/mimir-market/src/types.rs:382` (`Error::DuelNeedsEqualStake`)

---

### 17. Deadline in Past / Not Yet Expired (#10 vs #22)

- **Message**:
  - `Error(Contract, #10)` (`DeadlineInPast`)
  - `Error(Contract, #22)` (`NotYetExpired`)
- **Cause**:
  - Error #10: A market creator tried to create a claim whose deadline timestamp is earlier than or equal to the current ledger timestamp.
  - Error #22: An oracle attempted to call `resolve_claim` before the claim's deadline timestamp had passed on-chain.
- **Fix**:
  - For #10: Set deadlines in the future (e.g., at least several minutes to hours ahead).
  - For #22: Wait until the deadline timestamp has elapsed on the Stellar ledger before invoking oracle settlement. The oracle worker automatically checks `settlementSnapshotIsReady` (`lib/settlement-retry.ts:353`) and skips unexpired claims.
- **Code Location**:
  - `contracts-soroban/mimir-market/src/types.rs:373, 385` (`Error::DeadlineInPast`, `Error::NotYetExpired`)
  - `lib/settlement-retry.ts:219-222, 279, 353-358` (`settlementSnapshotIsReady`)

---

### 18. Metadata Exceeds Byte Budget (#41 / #42)

- **Message**:
  - `Error(Contract, #41)` (`MetadataTooLong`)
  - `Error(Contract, #42)` (`ClaimMetadataTooLong`)
  - `Error(Contract, #27)` (`QuestionTooLong` in Squad)
- **Cause**: Soroban persistent ledger entries have strict footprint limits. A single metadata string exceeded `MAX_METADATA_BYTES` (512 bytes) or the combined metadata strings on a claim exceeded `MAX_CLAIM_METADATA_BYTES` (2,048 bytes).
- **Fix**: Shorten the question text, position strings, settlement rules, or resolution URL before calling `create_claim`.
- **Code Location**:
  - `contracts-soroban/mimir-market/src/types.rs:75, 83, 416-419` (`Error::MetadataTooLong`, `Error::ClaimMetadataTooLong`)
  - `contracts-soroban/mimir-squad/src/types.rs:31, 113` (`Error::QuestionTooLong`)

---

### 19. Unconfigured Council Personas

- **Message**:
  - `[council] No personas have wallets configured. Exiting.`
  - `invalid council persona registry slug '<slug>'`
- **Cause**: The council agent was started with `npm run council`, but none of the persona definitions in `agents/council/personas.ts` have corresponding wallet credentials or secret keys configured in `.env.local`.
- **Fix**: Run `npm run agents:create-wallets` to generate missing wallet keys, or configure the required council secrets (e.g. `COUNCIL_SECRET_<SLUG>`) in `.env.local`. Ensure persona slugs follow kebab-case.
- **Code Location**:
  - `agents/council/index.ts:158` (`main`)
  - `agents/council/personas.ts:265-369` (`validatePersona`)

### 20. Uncertain Challenge Stake Submission (Recovery Panel)

- **Message**:
  - `Your stake was submitted but its outcome is uncertain. Tracking the transaction — do not submit a second stake.`
  - The market detail page shows a "Stake submission uncertain" panel and hides the stake action.
- **Cause**: A user-signed `challenge_claim` was submitted but the client never observed the outcome (the wallet reported it pending, or the RPC threw after submission while carrying a transaction hash). Stellar is final on inclusion, so the transaction may still land; offering a second stake could double-stake the wallet.
- **Fix**: No operator action is needed. The panel displays the submitted transaction hash with an explorer link and runs bounded automatic status checks (`CHALLENGE_RECOVERY_MAX_STATUS_CHECKS = 5`, one per ledger close). The record persists in `localStorage` under `proven_challenge_recovery` and stops blocking once the outcome is observed or the record expires (`CHALLENGE_RECOVERY_MAX_AGE_MS = 30 min`). Recovery never resubmits — Soroban contract state stays authoritative.
- **Code Location**:
  - `lib/challenge-recovery.ts` (state machine + storage)
  - `hooks/useVsDetail.ts` (`challengeRecovery`, `beginChallengeRecovery`, `checkChallengeRecovery`, `dismissChallengeRecovery`)
  - `components/vs/ChallengeRecoveryPanel.tsx` (UI)
  - `app/[locale]/vs/[id]/page.tsx` (`handleAccept` pending/uncertain paths)

---

## Contract Error Code Reference

When a Soroban contract call reverts, the RPC returns `Error(Contract, #<ID>)`. Use the mappings below to identify the exact cause.

### `mimir-market` Error Codes (1–47)

Defined in [`contracts-soroban/mimir-market/src/types.rs`](../contracts-soroban/mimir-market/src/types.rs#L360-L434).

| Code | Name | Human Explanation & Troubleshooting |
|---|---|---|
| **1** | `AlreadyInitialized` | Contract has already been initialized. Do not re-call `initialize`. |
| **2** | `NotInitialized` | Contract is not yet initialized. Deployer must call `initialize` with token, owner, and oracle addresses. |
| **3** | `NotOwner` | Caller is not the contract owner. Administrative actions (fee updates, oracle rotation) require owner authorization. |
| **4** | `NotOracle` | Caller is not the authorized oracle address. `resolve_claim` requires oracle authorization. |
| **5** | `FeeCapExceeded` | Total fee (`platform_fee_bps + agent_owner_fee_bps`) exceeds `MAX_TOTAL_FEE_BPS` (1,000 bps = 10%). |
| **6** | `FeeNeedsRecipient` | A fee percentage greater than zero was configured without specifying a recipient address. |
| **7** | `NothingQueued` | Attempted to execute or cancel a timelocked policy or oracle rotation, but nothing is pending. |
| **8** | `Timelocked` | Timelock delay (`172,800` seconds / 2 days) has not yet elapsed for the queued fee policy or oracle change. |
| **9** | `StakeTooSmall` | Stake is below `MIN_STAKE` (2 USDC = 20,000,000 atomic units at 7 decimals). |
| **10** | `DeadlineInPast` | Claim creation deadline timestamp is in the past relative to the current ledger timestamp. |
| **11** | `EmptyQuestion` | Market question string is empty. |
| **12** | `ClaimNotFound` | The specified claim ID does not exist on this contract instance. |
| **13** | `ClaimNotOpen` | Claim is not in `Open` state (it is already Active, Resolved, or Cancelled). |
| **14** | `SelfChallenge` | Creator attempted to challenge their own market claim. Challenges must come from counterparties. |
| **15** | `AlreadyChallenged` | Caller has already challenged this claim. Duplicate challenges from the same address are rejected. |
| **16** | `ClaimFull` | Claim reached `max_challengers` or `MAX_CHALLENGERS` (100). |
| **17** | `ChallengeWindowClosed` | Less than `CHALLENGE_LOCK_SECONDS` (60s) remains before the deadline, or deadline has passed. Challenges are closed. |
| **18** | `InvalidInviteKey` | For private markets, the supplied invite key does not match the claim's `invite_key_hash`. |
| **19** | `DuelNeedsEqualStake` | In a duel market (`market_type == "duel"`), challenger stake must equal creator stake. |
| **20** | `InsufficientCreatorLiquidity` | For pool markets, creator stake cannot back the liability for the requested odds. |
| **21** | `ClaimNotActive` | `resolve_claim` called on a claim that is not in the `Active` state. |
| **22** | `NotYetExpired` | `resolve_claim` called before the claim's deadline timestamp has passed on-chain. |
| **23** | `InvalidVerdict` | Verdict is invalid (e.g. `WinnerSide::None`). A valid winner side must be specified. |
| **24** | `NotCreator` | Caller is not the claim creator (e.g., when invoking `cancel_claim`). |
| **25** | `NothingToWithdraw` | Creator has no unclaimed funds or refunds remaining on this claim. |
| **26** | `NoFees` | No accrued fees are available for withdrawal by caller. |
| **27** | `PayoutExceedsEscrow` | Calculated payout exceeds remaining escrow in the contract (conservation invariant failure). |
| **28** | `UnsupportedToken` | Token contract address is not supported. |
| **29** | `Overflow` | Numeric overflow in arithmetic calculation. |
| **30** | `InviteKeyTooLong` | Invite key string exceeds `MAX_INVITE_KEY_BYTES` (128 bytes). |
| **31** | `ZeroStake` | Stake amount of 0 was provided. Stakes must be >= `MIN_STAKE`. |
| **32** | `ClaimNotResolved` | Payout requested on a claim that has not been resolved. |
| **33** | `NotAChallenger` | Payout requested by an address that did not challenge this claim. |
| **34** | `AlreadyClaimedPayout` | Challenger has already pulled their payout for this claim. |
| **35** | `ChallengersDidNotWin` | Challenger requested payout, but oracle verdict was not `WinnerSide::Challengers`. |
| **36** | `UnsupportedDecimals` | Token decimals do not match `USDC_DECIMALS` (7). Mimir requires 7-decimal Stellar USDC. |
| **37** | `InvalidConfidence` | Oracle confidence score is invalid (must be 0..100). |
| **38** | `ClaimHasActiveClaims` | Cannot cancel claim because challengers have joined or liability is reserved; must settle. |
| **39** | `RefundNotEscrowed` | Contract escrow balance was insufficient to back cancellation refund. |
| **40** | `UnsupportedVerdictVersion` | Verdict encoded with an unknown version tag; contract fails closed to prevent data corruption. |
| **41** | `MetadataTooLong` | A single metadata field exceeded `MAX_METADATA_BYTES` (512 bytes). |
| **42** | `ClaimMetadataTooLong` | Combined metadata fields on the claim exceeded `MAX_CLAIM_METADATA_BYTES` (2,048 bytes). |
| **43** | `ParentClaimNotFound` | Rematch references a `parent_id` that does not exist on-chain. |
| **44** | `ParentClaimInvalidState` | Rematch parent claim is not in a valid terminal state. |
| **45** | `ParentClaimAlreadyRematched` | The parent claim has already spawned a rematch child claim. |
| **46** | `BatchTooLarge` | `get_claims_batch` called with more than `MAX_BATCH_SIZE` (50) IDs. |
| **47** | `ConservationViolation` | Escrow accounting invariant failed (e.g. negative escrow, liability above stake). Fails closed. |

---

### `mimir-squad` Error Codes (1–32)

Defined in [`contracts-soroban/mimir-squad/src/types.rs`](../contracts-soroban/mimir-squad/src/types.rs#L81-L131).

| Code | Name | Human Explanation & Troubleshooting |
|---|---|---|
| **1** | `AlreadyInitialized` | Squad contract already initialized. |
| **2** | `NotInitialized` | Squad contract not yet initialized. Deployer must call `initialize`. |
| **3** | `ZeroAddress` | An address argument was an invalid zero/empty address. |
| **4** | `EmptyQuestion` | Squad market question string was empty. |
| **5** | `BadDeadline` | Deadline duration is less than `MIN_DURATION` (600s = 10m) or exceeds `MAX_DURATION` (31,536,000s = 365d). |
| **6** | `FeeCapExceeded` | Fee basis points exceed `MAX_FEE_BPS` (1,000 bps = 10%). |
| **7** | `MarketNotFound` | Specified squad market ID does not exist. |
| **8** | `MarketClosed` | Squad market deadline has passed; deposits and joins are closed. |
| **9** | `BadSide` | Invalid side selected (must be `SIDE_A` = 1 or `SIDE_B` = 2). |
| **10** | `ZeroAmount` | Deposit amount was zero. Must deposit a positive amount. |
| **11** | `SideFull` | Side participant count reached `MAX_PARTICIPANTS_PER_SIDE` (200). |
| **12** | `Locked` | Action attempted while squad market state is locked. |
| **13** | `BadAmount` | Deposit or withdrawal amount is invalid or violates accounting rules. |
| **14** | `NotOracle` | Caller is not the authorized oracle address for resolving squad markets. |
| **15** | `NotResolvable` | Market cannot be resolved (deadline not reached or already resolved). |
| **16** | `BadResult` | Invalid resolution result. Must be `SIDE_A` (1), `SIDE_B` (2), or `RESULT_CANCELLED` (3). |
| **17** | `EmptyWinner` | The winning side had 0 total deposits; cannot distribute winnings to an empty side. |
| **18** | `NotClaimable` | Market is not in a claimable state. |
| **19** | `NotWinner` | Caller deposited on the losing side and is not entitled to winning payout. |
| **20** | `AlreadyClaimed` | Caller has already claimed payout from this squad market. |
| **21** | `NotFeeRecipient` | Caller is not the authorized fee recipient address. |
| **22** | `NoFees` | No accumulated fees available for collection. |
| **23** | `UnsupportedToken` | Token contract address is not the configured USDC contract. |
| **24** | `Overflow` | Numeric overflow in pool or share calculation. |
| **25** | `UnsupportedDecimals` | Token decimals do not match `USDC_DECIMALS` (7). |
| **26** | `ConservationViolation` | Pool or escrow accounting conservation invariant violated. |
| **27** | `QuestionTooLong` | Market question exceeded `MAX_QUESTION_BYTES` (512 bytes). |
| **28** | `SquadFull` | Combined participants across both sides reached `MAX_SQUAD_MEMBERS` (400). |
| **29** | `PayoutParked` | Token transfer trapped (e.g. frozen or missing trustline); funds parked safely for `claim_parked_payout`. |
| **30** | `AlreadyResolved` | Squad market was already resolved or cancelled. |
| **31** | `NothingQueued` | No pending oracle rotation queued to execute or cancel. |
| **32** | `Timelocked` | Timelock (`ORACLE_TIMELOCK_SECONDS` = 172,800s) has not yet elapsed for queued oracle rotation. |
