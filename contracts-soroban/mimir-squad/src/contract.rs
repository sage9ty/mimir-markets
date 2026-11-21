//! Public contract surface. Bodies live in `pool`; this file is the single
//! `#[contractimpl]` block plus the read-only views.

use soroban_sdk::{contract, contractimpl, Address, Env, String, Vec};

use crate::escrow;
use crate::pool;
use crate::storage;
use crate::types::{
    ClaimResult, Error, Market, PendingOracle, SquadLimits, MAX_BATCH_SIZE, MAX_DURATION,
    MAX_FEE_BPS, MAX_QUESTION_BYTES, MIN_DURATION,
};

#[contract]
pub struct MimirSquad;

#[contractimpl]
impl MimirSquad {
    /// Constructor equivalent, callable once.
    pub fn initialize(
        env: Env,
        usdc: Address,
        oracle: Address,
        fee_recipient: Address,
    ) -> Result<(), Error> {
        pool::initialize(&env, usdc, oracle, fee_recipient)
    }

    pub fn create_market(
        env: Env,
        captain: Address,
        question: String,
        deadline: u64,
        fee_bps: u32,
    ) -> Result<u64, Error> {
        pool::create_market(&env, captain, question, deadline, fee_bps)
    }

    pub fn deposit(
        env: Env,
        participant: Address,
        market_id: u64,
        side: u32,
        amount: i128,
    ) -> Result<(), Error> {
        pool::deposit(&env, participant, market_id, side, amount)
    }

    pub fn withdraw_before_deadline(
        env: Env,
        participant: Address,
        market_id: u64,
        side: u32,
        amount: i128,
    ) -> Result<(), Error> {
        pool::withdraw_before_deadline(&env, participant, market_id, side, amount)
    }

    pub fn transition_deadline(env: Env, market_id: u64) -> Result<(), Error> {
        pool::transition_deadline(&env, market_id)
    }

    pub fn resolve(env: Env, market_id: u64, result: u32) -> Result<(), Error> {
        pool::resolve(&env, market_id, result)
    }

    /// Captain-initiated market cancellation, only before the deadline. Sets the
    /// market as resolved with result=RESULT_CANCELLED, allowing all depositors
    /// to claim full refunds via claim(). No fees are charged on cancellation.
    pub fn cancel_market(env: Env, market_id: u64) -> Result<(), Error> {
        pool::cancel_market(&env, market_id)
    }

    /// Pull-based payout. Solidity used `msg.sender`; Soroban has no equivalent
    /// for a top-level call, so the claimant is an explicit argument that must
    /// authorize. Returns the net amount transferred.
    pub fn claim(env: Env, participant: Address, market_id: u64, side: u32) -> Result<i128, Error> {
        pool::claim(&env, participant, market_id, side)
    }

    pub fn claim_fees(env: Env) -> Result<i128, Error> {
        pool::claim_fees(&env)
    }

    /// Pause or unpause the contract. Pausing must never block withdrawals,
    /// claims, or parked-payout retries; only new deposits and market creation
    /// are gated by the pause flag.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        pool::set_paused(&env, paused)
    }

    pub fn is_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    /// Retry a payout that [`Self::claim`] parked because the transfer trapped
    /// (frozen or deauthorized trustline). Returns the amount moved, or `0`
    /// when nothing is parked.
    pub fn claim_parked_payout(
        env: Env,
        participant: Address,
        market_id: u64,
        side: u32,
    ) -> Result<i128, Error> {
        pool::claim_parked_payout(&env, participant, market_id, side)
    }

    // ── Views ────────────────────────────────────────────────────────────────

    pub fn get_market(env: Env, market_id: u64) -> Result<Market, Error> {
        storage::get_market(&env, market_id)
    }

    pub fn get_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    pub fn get_markets_batch(
        env: Env,
        ids: Vec<u64>,
    ) -> Result<Vec<Option<Market>>, Error> {
        if ids.len() > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }
        if !storage::is_initialized(&env) {
            return Err(Error::NotInitialized);
        }

        let mut results: Vec<Option<Market>> = Vec::new(&env);
        for id in ids.iter() {
            results.push_back(storage::get_market_opt(&env, id));
        }
        Ok(results)
    }

    pub fn get_pause_status(env: Env) -> bool {
        storage::is_paused(&env)
    }

    pub fn get_deposit(env: Env, market_id: u64, side: u32, who: Address) -> i128 {
        storage::deposit_of(&env, market_id, side, &who)
    }

    pub fn has_claimed(env: Env, market_id: u64, side: u32, who: Address) -> bool {
        storage::has_claimed(&env, market_id, side, &who)
    }

    pub fn preview_claim(
        env: Env,
        market_id: u64,
        side: u32,
        who: Address,
    ) -> Result<ClaimResult, Error> {
        pool::preview_claim(&env, market_id, side, &who)
    }

    pub fn get_market_count(env: Env) -> u64 {
        storage::market_count(&env)
    }

    pub fn get_accrued_fees(env: Env) -> i128 {
        storage::accrued_fees(&env)
    }

    /// Distinct claim status for a wallet on one side of a market.
    ///
    /// Returns `(claimable, already_claimed)` as separate fields so callers
    /// never have to infer state from a zero amount. A wallet with no position
    /// returns `(0, false)` through this read-only path without erroring.
    pub fn get_claim_status(
        env: Env,
        market_id: u64,
        side: u32,
        who: Address,
    ) -> Result<(i128, bool), Error> {
        let already_claimed = storage::has_claimed(&env, market_id, side, &who);
        let claimable = match pool::preview_claim(&env, market_id, side, &who) {
            Ok(preview) => preview.amount,
            Err(Error::NoPosition) => 0,
            Err(e) => return Err(e),
        };
        Ok((claimable, already_claimed))
    }

    /// Payout settled in the ledger but not delivered to one winner, because
    /// the token transfer trapped. `claim_parked_payout` moves it.
    pub fn parked_payout(env: Env, market_id: u64, side: u32, who: Address) -> i128 {
        storage::payout_of(&env, market_id, side, &who)
    }

    pub fn get_usdc(env: Env) -> Result<Address, Error> {
        storage::usdc(&env)
    }

    pub fn get_oracle(env: Env) -> Result<Address, Error> {
        storage::oracle(&env)
    }

    /// Queue an oracle rotation; the current oracle must authorize.
    pub fn queue_oracle(env: Env, new_oracle: Address) -> Result<(), Error> {
        pool::queue_oracle(&env, new_oracle)
    }

    /// Drop a queued oracle rotation; the current oracle must authorize.
    pub fn cancel_oracle(env: Env) -> Result<(), Error> {
        pool::cancel_oracle(&env)
    }

    /// Apply a queued oracle rotation once its timelock has elapsed.
    pub fn execute_oracle(env: Env) -> Result<(), Error> {
        pool::execute_oracle(&env)
    }

    pub fn get_pending_oracle(env: Env) -> Option<PendingOracle> {
        storage::pending_oracle(&env)
    }

    /// Queue a fee recipient rotation; the current fee recipient must authorize.
    pub fn queue_fee_recipient(env: Env, new_recipient: Address) -> Result<(), Error> {
        pool::queue_fee_recipient(&env, new_recipient)
    }

    /// Drop a queued fee recipient rotation; the current fee recipient must authorize.
    pub fn cancel_fee_recipient(env: Env) -> Result<(), Error> {
        pool::cancel_fee_recipient(&env)
    }

    /// Apply a queued fee recipient rotation once its timelock has elapsed.
    pub fn execute_fee_recipient(env: Env) -> Result<(), Error> {
        pool::execute_fee_recipient(&env)
    }

    pub fn get_fee_recipient(env: Env) -> Result<Address, Error> {
        storage::fee_recipient(&env)
    }

    pub fn get_pending_fee_recipient(env: Env) -> Option<Address> {
        storage::pending_fee_recipient(&env)
    }

    pub fn get_escrow_balance(env: Env) -> Result<i128, Error> {
        let usdc = storage::usdc(&env)?;
        Ok(escrow::balance(&env, &usdc))
    }

    /// Read-only view exposing the protocol limits enforced in `create_market`.
    pub fn get_limits(_env: Env) -> SquadLimits {
        SquadLimits {
            max_fee_bps: MAX_FEE_BPS,
            min_duration: MIN_DURATION,
            max_duration: MAX_DURATION,
            max_question_bytes: MAX_QUESTION_BYTES,
        }
    }

    pub fn get_paused_flag(env: Env) -> bool {
        storage::is_paused(&env)
    }

    /// Read-only settlement readiness for a market. Never mutates state.
    /// `withdrawal_open` is reported independently of `resolved`, so callers can
    /// see whether pre-deadline withdrawals remain available. Unknown markets
    /// return `MarketNotFound` rather than a partial view.
    pub fn get_settlement_readiness(
        env: Env,
        market_id: u64,
    ) -> Result<SettlementReadiness, Error> {
        pool::settlement_readiness(&env, market_id)
    }
}