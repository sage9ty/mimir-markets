# Mimir Squad Storage Layout and TTL Policy

## Overview

This document describes where squad pool state lives in the Soroban ledger for `mimir-squad` (`contracts-soroban/mimir-squad/src/storage.rs`), how long it persists, the TTL (Time-To-Live) bumping policies across storage classes, and operational risks concerning state archival for unclaimed deposits and parked payouts.

### Claim Status Reporting

Claim-related views return explicit states rather than overloading zero:

- **Claimable**: the participant has a non-zero deposit on the winning side of a resolved market and has not yet claimed.
- **AlreadyClaimed**: the participant's `Claimed` flag is set; the amount paid out is reported separately from any claimable amount.
- **NoPosition**: the wallet has no deposit on the market. This is a read-only path that never errors, so wallets with no position can be queried safely.
- **Parked**: a payout was diverted to `DataKey::Payout` and awaits `claim_parked_payout`.

All views are read-only and do not modify storage or extend TTL.

---

## Storage Architecture and Classes

Soroban provides two relevant storage classes used by `mimir-squad`:

1. **Instance Storage (`env.storage().instance()`)**:
   - Tied directly to the contract instance.
   - All instance entries share the contract instance's lifetime and TTL. When the contract instance TTL is extended, all instance keys are extended together.
   - Used in `mimir-squad` for singleton protocol configuration, global counters, and administrative state.

2. **Persistent Storage (`env.storage().persistent()`)**:
   - Independent storage entries with individual lifetimes, keys, and TTL counters.
   - Entries that are not accessed or explicitly bumped will eventually expire and enter an archived state, requiring a restoration transaction before they can be read or written again.
   - Used in `mimir-squad` for per-market state, participant deposits, claim flags, and parked payouts.

### TTL Configuration Constants

Defined in `contracts-soroban/mimir-squad/src/storage.rs`:

```rust
const BUMP_THRESHOLD: u32 = 120_960; // ~7 days at 5s per Stellar ledger
const BUMP_EXTEND: u32 = 518_400;    // ~30 days at 5s per Stellar ledger
```

When `extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND)` is called on a persistent entry:
- If the remaining TTL is less than `BUMP_THRESHOLD` (120,960 ledgers), Soroban extends the entry's TTL to `BUMP_EXTEND` (518,400 ledgers from the current ledger).
- If the remaining TTL is already above `BUMP_THRESHOLD`, the call is a no-op.

---

## Complete Storage Key Inventory

Every storage key is represented by the `DataKey` enum (`contracts-soroban/mimir-squad/src/storage.rs:9-26`).

| Key Variant | Storage Class | Value Type | TTL Extended? | Touching Functions & Entry Points |
| :--- | :--- | :--- | :--- | :--- |
| `DataKey::Init` | Instance | `bool` | With instance | `is_initialized` (storage.rs:33), `mark_initialized` (storage.rs:37), `initialize` (contract.rs:17), `is_initialized` view (contract.rs:136) |
| `DataKey::Usdc` | Instance | `Address` | With instance | `set_config` (storage.rs:60), `usdc` (storage.rs:48), `initialize` (contract.rs:17), `get_usdc` view (contract.rs:132), `escrow::*` (escrow.rs) |
| `DataKey::Oracle` | Instance | `Address` | With instance | `set_config` (storage.rs:60), `set_oracle` (storage.rs:68), `oracle` (storage.rs:52), `initialize` (contract.rs:17), `execute_oracle` (contract.rs:151), `get_oracle` view (contract.rs:136) |
| `DataKey::FeeRecipient` | Instance | `Address` | With instance | `set_config` (storage.rs:60), `fee_recipient` (storage.rs:56), `initialize` (contract.rs:17), `claim_fees` (contract.rs:79), `get_fee_recipient` view (contract.rs:159) |
| `DataKey::PendingOracle` | Instance | `PendingOracle` | With instance | `pending_oracle` (storage.rs:72), `set_pending_oracle` (storage.rs:76), `clear_pending_oracle` (storage.rs:80), `queue_oracle` (contract.rs:141), `cancel_oracle` (contract.rs:146), `execute_oracle` (contract.rs:151), `get_pending_oracle` view (contract.rs:155) |
| `DataKey::MarketCount` | Instance | `u64` | With instance | `market_count` (storage.rs:86), `set_market_count` (storage.rs:93), `create_market` (contract.rs:26), `get_market_count` view (contract.rs:118) |
| `DataKey::AccruedFees` | Instance | `i128` | With instance | `accrued_fees` (storage.rs:97), `set_accrued_fees` (storage.rs:104), `claim` (contract.rs:75, pool.rs:247), `claim_fees` (contract.rs:79, pool.rs:296), `get_accrued_fees` view (contract.rs:122) |
| `DataKey::Market(u64)` | Persistent | `Market` | **Yes (Read & Write)** | `get_market` (storage.rs:110), `set_market` (storage.rs:123), `create_market`, `deposit`, `withdraw_before_deadline`, `resolve`, `cancel_market`, `claim`, `get_market`, `preview_claim` |
| `DataKey::Deposit(u64, u32, Address)` | Persistent | `i128` | **Write only (`set_deposit`)**; **NEVER on read** | `deposit_of` (storage.rs:133), `set_deposit` (storage.rs:140), `deposit` (pool.rs:22), `withdraw_before_deadline` (pool.rs:72), `claim` (pool.rs:160), `preview_claim` (pool.rs:312), `get_deposit` view (contract.rs:101) |
| `DataKey::Claimed(u64, u32, Address)` | Persistent | `bool` | **Write only (`mark_claimed`)**; **NEVER on read** | `has_claimed` (storage.rs:152), `mark_claimed` (storage.rs:158), `claim` (pool.rs:160), `has_claimed` view (contract.rs:105). Distinct from claimable amount: a `true` flag yields the `AlreadyClaimed` state, while a missing deposit yields `NoPosition`. |
| `DataKey::Payout(u64, u32, Address)` | Persistent | `i128` | **Write only (`set_payout`)**; **NEVER on read** | `payout_of` (storage.rs:170), `set_payout` (storage.rs:177), `claim` (pool.rs:232), `claim_parked_payout` (contract.rs:86, pool.rs:254), `parked_payout` view (contract.rs:128) |

---

## Detailed Key Specifications

### 1. Protocol Configuration (Instance)

- **`DataKey::Init`**: Set to `true` during `initialize`. Protects against re-initialization (`Error::AlreadyInitialized`).
- **`DataKey::Usdc`**: Address of the accepted USDC token contract. Immutable after initialization.
- **`DataKey::Oracle`**: Authorized resolution oracle. Can be rotated via a 2-day timelocked procedure (`queue_oracle` -> `execute_oracle`).
- **`DataKey::FeeRecipient`**: Treasury address eligible to pull accrued protocol fees via `claim_fees`. Set once at initialization.
- **`DataKey::PendingOracle`**: Holds `Option<PendingOracle>` (`{ next: Address, executable_at: u64 }`). Exists only while an oracle rotation is queued; cleared on cancellation or execution.

### 2. Accounting and Counters (Instance)

- **`DataKey::MarketCount`**: Total squad markets created to date. Incremented sequentially starting from 1 in `create_market`.
- **`DataKey::AccruedFees`**: Aggregate protocol fees (in atomic USDC units) deducted from profitable payouts. Increased on `claim` when net profit exists; zeroed out when `fee_recipient` calls `claim_fees`.

### 3. Squad Markets (Persistent)

- **`DataKey::Market(u64)`**:
  - Value: `Market` struct:
    ```rust
    pub struct Market {
        pub captain: Address,
        pub deadline: u64,
        pub fee_bps: u32,
        pub result: u32,            // 0 (open), SIDE_A, SIDE_B, or RESULT_CANCELLED
        pub resolved: bool,
        pub pool_a: i128,
        pub pool_b: i128,
        pub remaining_escrow: i128,
        pub participants_a: u32,
        pub participants_b: u32,
        pub winner_claims: u32,
    }
    ```
  - TTL Policy:
    - Extended on every read via `storage::get_market` (`storage.rs:117-120`).
    - Extended on every write via `storage::set_market` (`storage.rs:126-129`).
  - Active lifecycle operations (`deposit`, `withdraw`, `resolve`, `cancel_market`, `claim`) and passive queries (`get_market`, `preview_claim`) all invoke `storage::get_market`, ensuring active markets stay warm.

### 4. Participant Deposits (Persistent)

- **`DataKey::Deposit(market_id, side, participant)`**:
  - Value: `i128` (atomic USDC units deposited, representing 1:1 squad shares).
  - Writing: `storage::set_deposit` (`storage.rs:140-150`):
    - When `value > 0`: writes to storage and extends TTL (`storage.rs:147-149`).
    - When `value == 0`: removes entry from storage (`storage.rs:142-144`) to release ledger footprint.
  - Reading: `storage::deposit_of` (`storage.rs:133-138`):
    - Calls `env.storage().persistent().get(...)`.
    - **CRITICAL**: Does **not** extend TTL on read!

### 5. Claimed Flags (Persistent)

- **`DataKey::Claimed(market_id, side, participant)`**:
  - Value: `bool` (`true`).
  - Writing: `storage::mark_claimed` (`storage.rs:158-164`) sets `true` and extends TTL.
  - Reading: `storage::has_claimed` (`storage.rs:152-156`) checks presence via `.has()`; does **not** extend TTL.

### 6. Parked Payouts (Persistent)

- **`DataKey::Payout(market_id, side, participant)`**:
  - Value: `i128` (USDC atomic units owed to a winner whose transfer trapped due to a frozen/deauthorized trustline).
  - Writing: `storage::set_payout` (`storage.rs:177-187`):
    - When `value > 0`: sets value and extends TTL.
    - When `value == 0`: removes entry from persistent storage.
  - Reading: `storage::payout_of` (`storage.rs:170-175`):
    - Calls `env.storage().persistent().get(...)`.
    - Does **not** extend TTL on read.

---

## Archival Risks and Code References

### Risk 1: Unclaimed Deposits Archived After 30 Days (Critical)

- **Location**: `contracts-soroban/mimir-squad/src/storage.rs:133-138` (`deposit_of`), `contracts-soroban/mimir-squad/src/pool.rs:160-252` (`claim`).
- **Description**:
  When a user deposits into a market, `set_deposit` extends the `Deposit(id, side, who)` TTL to `BUMP_EXTEND` (518,400 ledgers ~ 30 days). If the market has a long duration, or if resolution takes time, or if the winning participant does not immediately claim their payout, the entry's TTL continuously decrements.
  
  Neither `get_deposit` (contract.rs:101), `preview_claim` (contract.rs:109, pool.rs:312), nor `deposit_of` called during `claim` (pool.rs:184) calls `extend_ttl`.
- **Failure Mode**:
  If 30 days pass without another deposit or partial withdrawal by that specific participant:
  1. The `Deposit(id, side, who)` key expires and is archived by Soroban.
  2. When the user later calls `claim`, `storage::deposit_of` executes:
     ```rust
     // storage.rs:133-138
     pub fn deposit_of(env: &Env, id: u64, side: u32, who: &Address) -> i128 {
         env.storage()
             .persistent()
             .get(&DataKey::Deposit(id, side, who.clone()))
             .unwrap_or(0)
     }
     ```
  3. Soroban returns `None` for archived entries, falling back to `0`.
  4. In `pool::claim` (`pool.rs:187-189`):
     ```rust
     let user_deposit = storage::deposit_of(env, market_id, side, &participant);
     if user_deposit == 0 {
         return Err(Error::NotWinner);
     }
     ```
  5. The claim aborts with `Error::NotWinner`, locking the user out of their principal and winnings. The remaining escrow in `Market` is permanently stranded unless the entry is manually restored via an explicit Soroban ledger restoration transaction.
- **Comparison with `mimir-market`**:
  In `mimir-market/src/storage.rs:196-207`, `get_claim_opt` proactively calls `extend_ttl` on every read:
  ```rust
  // mimir-market storage.rs:196-206
  pub fn get_claim_opt(env: &Env, id: u64) -> Option<Claim> {
      let key = DataKey::Claim(id);
      match env.storage().persistent().get::<_, Claim>(&key) {
          Some(claim) => {
              env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
              Some(claim)
          }
          None => None,
      }
  }
  ```
  `mimir-squad`'s `deposit_of` lacks this read-bump pattern.

### Risk 2: Parked Payouts Archived When Unfreeze Exceeds 30 Days (High)

- **Location**: `contracts-soroban/mimir-squad/src/storage.rs:170-175` (`payout_of`), `contracts-soroban/mimir-squad/src/pool.rs:254-284` (`claim_parked_payout`).
- **Description**:
  When a winner's USDC trustline is deauthorized or frozen by Circle, `pool::claim` traps on token transfer and safely diverts the payout to `DataKey::Payout(id, side, who)` via `set_payout` (`pool.rs:232`, `storage.rs:183`). `set_payout` sets the initial TTL to 30 days.
  
  If compliance unfreezing, wallet migration, or account recovery takes longer than 30 days, and the user has not retried `claim_parked_payout`:
  1. The `Payout` key is archived.
  2. Queries via `parked_payout` view (`contract.rs:128`) call `storage::payout_of`, which does not extend TTL.
  3. Once archived, `storage::payout_of` returns `0` (`storage.rs:174`).
  4. Subsequent calls to `claim_parked_payout` (`pool.rs:254`) read `amount = 0`, emit no transfer, and return `0`, effectively leaving the parked USDC stuck in the squad contract until a ledger restoration is performed.

### Risk 3: Claimed Marker Eviction and Re-Entrancy Exposure (Medium)

- **Location**: `contracts-soroban/mimir-squad/src/storage.rs:152-156` (`has_claimed`).
- **Description**:
  `mark_claimed` bumps TTL on write (`storage.rs:163`). However, once set, if an archived market has its deposit restored years later, but its `Claimed` key expired without being extended, `has_claimed` would return `false`. While the market-level `winner_claims` counter prevents infinite total claims across the pool, per-user idempotent tracking could be desynchronized if keys are archived and restored unevenly.

---

## Operator Recommendations

1. **Keeper / Indexer Bumping Routine**:
   Operators running backend sync agents (such as `agents/sync`) should monitor persistent entries for squad markets with unresolved or unclaimed balances approaching `BUMP_THRESHOLD` (120,960 ledgers) and trigger state bump transactions before archival occurs.

2. **State Restoration Runbook**:
   If a user reports `Error::NotWinner` despite having an on-chain deposit event, operators must verify if `DataKey::Deposit(market_id, side, participant)` was archived on Soroban and submit an RPC `restoreFootprint` transaction before instructing the user to retry claiming.

3. **Future Code Mitigation (Recommended for V1 Upgrade)**:
   Update `storage::deposit_of` and `storage::payout_of` to mirror `storage::get_market`:
   ```rust
   pub fn deposit_of(env: &Env, id: u64, side: u32, who: &Address) -> i128 {
       let key = DataKey::Deposit(id, side, who.clone());
       match env.storage().persistent().get::<_, i128>(&key) {
           Some(val) => {
               env.storage().persistent().extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
               val
           }
           None => 0,
       }
   }
   ```
