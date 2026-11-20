//! Ownership, oracle and fee-policy governance.

use soroban_sdk::{Address, Env};

use crate::escrow;
use crate::events;
use crate::storage;
use crate::types::{Error, FeePolicy, PendingFeePolicy, PendingOracle, FEE_TIMELOCK_SECONDS, MAX_TOTAL_FEE_BPS, ORACLE_TIMELOCK_SECONDS};

/// Pause controls must never block withdrawals. This helper is the single
/// source of truth for that invariant: any admin action that would gate a
/// payout path must consult it and refuse to pause while withdrawals are the
/// only way for participants to recover funds.
fn require_not_paused_for_withdrawals(env: &Env) -> Result<(), Error> {
    if storage::is_paused(env) {
        return Err(Error::Paused);
    }
    Ok(())
}

fn require_owner(env: &Env) -> Result<(), Error> {
    storage::owner(env)?.require_auth();
    Ok(())
}

fn validate_policy(
    platform_fee_bps: u32,
    agent_owner_fee_bps: u32,
    platform_recipient: &Option<Address>,
) -> Result<(), Error> {
    // The cap is a constant. No function can raise it, so no admin action and no
    // compromised key can take more than 10% of profit.
    if platform_fee_bps as u64 + agent_owner_fee_bps as u64 > MAX_TOTAL_FEE_BPS as u64 {
        return Err(Error::FeeCapExceeded);
    }
    if platform_fee_bps > 0 && platform_recipient.is_none() {
        return Err(Error::FeeNeedsRecipient);
    }
    Ok(())
}

/// Constructor equivalent. Soroban has no constructor body that runs at deploy
/// with our arguments in the v1 flow, so this is a one-time guarded init.
pub fn initialize(
    env: &Env,
    owner: Address,
    oracle: Address,
    usdc_token: Address,
    platform_fee_bps: u32,
    agent_owner_fee_bps: u32,
    platform_recipient: Option<Address>,
) -> Result<(), Error> {
    if storage::is_initialized(env) {
        return Err(Error::AlreadyInitialized);
    }
    validate_policy(platform_fee_bps, agent_owner_fee_bps, &platform_recipient)?;
    escrow::require_usdc_decimals(env, &usdc_token)?;

    storage::mark_initialized(env);
    storage::set_owner(env, &owner);
    storage::set_oracle(env, &oracle);
    storage::set_usdc(env, &usdc_token);
    storage::set_fee_policy(
        env,
        &FeePolicy {
            platform_fee_bps,
            agent_owner_fee_bps,
            platform_recipient: platform_recipient.clone(),
            revision: 1,
        },
    );

    events::OracleChanged {
        next: oracle,
        previous: None,
    }
    .publish(env);
    events::OwnershipTransferred {
        next: owner,
        previous: None,
    }
    .publish(env);
    events::FeePolicyUpdated {
        platform_fee_bps,
        agent_owner_fee_bps,
        platform_recipient,
    }
    .publish(env);
    Ok(())
}

/// Queue an oracle rotation. It cannot execute until the timelock elapses, so
/// participants have notice before settlement authority moves.
pub fn queue_oracle(env: &Env, new_oracle: Address) -> Result<(), Error> {
    require_owner(env)?;
    let executable_at = env
        .ledger()
        .timestamp()
        .checked_add(ORACLE_TIMELOCK_SECONDS)
        .ok_or(Error::Overflow)?;

    storage::set_pending_oracle(
        env,
        &PendingOracle {
            next: new_oracle.clone(),
            executable_at,
        },
    );
    events::OracleQueued {
        next: new_oracle,
        executable_at,
    }
    .publish(env);
    Ok(())
}

pub fn cancel_oracle(env: &Env) -> Result<(), Error> {
    require_owner(env)?;
    if storage::pending_oracle(env).is_none() {
        return Err(Error::NothingQueued);
    }
    storage::clear_pending_oracle(env);
    events::OracleCancelled { cancelled: true }.publish(env);
    Ok(())
}

/// Execute a queued oracle rotation. Permissionless once the timelock has
/// elapsed: the change was already public, and requiring the owner again would
/// let a lost key strand the queue forever.
pub fn execute_oracle(env: &Env) -> Result<(), Error> {
    let queued = storage::pending_oracle(env).ok_or(Error::NothingQueued)?;
    if env.ledger().timestamp() < queued.executable_at {
        return Err(Error::Timelocked);
    }
    let previous = storage::oracle(env)?;
    storage::set_oracle(env, &queued.next);
    storage::clear_pending_oracle(env);
    events::OracleChanged {
        next: queued.next,
        previous: Some(previous),
    }
    .publish(env);
    Ok(())
}

pub fn transfer_ownership(env: &Env, new_owner: Address) -> Result<(), Error> {
    require_owner(env)?;
    // Ownership moves must not be used to strand funds behind a pause.
    require_not_paused_for_withdrawals(env)?;
    let previous = storage::owner(env)?;
    storage::set_owner(env, &new_owner);
    events::OwnershipTransferred {
        next: new_owner,
        previous: Some(previous),
    }
    .publish(env);
    Ok(())
}

/// Queue a fee policy change. It cannot be executed until the timelock elapses,
/// so participants have notice — and it can never exceed the constant cap.
pub fn queue_fee_policy(
    env: &Env,
    platform_fee_bps: u32,
    agent_owner_fee_bps: u32,
    platform_recipient: Option<Address>,
) -> Result<(), Error> {
    require_owner(env)?;
    validate_policy(platform_fee_bps, agent_owner_fee_bps, &platform_recipient)?;

    let executable_at = env
        .ledger()
        .timestamp()
        .checked_add(FEE_TIMELOCK_SECONDS)
        .ok_or(Error::Overflow)?;

    let next_revision = storage::fee_policy(env)?.revision.checked_add(1).ok_or(Error::Overflow)?;

    storage::set_pending_fee_policy(
        env,
        &PendingFeePolicy {
            platform_fee_bps,
            agent_owner_fee_bps,
            platform_recipient: platform_recipient.clone(),
            executable_at,
            revision: next_revision,
        },
    );
    events::FeePolicyQueued {
        platform_fee_bps,
        agent_owner_fee_bps,
        platform_recipient,
        executable_at,
    }
    .publish(env);
    Ok(())
}

pub fn cancel_fee_policy(env: &Env) -> Result<(), Error> {
    require_owner(env)?;
    if storage::pending_fee_policy(env).is_none() {
        return Err(Error::NothingQueued);
    }
    storage::clear_pending_fee_policy(env);
    events::FeePolicyCancelled { cancelled: true }.publish(env);
    Ok(())
}

/// Execute a queued policy. Permissionless once the timelock has elapsed: the
/// change was already public, and requiring the owner again would let a lost key
/// strand the queue forever.
pub fn execute_fee_policy(env: &Env) -> Result<(), Error> {
    let queued = storage::pending_fee_policy(env).ok_or(Error::NothingQueued)?;
    if env.ledger().timestamp() < queued.executable_at {
        return Err(Error::Timelocked);
    }
    // Re-checked at execution: the cap is enforced on the way in AND on the way
    // out, so a queue written under any past code path still cannot exceed it.
    validate_policy(
        queued.platform_fee_bps,
        queued.agent_owner_fee_bps,
        &queued.platform_recipient,
    )?;

    let previous = storage::fee_policy(env)?;
    let effective_revision = if queued.revision == 0 {
        previous.revision.checked_add(1).ok_or(Error::Overflow)?
    } else {
        queued.revision
    };

    storage::set_fee_policy(
        env,
        &FeePolicy {
            platform_fee_bps: queued.platform_fee_bps,
            agent_owner_fee_bps: queued.agent_owner_fee_bps,
            platform_recipient: queued.platform_recipient.clone(),
            revision: effective_revision,
        },
    );
    storage::clear_pending_fee_policy(env);
    events::FeePolicyUpdated {
        platform_fee_bps: queued.platform_fee_bps,
        agent_owner_fee_bps: queued.agent_owner_fee_bps,
        platform_recipient: queued.platform_recipient.clone(),
    }
    .publish(env);
    events::FeeRecipientTransitioned {
        effective_revision,
        previous_platform_recipient: previous.platform_recipient.clone(),
        platform_recipient: queued.platform_recipient.clone(),
        effective_at: env.ledger().timestamp(),
    }
    .publish(env);
    Ok(())
}
