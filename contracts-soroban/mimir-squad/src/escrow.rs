//! USDC custody for the squad pool.

use soroban_sdk::{token, Address, Env};

use crate::types::{Error, USDC_DECIMALS};

/// Refuse an escrow token whose scale is not [`USDC_DECIMALS`]. A token that
/// cannot answer `decimals()` is not a SEP-41 token, so it is rejected as
/// unsupported rather than trapping.
pub fn require_usdc_decimals(env: &Env, usdc: &Address) -> Result<(), Error> {
    match token::TokenClient::new(env, usdc).try_decimals() {
        Ok(Ok(decimals)) if decimals == USDC_DECIMALS => Ok(()),
        Ok(Ok(_)) => Err(Error::UnsupportedDecimals),
        _ => Err(Error::UnsupportedToken),
    }
}

/// Move `amount` from `from` into contract escrow, asserting the escrow balance
/// moved by exactly that much. Fee-on-transfer and rebasing assets would break
/// pool accounting, so they are rejected at the door.
pub fn pull(env: &Env, usdc: &Address, from: &Address, amount: i128) -> Result<(), Error> {
    let client = token::TokenClient::new(env, usdc);
    let here = env.current_contract_address();
    let before = client.balance(&here);
    client.transfer(from, &here, &amount);
    if client.balance(&here) != before + amount {
        return Err(Error::UnsupportedToken);
    }
    Ok(())
}

/// Push a payout. Squad settlement is already pull-based per participant, so a
/// failure here affects only the caller and is allowed to propagate — matching
/// `require(usdc.transfer(...))` in the Solidity.
pub fn push(env: &Env, usdc: &Address, to: &Address, amount: i128) {
    token::TokenClient::new(env, usdc).transfer(&env.current_contract_address(), to, &amount);
}

/// Push a payout without letting the token abort the caller.
///
/// A deauthorized (frozen) trustline makes the token trap, which under
/// [`push`] reverts the whole invocation — a winner with a frozen trustline
/// could not settle at all. This variant surfaces the same failure as `false`,
/// so the caller can keep the accounting it has already applied and park the
/// amount instead of unwinding it. The failed sub-call changes nothing: the
/// funds stay in escrow.
pub fn try_push(env: &Env, usdc: &Address, to: &Address, amount: i128) -> bool {
    let client = token::TokenClient::new(env, usdc);
    // `try_*` returns the sub-call's own error shape wrapped in an invocation
    // result; only `Ok(Ok(()))` means the transfer completed. A SEP-41 token
    // that reports failure through its error type and a Stellar Asset Contract
    // that traps both land outside it.
    matches!(
        client.try_transfer(&env.current_contract_address(), to, &amount),
        Ok(Ok(()))
    )
}

pub fn balance(env: &Env, usdc: &Address) -> i128 {
    token::TokenClient::new(env, usdc).balance(&env.current_contract_address())
}

/// Read-only escrow view for settlement readiness: returns the escrow balance
/// without any state mutation, so callers can report withdrawal availability
/// independently of resolution.
pub fn readable_balance(env: &Env, usdc: &Address) -> i128 {
    balance(env, usdc)
}
