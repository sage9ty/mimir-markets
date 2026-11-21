# Economic invariant evidence

This is repository evidence, not an independent audit. Every claim below is
backed by a test in this repo; the cross-references name the file so a reader can
check rather than trust.

Amounts throughout are atomic USDC at **7 decimals**, the decimals the Circle
Testnet USDC Stellar Asset Contract actually reports (see `lib/usdc.ts`, which
verified it by invoking `decimals()` on the live SAC). `MIN_STAKE` is therefore
`2_0000000`.

Both contracts enforce that scale on chain rather than assuming it: `initialize`
reads `decimals()` off the token and rejects anything but `USDC_DECIMALS` (7) with
`UnsupportedDecimals`, and a token that cannot answer `decimals()` with
`UnsupportedToken`. A rejected call writes nothing. `MIN_STAKE` is derived as
`2 * USDC_UNIT`, so it cannot be read at a scale it was not written for (against a
6-decimal token it would have meant 20 USDC). Tests: `src/test_decimals.rs` in each
crate. They also settle every verdict with the escrow at exactly `i64::MAX`
stroops (the most a classic Stellar account can hold), with no `Overflow` and exact
conservation to the stroop.

## mimir-market fees

Source: `contracts-soroban/mimir-market/src/fees.rs`, mirrored off-chain in
`lib/fees.ts`. Tests: `src/test_fees.rs`, `src/test_settlement.rs`,
`tests/node/fees.test.ts`.

- Fees are charged on **profit only** (`gross - principal`, floored at zero), so a
  winner never receives less than their principal. Integer division truncates,
  which rounds fees down in the participant's favour.
- A fee with no recipient is not charged, so a malformed snapshot cannot mint an
  unclaimable balance.
- Claim creation snapshots platform/agent-owner bps and both recipients onto the
  claim (`FeeSnapshot`); a later policy change cannot rewrite the economics of an
  open market. Tested both ways: `a_later_policy_change_cannot_reach_an_existing_claim`
  and `a_new_claim_picks_up_the_new_policy`.
- `platform_fee_bps + agent_owner_fee_bps` can never exceed `MAX_TOTAL_FEE_BPS`
  (1,000 bps = 10%). No function can raise that constant, so no admin action and
  no compromised key can take more than 10% of profit. Checked on `initialize` and
  on every queued change, including via the queue/execute path.
- A queued policy waits `FEE_TIMELOCK_SECONDS` (2 days) before it can execute, and
  execution is *permissionless* once elapsed — the owner can queue and cancel but
  cannot execute early.
- Fees are **pulled, not pushed**: they accrue per recipient and are collected with
  `claim_fees`. Tested once-only (`fees_are_pulled_not_pushed_and_only_once`) and
  for an unrelated address having nothing to claim.
- Lifetime accrued and claimed totals (`get_platform_stats`) support reconciliation
  against the off-chain atomic ledger.
- Exact-balance intake (`escrow::pull`) rejects fee-on-transfer and rebasing
  behaviour: the contract asserts escrow moved by exactly the requested amount and
  errors with `UnsupportedToken` otherwise.

### Principal-safe payout preview

The stake form shows what the contract will pay, not the pre-fee pool formula.
`previewChallengerPayoutSafe` (`lib/payout.ts`) takes the gross from
`challengerPayoutUnits`, splits it with the claim's own `getClaimFees` snapshot in
`principalSafePayout`, and returns `netPayout`. Tests:
`tests/node/payout-preview.test.ts`.

- Fees are charged on profit only, so `netPayout >= principal` in every market.
  The clamp inside `principalSafePayout` is the backstop for a snapshot that was
  never valid; `isPrincipalSafe` is the shared assertion the UI and tests use.
- A snapshot the contract could not have written (negative, non-integer, or above
  `MAX_TOTAL_FEE_BPS` when the two legs are summed) is classified `invalid` and NOT
  applied. Any unread snapshot (`loading` / `unavailable` / `invalid`) previews the
  gross and the UI labels it — an unknown fee can only make the real payout lower,
  so the gross is a ceiling, never a promise.
- The preview is address-independent: `fees.rs::quote_fees` charges an agent-owner
  leg whenever the claim has a recipient and does not waive it by earner (that
  waiver belongs to the off-chain `splitAttributedFees`, not to settlement). A
  disconnected viewer therefore sees the same net as the challenger; connection
  only gates the stake action.

Rollout: no contract change and no data migration. The snapshot is immutable per
claim, so the read cannot go stale while a page is open — it happens once per
claim id, and a failed read degrades to the labelled gross. Analytics keeps its
established gross meaning for `total_return_multiple` and gains a `fee_adjusted`
marker, so the fee-adjusted and fee-unknown cases stay distinguishable without
renaming an event or an envelope field.

### Settlement conservation

`conservation_holds_across_every_verdict` asserts, for every `WinnerSide`, that
payouts + fees + dust equals escrow inflow. Alongside it:

- `winner_never_receives_less_than_principal_in_a_crowded_pool`
- `challengers_win_pool_mode_is_pro_rata_and_conserved`
- `pool_mode_truncation_dust_is_absorbed_by_the_last_claimant`
- `fixed_odds_challenger_win_refunds_unspent_liability_without_fee`
- `fixed_odds_with_several_challengers_conserves_exactly`
- `draw_refunds_everyone_in_full_with_no_fee` and the `Unresolvable` equivalent
- `a_quote_matches_what_the_pull_actually_pays`

### Settlement dust is deterministic and isolated

The pool-share formula truncates, so a few atomic units can be left over. The
remainder is a function of the claim's pools alone, so it does not depend on the
order challengers pull in, and the final puller receives their formula share plus
exactly that dust — the escrow empties to zero instead of stranding units.
`src/test_dust_isolation.rs` pins it: the final challenger's gross is
`formula + dust`, the dust amount is identical under either pull order, an exactly
dividing pool leaves no dust, `paid + fees + remaining_escrow` equals the inflow
after every pull, a quote equals the payout it precedes, and an abandoned final
share keeps the dust in escrow rather than overpaying.

### Fixed-odds liquidity is a claim-level accounting invariant

A fixed-odds challenge reserves only the challenger's **profit**, because the
challenger's principal is already held in escrow and is returned on every
outcome. The contract computes the same integer profit as `gross_payout` at
challenge time, rejects a challenge when it exceeds the creator's unreserved
stake, and stores the cumulative reservation on the claim. A failed check runs
before the token pull and leaves claim state, escrow, and participant balances
unchanged. Exact-capacity and exhausted-capacity cases are covered by
`fixed_odds_rejects_challenge_creator_cannot_cover`; corrupt reservations fail
closed via `fixed_odds_rejects_corrupt_reserved_liability_without_underflowing`.

At resolution, the reserved profit is paid to winning challengers, while the
creator receives the unreserved remainder. The `FixedOddsLiquidityReserved`
event records the post-challenge reservation and remaining liquidity, making the
limit auditable from ledger events without trusting a read-index. The
`checked_*` arithmetic used for inflow, committed payout, and claim counters
also prevents malformed persisted state from wrapping into an apparently valid
settlement.

The off-chain mirror exports `conservationHolds` and `noWinnerLosesPrincipal` from
`lib/fees.ts` and asserts them over the same shapes.

### Pull settlement is a solvency property, not a convenience

`resolve_claim` does not loop over challengers, because a Stellar transaction is
capped on its ledger-entry footprint and a market filled to `MAX_CHALLENGERS`
(100) does not fit. Resolution instead seeds `remaining_escrow`, and each
`claim_challenger_payout` draws it down — so the contract cannot pay out more than
it took in, regardless of ordering. `challenger_claims` counts the pulls so the
last claimant absorbs the truncation dust. Tested: a challenger can only pull
once, a non-challenger cannot pull, pulling before resolution is rejected, pulling
requires the challenger's own signature, and an abandoned share simply stays in
escrow.

A payout the contract cannot deliver — a frozen or authorisation-revoked USDC
trustline makes the Stellar Asset Contract transfer fail — is parked as a
withdrawable balance rather than failing the whole settlement
(`escrow::push_or_park`, tested by `a_blocked_challenger_has_their_payout_parked`).

### Partial settlements, refunds, fees and incomplete history

The off-chain portfolio statement is derived from indexed events and is checked
against totals computed independently of the production reducer. Fixtures in
`tests/node/portfolio-statement-comparison.fixtures.ts` are synthetic and
deterministic: they cover partial settlements (a claim settled in several pulls
with a remainder), refunds (cancelled claims and parked refunds), fees (profit-only
fee snapshots with and without a recipient), and incomplete history (events that
are missing or arrive out of order, which must be reported rather than silently
totalled). The expected totals are summed directly from the fixture events with
integer atomic-USDC arithmetic and compared against the reducer output in
`lib/portfolio-performance.ts`. A boundary case with a missing settlement event
asserts the statement is flagged incomplete instead of reporting a partial total
as final.

### Cancellation is guarded against active claims

`cancel_claim` is the one lifecycle transition where the creator — not the oracle —
moves money out of escrow, so its state check is backed by the claim's own
accounting. A cancellation of an Open claim is refused with `ClaimHasActiveClaims`
unless `challenger_count`, `total_challenger_stake` and
`reserved_creator_liability` are all zero: any counterparty funding means the
claim belongs to settlement, and a refund would strand those funds behind a
terminal `Cancelled` state. This guards not only the normal Active state but the
inconsistent ones a stale read-index, a lost worker update or an out-of-order
transaction can present, and the contract re-derives the claim at execution time
so a cancel prepared against a stale Open read cannot fire after a challenge has
landed. A second guard (`RefundNotEscrowed`) refuses the refund when shared escrow
cannot cover it at the moment of the call, so a cancellation can never pay the
creator out of other claims' funds; both refusals emit `CancellationRefused` with
the claim's accounting and change nothing. The refund itself stays fee-free,
succeeds even when the creator's wallet cannot receive (parked for later pull,
reported in the `ClaimCancelled` event's `parked` flag), and only ever removes
that claim's own stake from escrow. Tested:
`a_claim_with_funded_challengers_cannot_be_cancelled_even_if_open`,
`a_single_atomic_unit_of_exposure_blocks_cancellation`,
`cancellation_conserves_the_shared_escrow`,
`a_cancellation_refund_is_parked_when_the_creator_cannot_receive`,
`a_cancel_that_executes_after_a_challenge_is_refused`,
`cancellation_error_codes_are_stable` (all in `src/test_lifecycle.rs`).

## mimir-squad

Source: `contracts-soroban/mimir-squad/src/pool.rs`. Tests: `src/test_lifecycle.rs`,
`src/test_payouts.rs`, `tests/node/squad-pool.test.ts`.

- Both sides deposit into one escrow and exact USDC balance deltas are required.
- Before the deadline, participants can withdraw their own side balance; after
  resolution, winners claim pro rata.
- Sum of winner payouts, profit-only fee and deterministic final-winner dust equals
  the escrowed pot (`conservation_holds_over_awkward_stake_distributions`, which
  sweeps every result × three fee levels × deliberately awkward stake sets).
- Participants per side are capped at `MAX_PARTICIPANTS_PER_SIDE` (200), fee bps at
  `MAX_FEE_BPS` (1,000 = 10%), and market duration between `MIN_DURATION` (10
  minutes) and `MAX_DURATION` (365 days).
- Payouts are pull-based for the same footprint reason as the market contract:
  `remaining_escrow` is drawn down by each claim, and the last winner absorbs the
  dust. Claiming twice, claiming from the losing side, claiming with no position and
  claiming without the participant's signature are each rejected.
- A cancelled market refunds every principal in full, including both sides of a
  double-sided depositor. A break-even winner pays no fee.
- `preview_matches_the_amount_actually_paid` ties the quoting view to the pull.
  `claim` and `preview_claim` share one `winner_gross`, so the preview cannot
  round the final winner's dust differently from the payout; a position that has
  already pulled previews as zero, matching `claim`'s no-op, rather than promising
  a second payout.
- `src/test_dust_isolation.rs` isolates the same dust property for the squad pool:
  the final winner's gross is `formula + dust`, the dust is identical under either
  claim order, an exactly dividing pool leaves none
