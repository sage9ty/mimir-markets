#![cfg(test)]
//! Claiming: pro-rata payouts, dust absorption by the last claimant,
//! cancellation refunds, and profit-only fees.

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use crate::test_common::{Fixture, DEFAULT_DURATION, USDC};
use crate::types::{Error, RESULT_CANCELLED, SIDE_A, SIDE_B};

// ── Pro-rata payouts ─────────────────────────────────────────────────────────

#[test]
fn a_lone_winner_takes_the_whole_pool_less_the_profit_fee() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 1_000); // 10% fee

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(30 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // gross 40, principal 10, profit 30, fee 3 → net 37
    let net = f.client().claim(&a1, &id, &SIDE_A);
    assert_eq!(net, 37 * USDC);
    assert_eq!(f.token().balance(&a1), 90 * USDC + 37 * USDC);
    assert_eq!(f.client().get_accrued_fees(), 3 * USDC);
    // The escrow now holds only the fee.
    assert_eq!(f.escrow_balance(), 3 * USDC);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
}

#[test]
fn two_winners_split_the_pool_in_proportion_to_their_stakes() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let a2 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0); // fee-free, so the split is exact

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&a2, &id, &SIDE_A, &(30 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(40 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // total 80, winner pool 40 → 2x each.
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), 20 * USDC);
    assert_eq!(f.client().claim(&a2, &id, &SIDE_A), 60 * USDC);
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(f.client().get_accrued_fees(), 0);
}

#[test]
fn a_top_up_is_paid_as_one_combined_position() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(4 * USDC));
    f.client().deposit(&a1, &id, &SIDE_A, &(6 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // Single winner with a 10 USDC principal claims the whole 20 USDC.
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), 20 * USDC);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn a_double_sided_depositor_only_collects_on_the_winning_side() {
    let f = Fixture::new();
    let captain = f.user(0);
    let both = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&both, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&both, &id, &SIDE_B, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // Side A is the sole winning side and `both` is its only member.
    assert_eq!(f.client().claim(&both, &id, &SIDE_A), 30 * USDC);
    // Their losing side-B position pays nothing.
    let err = f
        .client()
        .try_claim(&both, &id, &SIDE_B)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::NotWinner);
}

// ── Dust absorption ──────────────────────────────────────────────────────────

/// Three winners with stakes that do not divide the pool evenly. The formula
/// truncates for the first two; the last claimant is handed whatever is left so
/// the escrow empties exactly.
#[test]
fn the_last_winner_to_claim_absorbs_the_truncation_dust() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let a2 = f.user(100 * USDC);
    let a3 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    // Winner pool 3 units, total 10 units → 10/3 per unit, which truncates.
    f.client().deposit(&a1, &id, &SIDE_A, &1);
    f.client().deposit(&a2, &id, &SIDE_A, &1);
    f.client().deposit(&a3, &id, &SIDE_A, &1);
    f.client().deposit(&b1, &id, &SIDE_B, &7);
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 10);

    // 10 * 1 / 3 = 3, truncated.
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), 3);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 7);
    assert_eq!(f.client().claim(&a2, &id, &SIDE_A), 3);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 4);

    // The third and final winner receives the remainder, not the formula's 3.
    assert_eq!(f.client().claim(&a3, &id, &SIDE_A), 4);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);

    // The escrow is empty: every atomic unit was paid out.
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn dust_absorption_still_charges_the_fee_on_profit_only() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let a2 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 1_000); // 10%

    f.client().deposit(&a1, &id, &SIDE_A, &(3 * USDC));
    f.client().deposit(&a2, &id, &SIDE_A, &(6 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // Pool 19 USDC over a 9 USDC winning side.
    // a1 is not the last claimant, so the formula applies:
    //   gross = 190_000_000 * 30_000_000 / 90_000_000 = 63_333_333 (truncated)
    //   profit = 33_333_333, fee = 3_333_333, net = 60_000_000
    let a1_net = f.client().claim(&a1, &id, &SIDE_A);
    assert_eq!(a1_net, 60_000_000);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 126_666_667);

    // a2 is the last claimant, so it absorbs the remainder rather than the
    // formula's truncated share:
    //   gross = 126_666_667, profit = 66_666_667, fee = 6_666_666
    let a2_net = f.client().claim(&a2, &id, &SIDE_A);
    assert_eq!(a2_net, 120_000_001);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);

    // Conservation: everything paid plus fees equals exactly what came in, with
    // no dust left behind.
    let total_in = 19 * USDC;
    let fees = f.client().get_accrued_fees();
    assert_eq!(fees, 3_333_333 + 6_666_666);
    assert_eq!(a1_net + a2_net + fees, total_in);
    assert_eq!(f.escrow_balance(), fees);

    // The fee was charged on profit only, so neither winner dipped below their
    // principal.
    assert!(a1_net >= 3 * USDC);
    assert!(a2_net >= 6 * USDC);
}

/// If a winner never claims, `winner_claims` never reaches `winner_count`, so
/// the dust branch is never taken and the unclaimed share stays in escrow. This
/// documents the Solidity behaviour rather than fixing it.
#[test]
fn an_unclaimed_share_stays_in_escrow() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let a2 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&a2, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(20 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // Only a1 claims; a2 walks away.
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), 20 * USDC);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 20 * USDC);
    assert_eq!(f.escrow_balance(), 20 * USDC);
}

// ── Cancellation ─────────────────────────────────────────────────────────────

#[test]
fn a_cancelled_market_refunds_every_principal_in_full() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let a2 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 1_000); // a fee is configured but must not apply

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&a2, &id, &SIDE_A, &(5 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(30 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &RESULT_CANCELLED);

    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), 10 * USDC);
    assert_eq!(f.client().claim(&a2, &id, &SIDE_A), 5 * USDC);
    assert_eq!(f.client().claim(&b1, &id, &SIDE_B), 30 * USDC);

    assert_eq!(f.token().balance(&a1), 100 * USDC);
    assert_eq!(f.token().balance(&a2), 100 * USDC);
    assert_eq!(f.token().balance(&b1), 100 * USDC);
    // A refund is not profit, so no fee was charged.
    assert_eq!(f.client().get_accrued_fees(), 0);
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
}

#[test]
fn a_cancelled_market_refunds_both_sides_of_a_double_depositor() {
    let f = Fixture::new();
    let captain = f.user(0);
    let both = f.user(100 * USDC);
    let id = f.market(&captain, 500);

    f.client().deposit(&both, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&both, &id, &SIDE_B, &(4 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &RESULT_CANCELLED);

    assert_eq!(f.client().claim(&both, &id, &SIDE_A), 10 * USDC);
    assert_eq!(f.client().claim(&both, &id, &SIDE_B), 4 * USDC);
    assert_eq!(f.token().balance(&both), 100 * USDC);
    assert_eq!(f.escrow_balance(), 0);
}

// ── Fees ─────────────────────────────────────────────────────────────────────

/// A one-sided market: the winning side IS the whole pool, so gross equals
/// principal and there is no profit to charge a fee on.
#[test]
fn a_break_even_winner_pays_no_fee() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let a2 = f.user(100 * USDC);
    let id = f.market(&captain, 1_000); // 10% configured but inapplicable

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&a2, &id, &SIDE_A, &(30 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // Nobody backed side B, so each winner just gets their own stake back.
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), 10 * USDC);
    assert_eq!(f.client().claim(&a2, &id, &SIDE_A), 30 * USDC);
    assert_eq!(f.client().get_accrued_fees(), 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn fees_accrue_across_markets_and_are_pulled_by_the_recipient_only() {
    let f = Fixture::new();
    let captain = f.user(0);

    // Two independent markets, each producing a fee.
    let mut expected_fees = 0;
    for _ in 0..2 {
        let a1 = f.user(100 * USDC);
        let b1 = f.user(100 * USDC);
        let id = f.market(&captain, 1_000);
        f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
        f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC));
        f.advance_by(DEFAULT_DURATION + 1);
        f.client().resolve(&id, &SIDE_A);
        f.client().claim(&a1, &id, &SIDE_A);
        // profit 10, fee 1
        expected_fees += USDC;
    }
    assert_eq!(f.client().get_accrued_fees(), expected_fees);
    assert_eq!(f.token().balance(&f.fee_recipient), 0);

    // Without the fee recipient's signature the pull fails.
    f.env.set_auths(&[]);
    assert!(f.client().try_claim_fees().is_err());
    f.env.mock_all_auths();

    assert_eq!(f.client().claim_fees(), expected_fees);
    assert_eq!(f.token().balance(&f.fee_recipient), expected_fees);
    assert_eq!(f.client().get_accrued_fees(), 0);
    assert_eq!(f.escrow_balance(), 0);

    // Nothing left to pull.
    assert_eq!(f.client().claim_fees(), 0);
}

#[test]
fn a_zero_fee_market_accrues_nothing() {
    let f = Fixture::new();
    let captain = f.user(0);
}
