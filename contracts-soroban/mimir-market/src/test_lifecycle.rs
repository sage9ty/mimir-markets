#![cfg(test)]
//! Claim creation, challenging, gating and cancellation.
//! Validates rematch parent links to preserve contract-first accounting, clear market semantics, and safe agent operations.
extern crate std;

use crate::test_common::{Fixture, USDC};
use crate::types::{
    ClaimState, Error, WinnerSide, MAX_CHALLENGERS, MAX_CLAIM_METADATA_BYTES, MAX_METADATA_BYTES,
    MIN_STAKE,
};

// ── Creation ─────────────────────────────────────────────────────────────────

#[test]
fn creating_a_claim_escrows_the_stake_and_defaults_the_config() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    assert_eq!(id, 1);
    assert_eq!(f.token().balance(&creator), 90 * USDC);
    assert_eq!(f.escrow_balance(), 10 * USDC);

    let claim = f.client().get_claim(&id);
    assert_eq!(claim.creator, creator);
    assert_eq!(claim.creator_stake, 10 * USDC);
    assert_eq!(claim.total_challenger_stake, 0);
    assert_eq!(claim.state, ClaimState::Open);
    assert_eq!(claim.winner_side, WinnerSide::None);
    assert_eq!(claim.challenger_count, 0);
    assert_eq!(claim.created_at, f.env.ledger().timestamp());
    assert_eq!(claim.evidence_hash, None);
    // Settlement accounting starts empty and is seeded by resolve_claim.
    assert_eq!(claim.remaining_escrow, 0);
    assert_eq!(claim.challenger_claims, 0);
    // Each successful mutation returns an explicit claim revision; creation starts at 1.
    assert_eq!(claim.revision, 1);

    let config = f.client().get_claim_market_config(&id);
    assert_eq!(config.max_challengers, MAX_CHALLENGERS);
    assert_eq!(config.odds_mode, f.str("pool"));
    assert_eq!(config.challenger_payout_bps, 0);
    assert!(!config.is_private);
    assert_eq!(config.invite_key_hash, None);

    assert_eq!(f.client().get_platform_stats().total_claims, 1);
    assert_eq!(f.client().get_challenger_list(&id).len(), 0);
}

#[test]
fn ids_increment_and_are_independent() {
    let f = Fixture::new(0, 0);
    let a = f.user(100 * USDC);
    let b = f.user(100 * USDC);
    assert_eq!(f.client().create_claim(&a, &f.params(3 * USDC)), 1);
    assert_eq!(f.client().create_claim(&b, &f.params(4 * USDC)), 2);
    assert_eq!(f.client().get_claim(&1).creator_stake, 3 * USDC);
    assert_eq!(f.client().get_claim(&2).creator_stake, 4 * USDC);
    assert_eq!(f.escrow_balance(), 7 * USDC);
}

#[test]
fn empty_metadata_falls_back_to_defaults() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.category = f.str("");
    params.market_type = f.str("");
    let id = f.client().create_claim(&creator, &params);

    assert_eq!(f.client().get_claim(&id).category, f.str("custom"));
    assert_eq!(
        f.client().get_claim_market_config(&id).market_type,
        f.str("binary")
    );
}

#[test]
fn a_stake_below_the_minimum_is_rejected() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let err = f
        .client()
        .try_create_claim(&creator, &f.params(MIN_STAKE - 1))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::StakeTooSmall);
    // Exactly the minimum is fine.
    f.client().create_claim(&creator, &f.params(MIN_STAKE));
}

#[test]
fn a_deadline_in_the_past_is_rejected() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.deadline = f.env.ledger().timestamp();
    let err = f
        .client()
        .try_create_claim(&creator, &params)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::DeadlineInPast);
}

#[test]
fn an_empty_question_is_rejected() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.question = f.str("");
    let err = f
        .client()
        .try_create_claim(&creator, &params)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::EmptyQuestion);
}

#[test]
fn creating_a_claim_requires_the_creators_signature() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    f.env.set_auths(&[]);
    assert!(f
        .client()
        .try_create_claim(&creator, &f.params(10 * USDC))
        .is_err());
}

#[test]
fn fixed_odds_defaults_to_a_2x_payout_when_the_override_is_too_low() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);

    let mut params = f.params(10 * USDC);
    params.odds_mode = f.str("fixed");
    params.challenger_payout_bps = 5_000; // below BPS_DIVISOR, so ignored
    let id = f.client().create_claim(&creator, &params);
    assert_eq!(
        f.client().get_claim_market_config(&id).challenger_payout_bps,
        20_000
    );

    // An override at or above 1x is honoured.
    let mut params = f.params(10 * USDC);
    params.odds_mode = f.str("fixed");
    params.challenger_payout_bps = 13_000;
    let id = f.client().create_claim(&creator, &params);
    assert_eq!(
        f.client().get_claim_market_config(&id).challenger_payout_bps,
        13_000
    );
}

#[test]
fn an_unrecognised_odds_mode_is_normalised_to_pool() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.odds_mode = f.str("Fixed"); // case matters, as in Solidity
    params.challenger_payout_bps = 20_000;
    let id = f.client().create_claim(&creator, &params);

    let config = f.client().get_claim_market_config(&id);
    assert_eq!(config.odds_mode, f.str("pool"));
    assert_eq!(config.challenger_payout_bps, 0);
}

#[test]
fn max_challengers_is_clamped_to_the_hard_limit() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.max_challengers = 5_000;
    let id = f.client().create_claim(&creator, &params);
    assert_eq!(
        f.client().get_claim_market_config(&id).max_challengers,
        MAX_CHALLENGERS
    );
}

// ── Challenging ──────────────────────────────────────────────────────────────

#[test]
fn challenging_escrows_the_stake_and_activates_the_claim() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(4 * USDC), &None);

    let claim = f.client().get_claim(&id);
    assert_eq!(claim.state, ClaimState::Active);
    assert_eq!(claim.challenger_count, 1);
    assert_eq!(claim.total_challenger_stake, 4 * USDC);
    assert_eq!(f.escrow_balance(), 14 * USDC);

    let list = f.client().get_challenger_list(&id);
    assert_eq!(list.len(), 1);
    assert_eq!(list.get(0).unwrap().address, c1);
    assert_eq!(list.get(0).unwrap().stake, 4 * USDC);
    // The roster carries settlement status, so a client can tell at a glance who
    // still has a payout to pull.
    assert!(!list.get(0).unwrap().claimed);
}

#[test]
fn the_creator_cannot_challenge_their_own_claim() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    let err = f
        .client()
        .try_challenge_claim(&creator, &id, &(5 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::SelfChallenge);
}

#[test]
fn the_same_address_can_retry_a_challenge_without_paying_twice() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    f.client().challenge_claim(&c1, &id, &(4 * USDC), &None);
    f.client().challenge_claim(&c1, &id, &(4 * USDC), &None);
    assert_eq!(f.escrow_balance(), 14 * USDC);
    assert_eq!(f.client().get_claim(&id).challenger_count, 1);
    assert_eq!(f.client().get_challenger_list(&id).len(), 1);
}

#[test]
fn a_challenge_below_the_minimum_stake_is_rejected() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    let err = f
        .client()
        .try_challenge_claim(&c1, &id, &(MIN_STAKE - 1), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::StakeTooSmall);
}

#[test]
fn challenging_an_unknown_claim_is_rejected() {
    let f = Fixture::new(0, 0);
    let c1 = f.user(100 * USDC);
    let err = f
        .client()
        .try_challenge_claim(&c1, &99, &(5 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ClaimNotFound);
}

#[test]
fn a_full_market_rejects_further_challengers() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.max_challengers = 2;
    let id = f.client().create_claim(&creator, &params);

    f.client()
        .challenge_claim(&f.user(100 * USDC), &id, &(3 * USDC), &None);
    f.client()
        .challenge_claim(&f.user(100 * USDC), &id, &(3 * USDC), &None);

    let late = f.user(100 * USDC);
    let err = f
        .client()
        .try_challenge_claim(&late, &id, &(3 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ClaimFull);
}

#[test]
fn a_duel_requires_an_exactly_equal_stake() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.max_challengers = 1;
    let id = f.client().create_claim(&creator, &params);

    for wrong in [10 * USDC - 1, 10 * USDC + 1, 5 * USDC, 20 * USDC] {
        let err = f
            .client()
            .try_challenge_claim(&c1, &id, &wrong, &None)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::DuelNeedsEqualStake);
    }

    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    assert_eq!(f.client().get_claim(&id).total_challenger_stake, 10 * USDC);
}

#[test]
fn challenging_requires_the_challengers_signature() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    f.env.set_auths(&[]);
    assert!(f
        .client()
        .try_challenge_claim(&c1, &id, &(5 * USDC), &None)
        .is_err());
}

// ── Private markets ──────────────────────────────────────────────────────────

#[test]
fn a_private_market_gates_on_the_invite_key() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let invited = f.user(100 * USDC);
    let outsider = f.user(100 * USDC);

    let mut params = f.params(10 * USDC);
    params.is_private = true;
    params.invite_key = Some(f.str("open-sesame"));
    let id = f.client().create_claim(&creator, &params);
    assert!(f.client().get_claim_market_config(&id).is_private);
    assert!(f.client().get_claim_market_config(&id).invite_key_hash.is_some());

    // No key at all.
    let err = f
        .client()
        .try_challenge_claim(&outsider, &id, &(5 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidInviteKey);

    // Wrong key.
    let err = f
        .client()
        .try_challenge_claim(&outsider, &id, &(5 * USDC), &Some(f.str("guess")))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidInviteKey);

    // Near-miss key.
    let err = f
        .client()
        .try_challenge_claim(&outsider, &id, &(5 * USDC), &Some(f.str("open-sesam")))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InvalidInviteKey);

    // Nothing leaked into escrow from the rejected attempts.
    assert_eq!(f.escrow_balance(), 10 * USDC);

    // The right key gets in.
    f.client()
        .challenge_claim(&invited, &id, &(5 * USDC), &Some(f.str("open-sesame")));
    assert_eq!(f.client().get_claim(&id).challenger_count, 1);
}

#[test]
fn a_private_market_without_a_key_is_open_to_all() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let anyone = f.user(100 * USDC);

    let mut params = f.params(10 * USDC);
    params.is_private = true;
    params.invite_key = None;
    let id = f.client().create_claim(&creator, &params);
    assert_eq!(f.client().get_claim_market_config(&id).invite_key_hash, None);

    // Mirrors Solidity: the gate is skipped when inviteKeyHash is unset.
    f.client().challenge_claim(&anyone, &id, &(5 * USDC), &None);
    assert_eq!(f.client().get_claim(&id).challenger_count, 1);
}

#[test]
fn a_public_market_ignores_a_supplied_invite_key() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let mut params = f.params(10 * USDC);
    params.is_private = false;
    params.invite_key = Some(f.str("irrelevant"));
    let id = f.client().create_claim(&creator, &params);

    f.client()
        .challenge_claim(&c1, &id, &(5 * USDC), &Some(f.str("totally-wrong")));
    assert_eq!(f.client().get_claim(&id).challenger_count, 1);
}

#[test]
fn an_over_long_invite_key_is_rejected_rather_than_truncated() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let long = "k".repeat(129);
    let mut params = f.params(10 * USDC);
    params.is_private = true;
    params.invite_key = Some(soroban_sdk::String::from_str(&f.env, &long));

    let err = f
        .client()
        .try_create_claim(&creator, &params)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::InviteKeyTooLong);
}

// ── Cancellation ─────────────────────────────────────────────────────────────

#[test]
fn cancelling_before_any_challenge_refunds_in_full() {
    let f = Fixture::new(1_000, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    assert_eq!(f.token().balance(&creator), 90 * USDC);

    f.client().cancel_claim(&id);

    assert_eq!(f.client().get_claim(&id).state, ClaimState::Cancelled);
    assert_eq!(f.token().balance(&creator), 100 * USDC);
    assert_eq!(f.escrow_balance(), 0);
    // A refund is not profit, so no fee was taken.
    assert_eq!(f.client().get_accrued_fees(&f.platform), 0);
}

#[test]
fn cancelling_twice_is_idempotent() {
    let f = Fixture::new(1_000, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    f.client().cancel_claim(&id);
    f.client().cancel_claim(&id); // Should not error

    assert_eq!(f.client().get_claim(&id).state, ClaimState::Cancelled);
    assert_eq!(f.token().balance(&creator), 100 * USDC);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn a_challenged_claim_can_no_longer_be_cancelled() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);

    // An Active claim still fails on the state check first: ClaimNotOpen is
    // the lifecycle error. The deeper accounting guard (ClaimHasActiveClaims)
    // is covered by the dedicated tests below, which emulate the inconsistent
    // state a lost update or a stale read can present.
    let err = f.client().try_cancel_claim(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::ClaimNotOpen);
    assert_eq!(f.escrow_balance(), 15 * USDC);
}

#[test]
fn only_the_creator_can_cancel() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    f.env.set_auths(&[]);
    assert!(f.client().try_cancel_claim(&id).is_err());

    f.env.mock_all_auths();
    f.client().cancel_claim(&id);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Cancelled);
}

#[test]
fn a_cancelled_claim_cannot_be_challenged() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().cancel_claim(&id);

    let err = f
        .client()
        .try_challenge_claim(&c1, &id, &(5 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ClaimNotOpen);
}

#[test]
fn cancelling_an_unknown_claim_is_rejected() {
    let f = Fixture::new(0, 0);
    let err = f.client().try_cancel_claim(&42).unwrap_err().unwrap();
    assert_eq!(err, Error::ClaimNotFound);
}

// ── Cancellation guards against active claims ──────────────────────────────
//
// cancel_claim is the one lifecycle transition where the creator — not the
// oracle — moves money out of escrow. The state check alone trusts the state
// LABEL; the tests below pin the contract-side accounting guards that keep the
// refund from ever diverging from what the escrow actually holds.

/// Regression for the active-claims guard: a claim whose accounting shows
/// funded challengers must not be cancellable, whatever its state field says.
/// The inconsistent claim is written directly into storage to emulate a state
/// transition that never completed (or a stale read-index steering a worker at
/// the wrong target), then the contract refuses the refund and changes nothing.
#[test]
fn a_claim_with_funded_challengers_cannot_be_cancelled_even_if_open() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);

    // Rewind the lifecycle label to Open while every funded position remains:
    // the exact inconsistency a lost update or a stale read would present.
    let mut claim = f.client().get_claim(&id);
    assert_eq!(claim.state, ClaimState::Active);
    claim.state = ClaimState::Open;
    f.env.as_contract(&f.contract_id, || {
        crate::storage::set_claim(&f.env, id, &claim);
    });

    let inflow = f.escrow_balance();
    assert_eq!(inflow, 15 * USDC);

    let err = f.client().try_cancel_claim(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::ClaimHasActiveClaims);

    // Nothing was written: the claim is untouched, the challengers' funds are
    // still in escrow, and no refund was minted from them.
    let after = f.client().get_claim(&id);
    assert_eq!(after.state, ClaimState::Open);
    assert_eq!(after.challenger_count, 1);
    assert_eq!(after.total_challenger_stake, 5 * USDC);
    assert_eq!(f.escrow_balance(), inflow);
    assert_eq!(f.token().balance(&creator), 90 * USDC);
    assert_eq!(f.token().balance(&c1), 95 * USDC);
    assert_eq!(f.client().get_withdrawable(&creator), 0);

    // The guard refused the refund; it did not brick the market. The Open
    // claim accepts the next challenger and the market resumes normally.
    let c2 = f.user(100 * USDC);
    f.client().challenge_claim(&c2, &id, &(2 * USDC), &None);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Active);
    assert_eq!(f.client().get_claim(&id).challenger_count, 2);
}

/// Boundary: the guard keys on the claim's OWN accounting, so a single atomic
/// unit of counterparty exposure — the smallest residue a fixed-odds challenge
/// can reserve — blocks the refund, while exactly zero allows it.
#[test]
fn a_single_atomic_unit_of_exposure_blocks_cancellation() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    // One stroop of reserved creator liability, no challengers: the least
    // inconsistent claim that is still not refundable.
    let mut claim = f.client().get_claim(&id);
    claim.reserved_creator_liability = 1;
    f.env.as_contract(&f.contract_id, || {
        crate::storage::set_claim(&f.env, id, &claim);
    });

    let err = f.client().try_cancel_claim(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::ClaimHasActiveClaims);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Open);
    assert_eq!(f.escrow_balance(), 10 * USDC);

    // Exactly zero exposure cancels normally: the normal path is unchanged.
    let mut claim = f.client().get_claim(&id);
    claim.reserved_creator_liability = 0;
    f.env.as_contract(&f.contract_id, || {
        crate::storage::set_claim(&f.env, id, &claim);
    });
    f.client().cancel_claim(&id);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Cancelled);
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.token().balance(&creator), 100 * USDC);
}

/// Conservation across the shared escrow: cancelling one claim pays out
/// exactly that claim's stake and touches nothing else — not the other open
/// claim's funds, not accrued fees, not the fee policy.
#[test]
fn cancellation_conserves_the_shared_escrow() {
    let f = Fixture::new(150, 50);
    let creator_a = f.user(100 * USDC);
    let creator_b = f.user(100 * USDC);
    let a = f.client().create_claim(&creator_a, &f.params(10 * USDC));
    let b = f.client().create_claim(&creator_b, &f.params(7 * USDC));
    assert_eq!(f.escrow_balance(), 17 * USDC);

    f.client().cancel_claim(&a);

    assert_eq!(f.client().get_claim(&a).state, ClaimState::Cancelled);
    assert_eq!(f.client().get_claim(&b).state, ClaimState::Open);
    // Only claim A's stake left the shared escrow; B's funds are untouched.
    assert_eq!(f.escrow_balance(), 7 * USDC);
    assert_eq!(f.token().balance(&creator_a), 100 * USDC);
    assert_eq!(f.token().balance(&creator_b), 93 * USDC);
    // A refund is not profit: no fee leg exists on either policy level.
    assert_eq!(f.client().get_accrued_fees(&f.platform), 0);
    assert_eq!(f.client().get_platform_stats().balance, 7 * USDC);

    // Claim B still lives its full lifecycle afterwards.
    let c1 = f.user(100 * USDC);
    f.client().challenge_claim(&c1, &b, &(3 * USDC), &None);
    f.advance_by(3_600);
    f.client().resolve_claim(&b, &WinnerSide::Challengers, &f.str("won"), &85, &f.zero_hash());
    // Pool mode: the challenger takes their stake plus the creator's, less the
    // fee on profit only. Profit 7 USDC at the platform's 150 bps (the
    // agent-owner leg has no recipient on this claim) = 1_050_000 atomic.
    assert_eq!(f.client().claim_challenger_payout(&c1, &b), 98_950_000);
    // The escrow keeps the fee and nothing else; claim A's refund never
    // contributed.
    assert_eq!(f.escrow_balance(), 1_050_000);
}

/// A refund the creator's wallet cannot accept is parked as a withdrawable
/// balance: the cancellation still finalises, funds stay in escrow until
/// pulled, and nothing is minted.
#[test]
fn a_cancellation_refund_is_parked_when_the_creator_cannot_receive() {
    let f = Fixture::with_stub_token(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.stub().set_blocked(&creator, &true);

    f.client().cancel_claim(&id);

    assert_eq!(f.client().get_claim(&id).state, ClaimState::Cancelled);
    assert_eq!(f.client().get_withdrawable(&creator), 10 * USDC);
    assert_eq!(f.escrow_balance(), 10 * USDC);

    // Once the wallet can receive again, the creator pulls their own refund.
    f.stub().set_blocked(&creator, &false);
    assert_eq!(f.client().withdraw(&creator), 10 * USDC);
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.token().balance(&creator), 100 * USDC);
}

/// Ordering race: whichever transaction the ledger sequences second is refused,
/// because the contract re-derives the claim's state at execution time and
/// never trusts a caller's view of it. A creator cancel prepared against a
/// stale Open read cannot fire after a challenge has activated the market, and
/// a challenge cannot land after a cancellation finalised.
#[test]
fn a_cancel_that_executes_after_a_challenge_is_refused() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    // The challenge wins the ordering race and activates the market.
    f.client().challenge_claim(&c1, &id, &(5 * USDC), &None);

    // The creator's cancel — authorized and everything — now executes against
    // Active state and is refused: nothing moves, nothing is rewritten.
    let err = f.client().try_cancel_claim(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::ClaimNotOpen);
    assert_eq!(f.escrow_balance(), 15 * USDC);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Active);

    // The mirror case: a cancelled claim refuses a later challenge too.
    let id2 = f.client().create_claim(&creator, &f.params(4 * USDC));
    f.client().cancel_claim(&id2);
    let err = f
        .client()
        .try_challenge_claim(&c1, &id2, &(4 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ClaimNotOpen);
    assert_eq!(f.escrow_balance(), 15 * USDC);
}

/// The new error codes are part of the interface: pin them so downstream
/// clients and read-index reason about stable numbers.
#[test]
fn cancellation_error_codes_are_stable() {
    assert_eq!(Error::ClaimHasActiveClaims as u32, 38);
    assert_eq!(Error::RefundNotEscrowed as u32, 39);
}

// ── Views ────────────────────────────────────────────────────────────────────

#[test]
fn views_report_the_wired_configuration() {
    let f = Fixture::new(150, 50);
    assert_eq!(f.client().get_owner(), f.owner);
    assert_eq!(f.client().get_oracle(), f.oracle);
    assert_eq!(f.client().get_usdc(), f.token_id);
    let policy = f.client().get_fee_policy();
    assert_eq!(policy.platform_fee_bps, 150);
    assert_eq!(policy.agent_owner_fee_bps, 50);
    assert_eq!(policy.platform_recipient, Some(f.platform.clone()));

    let stats = f.client().get_platform_stats();
    assert_eq!(stats.total_claims, 0);
    assert_eq!(stats.resolved, 0);
    assert_eq!(stats.balance, 0);
    assert_eq!(stats.fees_accrued, 0);
    assert_eq!(stats.fees_claimed, 0);
}

#[test]
fn an_unknown_claim_reads_as_not_found() {
    let f = Fixture::new(0, 0);
    assert_eq!(
        f.client().try_get_claim(&7).unwrap_err().unwrap(),
        Error::ClaimNotFound
    );
    assert_eq!(
        f.client().try_get_claim_fees(&7).unwrap_err().unwrap(),
        Error::ClaimNotFound
    );
    assert_eq!(
        f.client()
            .try_get_claim_market_config(&7)
            .unwrap_err()
            .unwrap(),
        Error::ClaimNotFound
    );
    assert_eq!(f.client().get_challenger_list(&7).len(), 0);
}

// -- Soroban transaction-size ceiling, and why settlement is pull-based -------
//
// MimirV2.resolveClaim paid every challenger in ONE transaction. On Base that
// only costs gas; on Soroban a transaction is also capped on its ledger-entry
// FOOTPRINT, and that cap binds long before CPU does. Measured cost of the
// original push-based resolve (CHALLENGERS win, pool mode), soroban-sdk 25.3.2
// against InvocationResourceLimits::mainnet():
//
//     challengers |  1 |  5 | 10 | 15 | 20 | 21 |  22 |  25 |  50 | 100
//     write_entrs |  8 | 16 | 26 | 36 | 46 | 48 |  50 |  56 | 106 | 206
//     footprint   | 19 | 35 | 55 | 75 | 95 | 99 | 103 | 115 | 215 | 415
//     insns (M)   |0.6 |1.7 |3.3 |5.2 |7.3 |7.8 | 8.3 | 9.7 |24.6 |69.7
//
// Mainnet caps write_entries at 50 and footprint ledger_entries at 100, so a
// push-based resolve could only settle 21 challengers. Beyond that a market
// could be resolved but never fully paid -- funds permanently stranded.
//
// Settlement is therefore split: resolve_claim is O(1) and each challenger pulls
// via claim_challenger_payout. The tests below prove a market filled to
// MAX_CHALLENGERS = 100 both resolves and pays out completely, with every single
// call comfortably inside mainnet limits.
//
// Note on metering: invocation resource limits are enforced per top-level call
// and default to mainnet, so no setup is needed to arm them. Only the CPU/memory
// tracker accumulates across a test, hence the explicit budget resets.

/// Resolution is O(1) in the challenger count: its footprint at 100 challengers
/// is the same as at 1.
#[test]
fn resolution_cost_is_flat_in_the_challenger_count() {
    let mut measurements = std::vec::Vec::new();

    for n in [1u32, 50, MAX_CHALLENGERS] {
        let f = Fixture::new(500, 0);
        f.env.cost_estimate().budget().reset_unlimited();

        let creator = f.user(10_000 * USDC);
        let mut params = f.params(500 * USDC);
        params.max_challengers = MAX_CHALLENGERS;
        let id = f.client().create_claim(&creator, &params);
        for _ in 0..n {
            f.client()
                .challenge_claim(&f.user(10 * USDC), &id, &(2 * USDC), &None);
        }
        f.advance_by(3_600);

        f.env
            .cost_estimate()
            .budget()
            .reset_limits(600_000_000, 41_943_040);
        f.client().resolve_claim(
            &id,
            &WinnerSide::Challengers,
            &f.str("won"),
            &85,
            &f.zero_hash(),
        );

        let r = f.env.cost_estimate().resources();
        let footprint = r.disk_read_entries + r.memory_read_entries + r.write_entries;
        assert!(
            r.write_entries <= 50 && footprint <= 100,
            "n={}: writes {} footprint {} over mainnet caps",
            n,
            r.write_entries,
            footprint
        );
        measurements.push((n, r.write_entries, footprint));
        f.env.cost_estimate().budget().reset_unlimited();
    }

    // Flat, not linear: the 100-challenger resolve costs no more writes than the
    // single-challenger one. This is what makes MAX_CHALLENGERS reachable.
    let (_, writes_at_1, _) = measurements[0];
    let (_, writes_at_100, _) = measurements[2];
    assert_eq!(
        writes_at_1, writes_at_100,
        "resolve_claim must be O(1) in challenger count: {:?}",
        measurements
    );
}

/// A single challenger's pull is O(1) and sits inside mainnet limits, even on a
/// market with the maximum roster.
#[test]
fn a_single_challenger_pull_stays_well_inside_mainnet_limits() {
    let f = Fixture::new(500, 0);
    f.env.cost_estimate().budget().reset_unlimited();

    let creator = f.user(10_000 * USDC);
    let mut params = f.params(500 * USDC);
    params.max_challengers = MAX_CHALLENGERS;
    let id = f.client().create_claim(&creator, &params);
    let mut roster = std::vec::Vec::new();
    for _ in 0..MAX_CHALLENGERS {
        let who = f.user(10 * USDC);
        f.client().challenge_claim(&who, &id, &(2 * USDC), &None);
        roster.push(who);
    }
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("won"),
        &85,
        &f.zero_hash(),
    );

    f.env
        .cost_estimate()
        .budget()
        .reset_limits(600_000_000, 41_943_040);
    f.client().claim_challenger_payout(&roster[0], &id);

    let r = f.env.cost_estimate().resources();
    let footprint = r.disk_read_entries + r.memory_read_entries + r.write_entries;
    assert!(
        r.write_entries <= 50,
        "pull write entries {} over the mainnet cap of 50",
        r.write_entries
    );
    assert!(
        footprint <= 100,
        "pull footprint {} over the mainnet cap of 100",
        footprint
    );
    f.env.cost_estimate().budget().reset_unlimited();
}

/// The regression this redesign exists for: a market filled to MAX_CHALLENGERS
/// resolves AND pays out all 100 challengers in full, with every call enforced
/// against mainnet transaction limits throughout. Nothing is stranded.
#[test]
fn a_market_filled_to_max_challengers_pays_out_all_one_hundred() {
    let f = Fixture::new(500, 0); // 5% platform fee
    // Resource limits stay armed for every call; only the shared CPU tracker is
    // released, since this is 200+ separate transactions in reality.
    f.env.cost_estimate().budget().reset_unlimited();

    let creator = f.user(10_000 * USDC);
    let creator_stake = 500 * USDC;
    let mut params = f.params(creator_stake);
    params.max_challengers = MAX_CHALLENGERS;
    let id = f.client().create_claim(&creator, &params);

    // Simulate a claim created before the hard cap was enforced at admission.
    let mut claim = f.env.as_contract(&f.client().address, || crate::storage::get_claim(&f.env, id).unwrap());
    claim.market.max_challengers = crate::types::MAX_CHALLENGERS + 1;
    f.env.as_contract(&f.client().address, || crate::storage::set_claim(&f.env, id, &claim));

    let stake = 2 * USDC;
    let mut challengers = std::vec::Vec::new();
    for _ in 0..MAX_CHALLENGERS {
        let who = f.user(10 * USDC);
        f.client().challenge_claim(&who, &id, &stake, &None);
        challengers.push(who);
    }
    assert_eq!(f.client().get_claim(&id).challenger_count, MAX_CHALLENGERS);

    // The 101st is refused.
    let over = f.user(10 * USDC);
    assert_eq!(
        f.client()
            .try_challenge_claim(&over, &id, &stake, &None)
            .unwrap_err()
            .unwrap(),
        Error::ClaimFull
    );

    let inflow = f.escrow_balance();
    assert_eq!(inflow, creator_stake + stake * MAX_CHALLENGERS as i128);

    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("all won"),
        &85,
        &f.zero_hash(),
    );
    // The entire pot is left for the challengers to pull.
    assert_eq!(f.client().get_claim(&id).remaining_escrow, inflow);

    // Every one of the 100 pulls succeeds under mainnet limits.
    let mut paid = 0i128;
    for who in challengers.iter() {
        paid += f.client().claim_challenger_payout(who, &id);
    }

    // Nothing stranded: the escrow owes nothing and holds only the fees.
    let fees = f.client().get_accrued_fees(&f.platform);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
    assert_eq!(paid + fees, inflow, "conservation across the full lifecycle");
    assert_eq!(f.escrow_balance(), fees);

    // Every winner is above principal, and every roster slot is settled.
    for who in challengers.iter() {
        assert!(
            f.token().balance(who) >= 10 * USDC,
            "winner fell below principal"
        );
    }
    for entry in f.client().get_challenger_list(&id).iter() {
        assert!(entry.claimed);
    }

    // The fee recipient can collect, leaving the escrow completely empty.
    assert_eq!(f.client().claim_fees(&f.platform), fees);
    assert_eq!(f.escrow_balance(), 0);
}

/// The same, for a full roster on the refund path.
#[test]
fn a_full_roster_is_fully_refunded_on_an_unresolvable_verdict() {
    let f = Fixture::new(1_000, 0);
    f.env.cost_estimate().budget().reset_unlimited();

    let creator = f.user(10_000 * USDC);
    let mut params = f.params(50 * USDC);
    params.max_challengers = MAX_CHALLENGERS;
    let id = f.client().create_claim(&creator, &params);

    let stake = 2 * USDC;
    let mut challengers = std::vec::Vec::new();
    for _ in 0..MAX_CHALLENGERS {
        let who = f.user(10 * USDC);
        f.client().challenge_claim(&who, &id, &stake, &None);
        challengers.push(who);
    }
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Unresolvable,
        &f.str("no source"),
        &0,
        &f.zero_hash(),
    );

    for who in challengers.iter() {
        assert_eq!(f.client().claim_challenger_payout(who, &id), stake);
        assert_eq!(f.token().balance(who), 10 * USDC);
    }
    // A refund is not profit, so nothing was skimmed and the escrow is empty.
    assert_eq!(f.token().balance(&creator), 10_000 * USDC);
    assert_eq!(f.client().get_accrued_fees(&f.platform), 0);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), 0);
}


#[test]
fn transition_deadline_cancels_underfunded_open_claim() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    // Too early
    let err = f.client().try_transition_deadline(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::Timelocked);

    // Pass deadline
    f.advance_to(f.client().get_claim(&id).deadline + 1);

    f.client().transition_deadline(&id);
    let claim = f.client().get_claim(&id);
    assert_eq!(claim.state, ClaimState::Cancelled);
    assert_eq!(f.token().balance(&creator), 100 * USDC);
}

#[test]
fn transition_deadline_preserves_active_state_to_extend_ttl() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    let challenger = f.user(100 * USDC);
    
    f.client().challenge_claim(&challenger, &id, &(10 * USDC), &None);
    f.advance_to(f.client().get_claim(&id).deadline + 1);

    // Should succeed now to persist TTL bumps instead of failing
    f.client().transition_deadline(&id);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Active);
}

// ── Metadata bounds ──────────────────────────────────────────────────────────

/// A metadata string exactly at the per-field cap is stored, not truncated.
#[test]
fn metadata_at_the_per_field_bound_is_accepted() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.question = f.str(&"q".repeat(MAX_METADATA_BYTES as usize));

    let id = f.client().create_claim(&creator, &params);
    assert_eq!(f.client().get_claim(&id).question.len(), MAX_METADATA_BYTES);
}

/// One byte over the per-field cap is refused, and no money moved.
#[test]
fn over_long_metadata_is_rejected_before_any_money_moves() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.question = f.str(&"q".repeat(MAX_METADATA_BYTES as usize + 1));

    let err = f
        .client()
        .try_create_claim(&creator, &params)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::MetadataTooLong);

    // The rejection lands before `escrow::pull`, so nothing is escrowed, the
    // creator's balance is untouched and no claim id is consumed.
    assert_eq!(f.escrow_balance(), 0);
    assert_eq!(f.token().balance(&creator), 100 * USDC);
    assert_eq!(f.client().get_platform_stats().total_claims, 0);
    let err = f.client().try_get_claim(&1).unwrap_err().unwrap();
    assert_eq!(err, Error::ClaimNotFound);
}

/// The per-field caps alone admit 8 × 512 bytes; the aggregate budget is what
/// bounds the claim as a whole. Exactly at the budget is accepted, one more
/// byte is refused.
#[test]
fn the_aggregate_metadata_budget_is_enforced_exactly() {
    let f = Fixture::new(0, 0);
    let creator = f.user(200 * USDC);
    let mut params = f.params(10 * USDC);
    params.question = f.str(&"q".repeat(MAX_METADATA_BYTES as usize));
    params.creator_position = f.str(&"a".repeat(MAX_METADATA_BYTES as usize));
    params.counter_position = f.str(&"b".repeat(MAX_METADATA_BYTES as usize));
    params.category = f.str("c");
    params.market_type = f.str("binary");
    params.handicap_line = f.str("h");
    params.settlement_rule = f.str("s");
    // Fill `resolution_url` so the sum lands on the budget exactly.
    let fixed = MAX_METADATA_BYTES * 3 + 1 + 6 + 1 + 1;
    params.resolution_url = f.str(&"u".repeat((MAX_CLAIM_METADATA_BYTES - fixed) as usize));

    let id = f.client().create_claim(&creator, &params);
    assert_eq!(f.client().get_claim(&id).question.len(), MAX_METADATA_BYTES);
    assert_eq!(f.escrow_balance(), 10 * USDC);

    // One more metadata byte tips the claim over the budget: refused outright.
    let mut over = params;
    over.resolution_url = f.str(&"u".repeat((MAX_CLAIM_METADATA_BYTES - fixed + 1) as usize));
    let err = f
        .client()
        .try_create_claim(&creator, &over)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ClaimMetadataTooLong);
    assert_eq!(f.client().get_platform_stats().total_claims, 1);
    assert_eq!(f.escrow_balance(), 10 * USDC);
}
