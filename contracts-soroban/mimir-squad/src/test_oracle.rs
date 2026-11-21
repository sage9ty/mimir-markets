#![cfg(test)]
//! Oracle rotation timelock: queue, cancel, execute, auth, and failure paths.

extern crate std;

use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{Address, IntoVal, InvokeError};

use crate::test_common::{Fixture, USDC};
use crate::types::{Error, ORACLE_TIMELOCK_SECONDS, SIDE_A};

#[test]
fn oracle_rotation_is_oracle_gated_and_timelocked() {
    let f = Fixture::new();
    let new_oracle = Address::generate(&f.env);
    let previous = f.client().get_oracle();

    f.env.set_auths(&[]);
    assert_eq!(
        f.client().try_queue_oracle(&new_oracle),
        Err(Err(InvokeError::Abort))
    );

    f.env.mock_all_auths();
    f.client().queue_oracle(&new_oracle);
    let queued = f.client().get_pending_oracle().unwrap();
    assert_eq!(queued.next, new_oracle);
    assert_eq!(queued.executable_at, f.now() + ORACLE_TIMELOCK_SECONDS);
    assert_eq!(f.client().get_oracle(), previous);

    assert_eq!(f.client().try_execute_oracle(), Err(Ok(Error::Timelocked)));

    f.advance_to(queued.executable_at - 1);
    assert_eq!(f.client().try_execute_oracle(), Err(Ok(Error::Timelocked)));
    assert_eq!(f.client().get_oracle(), previous);
    assert_eq!(f.client().get_pending_oracle(), Some(queued));

    f.advance_by(1);
    f.client().execute_oracle();
    assert_eq!(f.client().get_oracle(), new_oracle);
    assert!(f.client().get_pending_oracle().is_none());
    assert_eq!(
        f.client().try_execute_oracle(),
        Err(Ok(Error::NothingQueued))
    );
    assert_eq!(
        f.client().try_cancel_oracle(),
        Err(Ok(Error::NothingQueued))
    );
}

#[test]
fn oracle_rotation_execution_is_permissionless_after_timelock() {
    let f = Fixture::new();
    let new_oracle = Address::generate(&f.env);

    f.client().queue_oracle(&new_oracle);
    f.advance_by(ORACLE_TIMELOCK_SECONDS);

    f.env.set_auths(&[]);
    f.client().execute_oracle();
    assert_eq!(f.client().get_oracle(), new_oracle);
    assert!(f.client().get_pending_oracle().is_none());
}

#[test]
fn settlement_readiness_reports_unmet_prerequisites_without_mutation() {
    let f = Fixture::new();
    let captain = f.user(0);
    let participant = f.user(USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&participant, &id, &SIDE_A, &USDC);

    let before = f.client().get_market(&id);
    let ready = f.client().settlement_readiness(&id);
    assert!(!ready.resolved);
    assert!(!ready.oracle_ready);
    assert_eq!(f.client().get_market(&id), before);
    assert!(f.client().get_pending_oracle().is_none());
}

#[test]
fn executing_or_cancelling_without_a_queued_oracle_is_rejected() {
    let f = Fixture::new();

    assert!(f.client().get_pending_oracle().is_none());
    assert_eq!(
        f.client().try_execute_oracle(),
        Err(Ok(Error::NothingQueued))
    );
    assert_eq!(
        f.client().try_cancel_oracle(),
        Err(Ok(Error::NothingQueued))
    );
    assert_eq!(f.client().get_oracle(), f.oracle);
    assert!(f.client().get_pending_oracle().is_none());
}

#[test]
fn cancelling_oracle_rotation_clears_the_queue() {
    let f = Fixture::new();
    let new_oracle = Address::generate(&f.env);

    f.client().queue_oracle(&new_oracle);
    f.client().cancel_oracle();
    assert!(f.client().get_pending_oracle().is_none());
    assert_eq!(f.client().get_oracle(), f.oracle);
    assert_eq!(
        f.client().try_cancel_oracle(),
        Err(Ok(Error::NothingQueued))
    );

    f.advance_by(ORACLE_TIMELOCK_SECONDS * 2);
    assert_eq!(
        f.client().try_execute_oracle(),
        Err(Ok(Error::NothingQueued))
    );
    assert_eq!(f.client().get_oracle(), f.oracle);
    assert!(f.client().get_pending_oracle().is_none());
}

#[test]
fn requeuing_an_oracle_replaces_the_pending_entry_and_resets_the_timelock() {
    let f = Fixture::new();
    let first_oracle = Address::generate(&f.env);
    let replacement_oracle = Address::generate(&f.env);

    f.client().queue_oracle(&first_oracle);
    let first = f.client().get_pending_oracle().unwrap();

    f.advance_by(ORACLE_TIMELOCK_SECONDS / 2);
    f.client().queue_oracle(&replacement_oracle);
    let replacement = f.client().get_pending_oracle().unwrap();
    assert_eq!(replacement.next, replacement_oracle);
    assert_eq!(replacement.executable_at, f.now() + ORACLE_TIMELOCK_SECONDS);
    assert!(replacement.executable_at > first.executable_at);
    assert_eq!(f.client().get_oracle(), f.oracle);

    // The original rotation's deadline no longer unlocks execution.
    f.advance_to(first.executable_at);
    assert_eq!(f.client().try_execute_oracle(), Err(Ok(Error::Timelocked)));
    assert_eq!(f.client().get_oracle(), f.oracle);
    assert_eq!(f.client().get_pending_oracle(), Some(replacement.clone()));

    f.advance_to(replacement.executable_at - 1);
    assert_eq!(f.client().try_execute_oracle(), Err(Ok(Error::Timelocked)));
    assert_eq!(f.client().get_pending_oracle(), Some(replacement));

    f.advance_by(1);
    f.client().execute_oracle();
    assert_eq!(f.client().get_oracle(), replacement_oracle);
    assert!(f.client().get_pending_oracle().is_none());
}

#[test]
fn rotating_the_oracle_transfers_resolution_authority() {
    let f = Fixture::new();
    let new_oracle = Address::generate(&f.env);
    let captain = f.user(0);
    let participant = f.user(USDC);
    let id = f.market(&captain, 0);
    f.client().deposit(&participant, &id, &SIDE_A, &USDC);

    f.client().queue_oracle(&new_oracle);
    let queued = f.client().get_pending_oracle().unwrap();
    f.advance_to(queued.executable_at);
    f.client().execute_oracle();
    assert_eq!(f.client().get_oracle(), new_oracle);
    assert!(f.client().get_pending_oracle().is_none());

    let resolve = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "resolve",
        args: (id, SIDE_A).into_val(&f.env),
        sub_invokes: &[],
    };
    f.env.mock_auths(&[MockAuth {
        address: &f.oracle,
        invoke: &resolve,
    }]);
    assert_eq!(
        f.client().try_resolve(&id, &SIDE_A),
        Err(Err(InvokeError::Abort))
    );
    assert!(!f.client().get_market(&id).resolved);

    f.env.mock_auths(&[MockAuth {
        address: &new_oracle,
        invoke: &resolve,
    }]);
    f.client().resolve(&id, &SIDE_A);
    let market = f.client().get_market(&id);
    assert!(market.resolved);
    assert_eq!(market.result, SIDE_A);
}
