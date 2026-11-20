# Lifecycle Events Reference

This document describes the typed lifecycle events published by the Mimir contracts for market lifecycle tracking, accounting reconciliation, and operational monitoring.

## Overview

Both `mimir-market` and `mimir-squad` contracts emit comprehensive lifecycle events that capture state transitions, liquidity changes, and key operational milestones. These events provide:

- **Contract-first accounting**: Every state change, fund movement, and settlement is recorded on-chain
- **Clear market semantics**: Explicit state transitions with timestamps
- **Safe agent operations**: Observable triggers for oracle workers and indexers
- **Audit trail**: Complete history for reconciliation and incident response

## Claim Revision

Every market mutation event for a claim carries an explicit `revision` field (u32). The claim revision is a monotonically increasing counter that is incremented only after a successful state change to that claim. A rejected invocation (failed authorization, invalid lifecycle transition, insufficient escrow, etc.) leaves the revision and escrow unchanged.

**Guarantees:**
- A new claim starts at revision `0` at creation.
- Each successful mutation (challenge, resolution, cancellation, deadline transition) increments the revision by exactly `1`.
- Rejected or reverted invocations do not change the stored revision, state, or escrow.
- Indexers can use `revision` to detect gaps and order events for the same claim without relying on ledger sequence alone.

## mimir-market Events

### Core Lifecycle Events

#### ClaimStateTransitioned
Emitted on every claim state change. Tracks transitions between `Open`, `Active`, `Resolved`, and `Cancelled` states.

**Fields:**
- `id` (topic): Claim ID
- `from_state`: Previous state (u32 enum value)
- `to_state`: New state (u32 enum value)
- `timestamp`: Ledger timestamp when transition occurred
- `revision`: Claim revision after this successful transition

**State Values:**
- 0 = Open
- 1 = Active
- 2 = Resolved
- 3 = Cancelled

**Emitted by:**
- `challenge_claim`: Open → Active (on first challenge)
- `transition_deadline`: Open → Cancelled (for expired unchallenged claims)
- `cancel_claim`: Open → Cancelled (creator-initiated cancellation)
- `resolve_claim`: Active → Resolved (oracle settlement)

#### DeadlineReached
Emitted when a claim's deadline passes and it becomes eligible for resolution or cancellation.

**Fields:**
- `id` (topic): Claim ID
- `deadline`: The deadline timestamp that was reached
- `challenger_count`: Number of challengers at deadline
- `total_staked`: Total funds in escrow (creator + all challengers)
- `revision`: Claim revision after the deadline transition

**Emitted by:**
- `transition_deadline`: For unchallenged claims entering cancellation
- `resolve_claim`: For active claims entering settlement window

**Usage:** Indexers and oracle workers use this event to identify claims ready for settlement without polling every claim.

#### EscrowSeeded
Emitted when initial escrow is established or topped up for a claim.

**Fields:**
- `id` (topic): Claim ID
- `funder` (topic): Address providing the escrow
- `amount`: USDC amount in atomic units (7 decimals)
- `escrow_type`: String indicating escrow purpose
- `revision`: Claim revision after the escrow change

**Escrow Types:**
- `"creator_stake"`: Creator's initial stake at claim creation
- `"challenger_stake"`: Challenger's stake when joining the market

**Emitted by:**
- `create_claim`: When creator funds the initial stake
- `challenge_claim`: When each challenger adds their stake

**Usage:** Accounting reconciliation can verify that contract escrow balance equals the sum of all `EscrowSeeded` events minus payouts and refunds.

#### LiquidityUpdated
Emitted on fixed-odds liquidity state changes beyond initial reservations.

**Fields:**
- `id` (topic): Claim ID
- `reserved_liability`: Total creator liability reserved for all challengers
- `available_liquidity`: Creator stake remaining after reservations
- `total_creator_stake`: Original creator stake amount
- `revision`: Claim revision after the liquidity change

**Emitted by:**
- Future extensions for dynamic liquidity management
- Currently reserved for fixed-odds markets that modify liquidity post-creation

**Usage:** Risk management and UI display of available liquidity in fixed-odds markets.

### Existing Events Enhanced

The following existing events work together with lifecycle events:

- **ClaimCreated**: Initial claim setup (revision `0`), now paired with `EscrowSeeded`
- **ClaimChallenged**: Challenge acceptance, now paired with `EscrowSeeded` and `ClaimStateTransitioned`
- **ClaimResolved**: Settlement result, now paired with `ClaimStateTransitioned` and `DeadlineReached`
- **ClaimCancelled**: Cancellation completed, now paired with `ClaimStateTransitioned`

## mimir-squad Events

### Pool Lifecycle Events

#### MarketStateTransitioned
Emitted on every pool market state change. Tracks transitions between active and resolved states.

**Fields:**
- `market_id` (topic): Market ID
- `from_state`: Previous state (0 = Active, 2 = Resolved)
- `to_state`: New state (0 = Active, 2 = Resolved)
- `timestamp`: Ledger timestamp when transition occurred

**Emitted by:**
- `transition_deadline`: Active → Resolved (for one-sided markets)
- `resolve`: Active → Resolved (oracle settlement)

#### MarketDeadlineReached
Emitted when a pool market's deadline passes and it becomes eligible for resolution.

**Fields:**
- `market_id` (topic): Market ID
- `deadline`: The deadline timestamp that was reached
- `pool_a_total`: Side A pool total in atomic USDC
- `pool_b_total`: Side B pool total in atomic USDC

**Emitted by:**
- `transition_deadline`: For one-sided markets entering cancellation
- `resolve`: For normal markets entering settlement

**Usage:** Oracle workers identify markets ready for resolution. Indexers use pool totals for analytics without reading contract state.

#### LiquidityAdded
Emitted when liquidity is deposited into a pool market.

**Fields:**
- `market_id` (topic): Market ID
- `side` (topic): Side receiving liquidity (1 = A, 2 = B)
- `amount`: USDC amount added
- `new_pool_total`: Pool total after this deposit
- `shares_issued`: Shares issued to depositor (equals amount in squad v1)

**Emitted by:**
- `deposit`: Every liquidity addition to either side

**Usage:** Track pool depth over time, calculate TVL, monitor liquidity provision patterns.

#### LiquidityRemoved
Emitted when liquidity is withdrawn from a pool market before resolution.

**Fields:**
- `market_id` (topic): Market ID
- `side` (topic): Side losing liquidity (1 = A, 2 = B)
- `amount`: USDC amount withdrawn
- `new_pool_total`: Pool total after this withdrawal
- `shares_burned`: Shares burned from withdrawer (equals amount in squad v1)

**Emitted by:**
- `withdraw_before_deadline`: Pre-deadline withdrawals only

**Usage:** Distinguish between pre-deadline liquidity exits (this event) and post-resolution claims (which use the `Claimed` event).

#### MarketCancelled
Emitted when the captain cancels a market before its deadline.

**Fields:**
- `market_id` (topic): Market ID
- `captain` (topic): Captain who cancelled
- `pool_a`: Side A pool at cancellation (kept for the audit trail)
- `pool_b`: Side B pool at cancellation

**Emitted by:**
- `cancel_market`: only before the deadline; seeds `remaining_escrow = pool_a + pool_b` so every depositor can pull a full refund through `claim`

#### PayoutParked
Emitted when a payout cannot be delivered (frozen or deauthorized trustline) and is parked for a later `claim_parked_payout`.

**Fields:**
- `market_id` (topic): Market ID
- `side` (topic): Side claimed
- `participant` (topic): Winner whose payout was parked
- `amount`: Net amount parked

#### SquadFull
Emitted on the deposit that fills the squad to `MAX_SQUAD_MEMBERS`.

**Fields:**
- `market_id` (topic): Market ID
- `total_members`: Members across both sides

#### OracleQueued / OracleCancelled / OracleChanged
Oracle rotation timelock: `queue_oracle` (topic `next`, `executable_at`), `cancel_oracle` (`cancelled`), `execute_oracle` (topic `next`, `previous`).

### Fee Recipient Rotation Events

The squad `fee_recipient` can be rotated without redeploying, using the same timelock pattern as oracle rotation. Only the current fee recipient may queue or cancel a rotation, and the change cannot execute before the timelock elapses.

##### FeeRecipientQueued
Emitted when the current fee recipient queues a rotation to a new recipient.

**Fields:**
- `next` (topic): The proposed new fee recipient
- `executable_at`: Ledger timestamp before which the rotation cannot execute

**Emitted by:**
- `queue_fee_recipient`: authorised only by the current fee recipient

**Usage:** Indexers and operators use this event to surface pending rotations and to schedule execution after the timelock.

##### FeeRecipientCancelled
Emitted when the current fee recipient cancels a pending rotation.

**Fields:**
- `cancelled`: The previously queued recipient address that was cancelled

**Emitted by:**
- `cancel_fee_recipient`: authorised only by the current fee recipient

**Usage:** Confirms that no rotation is pending after cancellation.

##### FeeRecipientChanged
Emitted when a queued rotation is executed after the timelock.

**Fields:**
- `next` (topic): The new fee recipient
- `previous`: The previous fee recipient

**Emitted by:**
- `execute_fee_recipient`: authorised only by the current fee recipient, and only after the timelock has elapsed

**Accounting note:** Accrued but unclaimed fees at execution time go to the new recipient. The rotation changes the destination of `fee_recipient_accrued` at execution; future `claim_fees` calls pay the new recipient.

**Usage:** Indexers use this event to update the active fee recipient and to reconcile fee claims against the correct recipient.

### Existing Events Enhanced

The following existing events work with lifecycle events:

- **MarketCreated**: Initial market setup
- **Deposited**: Now paired with `LiquidityAdded`
- **Withdrawn**: Now paired with `LiquidityRemoved`
- **Resolved**: Now paired with `MarketStateTransitioned` and `MarketDeadlineReached`

## Squad Market Lifecycle State Machine

For the full state diagram, the caller/authority matrix, and the refund rules for squad markets, see [`SQUAD_LIFECYCLE.md`](./SQUAD_LIFECYCLE.md). That document covers how `cancel_market`, `transition_deadline`, and `resolve` with `RESULT_CANCELLED` interact, and how `claim` treats `RESULT_CANCELLED` as a principal refund.

## Integration Guidelines

### For Indexers

1. **State Tracking**: Use `ClaimStateTransitioned` and `MarketStateTransitioned` as the source of truth for lifecycle state
2. **Revision Ordering**: Use the claim `revision` field to order and deduplicate mutation events for the same claim
3. **Conservation Checks**: Sum `EscrowSeeded` amounts and verify against payouts and remaining escrow
4. **Deadline Monitoring**: Listen to `DeadlineReached` and `MarketDeadlineReached` to identify claims needing oracle attention
5. **Pool Analytics**: Track `LiquidityAdded` and `LiquidityRemoved` for TVL, liquidity depth charts, and participation patterns
6. **Fee Recipient Rotation**: Track `FeeRecipientQueued`, `FeeRecipientCancelled`, and `FeeRecipientChanged` to know which address is entitled to accrued fees

### For Oracle Workers

1. **Settlement Queue**: Subscribe to `DeadlineReached` and `MarketDeadlineReached` events instead of polling all claims
2. **State Validation**: Check `ClaimStateTransitioned` to confirm a claim reached `Active` before attempting resolution
3. **Accounting Verification**: Cross-reference `EscrowSeeded` events with expected escrow balance before settlement

### For Frontend / UI

1. **Real-time Updates**: Subscribe to lifecycle events to update UI state without refetching entire claim data
2. **Liquidity Display**: Use `LiquidityAdded` / `LiquidityRemoved` for live pool depth indicators
3. **Status Badges**: Map `ClaimStateTransitioned` to user-facing status labels
4. **Fee Recipient Rotation**: Surface the pending recipient and `executable_at` from `FeeRecipientQueued`, and confirm the active recipient from `FeeRecipientChanged`

### For Analytics

1. **Market Health**: Track state transition timing to measure average time-to-challenge, time-to-settlement
2. **Liquidity Patterns**: Analyze `LiquidityAdded` / `LiquidityRemoved` timing relative to deadlines
3. **Escrow Flows**: Build cash flow statements from `EscrowSeeded`, `Claimed`, `Withdrawn`, and `ChallengerPaid` events
4. **Fee Recipient History**: Use `FeeRecipientChanged` to attribute fee claims to the correct recipient over time

## Event Ordering Guarantees

Within a single transaction:

1. **Create**: `EscrowSeeded` → `ClaimCreated` → `FeePolicySnapshotted`
2. **Challenge**: `EscrowSeeded` → `ClaimStateTransitioned` (if Open → Active) → `FixedOddsLiquidityReserved` (if applicable) → `ClaimChallenged`
3. **Resolve**: `DeadlineReached` → `ClaimStateTransitioned` (Active → Resolved) → `MarketSettled` → `ClaimResolved` → `VerdictEncoded`
4. Across transactions, events for the same claim are totally ordered by `revision`; a rejected invocation emits no mutation event and does not advance `revision`.
