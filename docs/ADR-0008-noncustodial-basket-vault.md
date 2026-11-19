# ADR-0008: Non-custodial basket vault boundary

Status: accepted design; funded deposits remain disabled pending independent audit and legal/eligibility review.

## Decision

The first product is a read-only virtual basket. Idle capital is always represented as USDC atomic integers at the Stellar Asset Contract's 7 decimals (see `lib/usdc.ts`); there is no yield, RWA, credit or rebasing asset.

Performance attribution is computed per composition period. Returns are attributed only to the members that were included in the period in which they were earned; a member added or removed at a composition boundary does not contribute returns from a period it was not part of. When chain coverage for a period is incomplete, the attribution is labelled explicitly as incomplete rather than presented as a complete figure. The attribution API surfaces this as a `coverage` field (`complete` or `incomplete`) per period so consumers never mistake a partial figure for a full one.

A later funded version may expose deposit, mint, withdraw and redeem entry points on a Soroban vault contract, with share accounting in the shape ERC-4626 established on the EVM, adapted to a SEP-41 share token. The vault—not an agent—is the share and asset source of truth. Initial shares equal assets. Later conversion rounds down in favor of the vault and records residual dust. A minimum locked seed plus a minimum-deposit rule mitigates donation/inflation attacks; direct USDC donations increase share price and never mint shares to the donor.

The policy caps each agent and category, validates weights sum to 10,000 bps, and keeps allocations idle when an agent is paused, a signal is stale, or a copy fails. Rebalance changes future allocation only; it cannot rewrite realized PnL. Performance fees apply only to realized gains above an atomic high-water mark. Management fees are disabled in v1.

Emergency withdrawal is a direct user-to-vault call and cannot depend on an agent executor, research worker or oracle. It returns liquid USDC immediately. Funds in unresolved onchain markets cannot be fabricated as liquid; the user receives a transferable pro-rata withdrawal claim that becomes redeemable from deterministic settlement events. Create, rebalance and copy can pause independently while exit remains enabled.

## Stellar-specific constraints on the funded design

Recorded here because they shape the contract rather than the copy, and are easy to lose:

- **Exit must be pull-shaped, not a loop.** A Stellar transaction is capped on its ledger-entry footprint, which is why `mimir-market` pays challengers by pull rather than iterating at resolution. A vault redeeming many holders in one call has the same ceiling, so the withdrawal claim is drawn down per holder.
- **A holder needs a trustline before they can be paid.** A share token or a USDC payout can only land in an account that already trusts the asset, and a trustline is a classic operation that cannot share a transaction with a Soroban operation. Exit therefore cannot assume it can create the receiving position on the user's behalf.
- **A failed payout must park, not revert.** A frozen or authorization-revoked USDC trustline makes the SAC transfer fail; the vault must fall back to a withdrawable balance the way `escrow::push_or_park` does, or one uncooperative holder blocks the others.
- **No fee sponsorship.** The user pays their own ~100-stroop fee to exit. This is a feature for a non-custodial vault: exit cannot be gated on Mimir funding anything.

## Launch boundary

`BASKET_DEPOSITS_ENABLED` remains false until contract audit, custody/legal analysis, sanctions and eligibility controls, Stellar Testnet invariant/KPI evidence, contract-id and WASM-hash verification and incident runbooks are signed off. No UI may call a funded deposit route while this flag is false.
