#![cfg(test)]
//! #779 — read-only claim transition preflight.
//!
//! Verifies that `preflight_claim` answers structural eligibility correctly
//! without mutating any storage, and that a preflight can never be mistaken
//! for a successful signed execution.

use crate::test_common::{Fixture, USDC};
use crate::types::{ClaimState, PreflightReason, WinnerSide};

fn create_claim(f: &Fixture, stake: i128) -> u64 {
    f.client().create_claim(&f.user(stake * 4), &f.params(stake))
}

#[test]
fn eligible_claim_preflights_true() {
    let f = Fixture::new(100, 50);
    let id = create_claim(&f, 10 * USDC);
    // Advance into Active (any challenger stake transitions Open -> Active).
    f.client().challenge_claim(&f.user(10 * USDC), &id, &(10 * USDC));
    // Past the deadline.
    f.advance_by(3_600 + 1);

    let pf = f.client().preflight_claim(&id);
    assert!(pf.eligible);
    assert!(pf.lifecycle_ok);
    assert!(pf.constraints_ok);
    assert!(pf.requires_oracle_auth);
    assert_eq!(pf.missing_reasons.len(), 0);
}

#[test]
fn active_but_not_expired_preflights_false_with_reason() {
    let f = Fixture::new(100, 50);
    let id = create_claim(&f, 10 * USDC);
    f.client().challenge_claim(&f.user(10 * USDC), &id, &(10 * USDC));

    let pf = f.client().preflight_claim(&id);
    assert!(!pf.eligible);
    assert!(!pf.lifecycle_ok);
    assert!(pf.requires_oracle_auth);
    assert_eq!(pf.missing_reasons.len(), 1);
    assert_eq!(pf.missing_reasons.get(0).unwrap(), PreflightReason::NotYetExpired);
}

#[test]
fn open_claim_preflights_false_with_not_active() {
    let f = Fixture::new(100, 50);
    let id = create_claim(&f, 10 * USDC);
    // No challenger yet — claim is Open, not Active.

    let pf = f.client().preflight_claim(&id);
    assert!(!pf.eligible);
    assert!(!pf.lifecycle_ok);
    assert_eq!(pf.missing_reasons.get(0).unwrap(), PreflightReason::NotActive);
}

#[test]
fn resolved_claim_preflights_false_with_not_active() {
    let f = Fixture::new(100, 50);
    let id = create_claim(&f, 10 * USDC);
    f.client().challenge_claim(&f.user(10 * USDC), &id, &(10 * USDC));
    f.advance_by(3_600 + 1);
    f.client().resolve_claim(
        &f.oracle,
        &id,
        &WinnerSide::Creator,
        &f.str("ok"),
        &95,
        &f.zero_hash(),
    );

    let pf = f.client().preflight_claim(&id);
    assert!(!pf.eligible);
    assert_eq!(pf.missing_reasons.get(0).unwrap(), PreflightReason::NotActive);
}

#[test]
fn cancelled_claim_preflights_false_with_not_active() {
    let f = Fixture::new(100, 50);
    let id = create_claim(&f, 10 * USDC);
    f.client().cancel_claim(&id);

    let pf = f.client().preflight_claim(&id);
    assert!(!pf.eligible);
    assert_eq!(pf.missing_reasons.get(0).unwrap(), PreflightReason::NotActive);
}

#[test]
fn boundary_at_exact_deadline_is_eligible() {
    // resolve_claim_versioned uses `now < deadline` for NotYetExpired, so the
    // exact instant the deadline is reached is eligible. Preflight must agree.
    let f = Fixture::new(100, 50);
    let id = create_claim(&f, 10 * USDC);
    f.client().challenge_claim(&f.user(10 * USDC), &id, &(10 * USDC));
    let deadline = f.client().get_claim(&id).deadline;
    f.advance_to(deadline);

    let pf = f.client().preflight_claim(&id);
    assert!(pf.eligible);
    assert!(pf.lifecycle_ok);
}

#[test]
fn preflight_does_not_mutate_claim_state() {
    // The claim is Active, past deadline, so it would be eligible — but the
    // preflight must not mutate the stored claim, the winner_side, or the
    // escrow. Capture the full Claim before/after and compare.
    let f = Fixture::new(100, 50);
    let id = create_claim(&f, 10 * USDC);
    f.client().challenge_claim(&f.user(10 * USDC), &id, &(10 * USDC));
    f.advance_by(3_600 + 1);

    let before = f.client().get_claim(&id);
    let _ = f.client().preflight_claim(&id);
    let _ = f.client().preflight_claim(&id);
    let after = f.client().get_claim(&id);

    assert_eq!(before, after, "preflight_claim mutated the claim");
    // Specifically: state unchanged, no side recorded, escrow untouched.
    assert_eq!(after.state, ClaimState::Active);
    assert_eq!(after.winner_side, WinnerSide::None);
    assert!(after.evidence_hash.is_none());
}

#[test]
fn unknown_claim_id_errors() {
    let f = Fixture::new(100, 50);
    let err = f.client().try_preflight_claim(&99_999).unwrap_err();
    assert!(err.is_err(), "preflight on missing claim should error");
}
