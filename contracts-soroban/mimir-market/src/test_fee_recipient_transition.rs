#![cfg(test)]
//! Fee-recipient transition receipts: effective policy revision, predecessor
//! identity, and preservation of accrued liabilities across a rotation.

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use crate::test_common::{Fixture, USDC};
use crate::types::{Error, WinnerSide, FEE_TIMELOCK_SECONDS};

#[test]
fn executing_a_rotation_bumps_the_policy_revision_and_records_the_predecessor() {
    let f = Fixture::new(1_000, 0);
    assert_eq!(f.client().get_fee_policy().revision, 1);

    let new_recipient = Address::generate(&f.env);
    f.client()
        .queue_fee_policy(&1_000, &0, &Some(new_recipient.clone()));
    let queued = f.client().get_pending_fee_policy().unwrap();
    assert_eq!(queued.revision, 2);

    f.advance_by(FEE_TIMELOCK_SECONDS);
    f.client().execute_fee_policy();

    let policy = f.client().get_fee_policy();
    assert_eq!(policy.revision, 2);
    assert_eq!(policy.platform_recipient, Some(new_recipient));
}

#[test]
fn a_rotation_does_not_obscure_accrued_liabilities_of_the_predecessor() {
    let f = Fixture::new(1_000, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(10 * USDC), &None);
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("creator"),
        &90,
        &f.zero_hash(),
    );

    let predecessor = f.platform.clone();
    let expected = USDC; // 10% of 10 USDC profit
    assert_eq!(f.client().get_accrued_fees(&predecessor), expected);

    let new_recipient = Address::generate(&f.env);
    f.client()
        .queue_fee_policy(&1_000, &0, &Some(new_recipient.clone()));
    f.advance_by(FEE_TIMELOCK_SECONDS);
    f.client().execute_fee_policy();

    // The rotation must not touch the predecessor's accrued balance.
    assert_eq!(f.client().get_accrued_fees(&predecessor), expected);
    assert_eq!(f.client().get_accrued_fees(&new_recipient), 0);
    assert_eq!(f.client().get_fee_policy().platform_recipient, Some(new_recipient));
}

#[test]
fn executing_before_the_timelock_leaves_the_recipient_and_revision_unchanged() {
    let f = Fixture::new(1_000, 0);
    let predecessor = f.platform.clone();

    let new_recipient = Address::generate(&f.env);
    f.client()
        .queue_fee_policy(&1_000, &0, &Some(new_recipient.clone()));

    let err = f.client().try_execute_fee_policy().unwrap_err().unwrap();
    assert_eq!(err, Error::Timelocked);

    let policy = f.client().get_fee_policy();
    assert_eq!(policy.revision, 1);
    assert_eq!(policy.platform_recipient, Some(predecessor));
    assert!(f.client().get_pending_fee_policy().is_some());
}
