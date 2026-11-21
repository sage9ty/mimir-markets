//! Public contract surface. Bodies live in `admin`, `claims` and `resolve`; this
//! file is the single `#[contractimpl]` block plus the read-only views.

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, String, Vec};

use crate::admin;
use crate::claims;
use crate::escrow;
use crate::resolve;
use crate::storage;
use crate::types::{
    Challenger, ChallengerPage, Claim, ClaimFeeView, CreateParams, Error, FeePolicy,
    MarketConfig, PayoutQuote, PendingFeePolicy, PendingOracle, PlatformStats, Verdict,
    WinnerSide, MAX_BATCH_SIZE,
};

#[contract]
pub struct MimirMarket;

#[contractimpl]
impl MimirMarket {
    // ── Init & admin ─────────────────────────────────────────────────────────

    /// Constructor equivalent, callable once.
    pub fn initialize(
        env: Env,
        owner: Address,
        oracle: Address,
        usdc_token: Address,
        platform_fee_bps: u32,
        agent_owner_fee_bps: u32,
        platform_recipient: Option<Address>,
    ) -> Result<(), Error> {
        admin::initialize(
            &env,
            owner,
            oracle,
            usdc_token,
            platform_fee_bps,
            agent_owner_fee_bps,
            platform_recipient,
        )
    }

    pub fn queue_oracle(env: Env, new_oracle: Address) -> Result<(), Error> {
        admin::queue_oracle(&env, new_oracle)
    }

    pub fn cancel_oracle(env: Env) -> Result<(), Error> {
        admin::cancel_oracle(&env)
    }

    /// Permissionless once the timelock has elapsed.
    pub fn execute_oracle(env: Env) -> Result<(), Error> {
        admin::execute_oracle(&env)
    }

    pub fn transfer_ownership(env: Env, new_owner: Address) -> Result<(), Error> {
        admin::transfer_ownership(&env, new_owner)
    }

    pub fn queue_fee_policy(
        env: Env,
        platform_fee_bps: u32,
        agent_owner_fee_bps: u32,
        platform_recipient: Option<Address>,
    ) -> Result<(), Error> {
        admin::queue_fee_policy(
            &env,
            platform_fee_bps,
            agent_owner_fee_bps,
            platform_recipient,
        )
    }

    pub fn cancel_fee_policy(env: Env) -> Result<(), Error> {
        admin::cancel_fee_policy(&env)
    }

    /// Permissionless once the timelock has elapsed.
    pub fn execute_fee_policy(env: Env) -> Result<(), Error> {
        admin::execute_fee_policy(&env)
    }

    // ── Claim lifecycle ──────────────────────────────────────────────────────

    pub fn create_claim(env: Env, creator: Address, params: CreateParams) -> Result<u64, Error> {
        claims::create_claim(&env, creator, params)
    }

    pub fn challenge_claim(
        env: Env,
        challenger: Address,
        claim_id: u64,
        stake_amount: i128,
        invite_key: Option<String>,
    ) -> Result<(), Error> {
        claims::challenge_claim(&env, challenger, claim_id, stake_amount, invite_key)
    }

    pub fn resolve_claim(
        env: Env,
        claim_id: u64,
        winner_side: WinnerSide,
        summary: String,
        confidence: u32,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        resolve::resolve_claim(&env, claim_id, winner_side, summary, confidence, evidence_hash)
    }

    /// Versioned verdict entry point. Identical settlement semantics to
    /// `resolve_claim`, but the oracle submits a `Verdict` carrying its explicit
    /// encoding version. Unknown versions are refused with
    /// `Error::UnsupportedVerdictVersion` and leave the claim untouched.
    pub fn resolve_claim_versioned(
        env: Env,
        claim_id: u64,
        verdict: Verdict,
        summary: String,
        confidence: u32,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        resolve::resolve_claim_versioned(
            &env,
            claim_id,
            &verdict,
            summary,
            confidence,
            evidence_hash,
        )
    }

    
    pub fn transition_deadline(env: Env, claim_id: u64) -> Result<(), Error> {
        claims::transition_deadline(&env, claim_id)
    }

    pub fn cancel_claim(env: Env, claim_id: u64) -> Result<(), Error> {
        claims::cancel_claim(&env, claim_id)
    }

    /// Settle one challenger's winning or refunded position. Callable once per
    /// challenger after resolution, and O(1) in the number of challengers, so a
    /// market filled to MAX_CHALLENGERS can always be paid out in full.
    ///
    /// `resolve_claim` deliberately does NOT loop over challengers: a Stellar
    /// transaction is capped on its ledger-entry footprint, and paying ~100
    /// challengers at once does not fit. Returns the net amount credited.
    pub fn claim_challenger_payout(
        env: Env,
        challenger: Address,
        claim_id: u64,
    ) -> Result<i128, Error> {
        resolve::claim_challenger_payout(&env, challenger, claim_id)
    }

    // ── Pull payments ────────────────────────────────────────────────────────

    /// Solidity used `msg.sender`; Soroban has no equivalent for a top-level
    /// call, so the beneficiary is an explicit argument that must authorize.
    ///
    /// Withdrawals are intentionally NOT gated by the pause flag: pause
    /// controls may halt new claims, challenges, and resolutions, but must
    /// never block a funded user from pulling their own balance. This keeps
    /// contract-first accounting intact — a paused market still owes its
    /// users their escrowed funds, and the only safe way to honor that is to
    /// let them withdraw.
    pub fn withdraw(env: Env, who: Address) -> Result<i128, Error> {
        resolve::withdraw(&env, who)
    }

    pub fn claim_fees(env: Env, who: Address) -> Result<i128, Error> {
        resolve::claim_fees(&env, who)
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// Read-only preflight for a claim resolution (#779).
    ///
    /// Returns structural eligibility (lifecycle + constraints) separately
    /// from the "a signed submission will still need the oracle's auth"
    /// signal. **Never mutates state**: no `require_auth`, no storage write,
    /// no TTL bump, no event. Callers that want to know whether a later
    /// `resolve_claim` *will succeed* must still treat a successful
    /// preflight as necessary, not sufficient — `preflight_claim` says
    /// nothing about the verdict the oracle would submit.
    pub fn preflight_claim(env: Env, claim_id: u64) -> Result<ClaimPreflight, Error> {
        resolve::preflight_claim(&env, claim_id)
    }

    pub fn get_claim(env: Env, claim_id: u64) -> Result<Claim, Error> {
        storage::get_claim(&env, claim_id)
    }

    /// Paginated list of claim ids created by `creator`, in creation order.
    ///
    /// Returns up to `limit` ids starting at `offset` (0-based) together with
    /// the creator's total claim count, so callers can detect the last page
    /// without an extra empty fetch. An `offset` beyond the end of the index
    /// returns an empty `Vec` with `total` set correctly.
    ///
    /// The per-creator index is appended in `create_claim` and stored as
    /// bounded pages of ids, so this read costs O(limit) rather than
    /// O(total claims). TTL is extended on read like other persistent views.
    pub fn get_creator_claims(
        env: Env,
        creator: Address,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<u64>, u32), Error> {
        if !storage::is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        Ok(storage::creator_claims_page(&env, &creator, offset, limit))
    }

    /// The claim's verdict with its explicit encoding version.
    ///
    /// Refuses with `Error::UnsupportedVerdictVersion` if the stored verdict was
    /// written by an encoding this contract does not understand, and with
    /// `Error::ClaimNotResolved` if the claim has not been resolved.
    pub fn get_verdict(env: Env, claim_id: u64) -> Result<Verdict, Error> {
        resolve::get_verdict(&env, claim_id)
    }

    /// Convenience view returning only the decoded verdict side.
    pub fn get_verdict_side(env: Env, claim_id: u64) -> Result<WinnerSide, Error> {
        resolve::get_verdict(&env, claim_id)?.decode()
    }

    /// Whether the contract is currently paused. Pause halts new claims,
    /// challenges, and resolutions, but never blocks `withdraw` or
    /// `claim_fees` — see those entry points for the invariant.
    pub fn is_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    /// Batch-read up to [`MAX_BATCH_SIZE`] claims in one simulated call.
    ///
    /// Returns a `Vec<Option<Claim>>` whose length equals `ids.len()`. Each slot
    /// holds `Some(claim)` when the id exists, or `None` when it does not. The
    /// slot positions mirror the input positions exactly, so callers can zip the
    /// result against their id list without any bookkeeping:
    ///
    /// ```text
    /// ids    = [1, 999, 3]
    /// result = [Some(claim_1), None, Some(claim_3)]
    /// ```
    ///
    /// # Behavior guarantees
    ///
    /// - **Pure read.** No money, no auth, no state mutation. Safe to call from
    ///   any context, including unsigned simulation.
    /// - **Position-stable.** The output length always equals the input length.
    /// - **Non-panicking.** An unknown id yields `None`; it does not abort the
    ///   call or return an error for that slot.
    /// - **Duplicate ids.** Each occurrence is resolved independently. Two slots
    ///   for the same id return the same `Claim` value, both `Some(…)`. This is
    ///   intentional: the function is idempotent and the on-chain state is the
    ///   same answer for both positions.
    /// - **Challenger rosters excluded.** Challenger lists live under a separate
    ///   storage key (`DataKey::Challengers`). Including them in this call would
    ///   multiply the ledger-entry footprint by up to `MAX_CHALLENGERS` per id,
    ///   which makes the Soroban footprint budget infeasible for large batches.
    ///   Use `get_challengers_page` or `get_challenger_list` separately.
    /// - **TTL extension.** A *present* entry has its TTL extended on read,
    ///   identical to `get_claim`. A *missing* id does not touch storage.
    ///
    /// # Errors
    ///
    /// Returns `Err(Error::BatchTooLarge)` when `ids.len() > MAX_BATCH_SIZE`
    /// (currently 50). The call is entirely rejected; no partial read is
    /// performed. Split the id list into chunks and call again.
    ///
    /// Returns `Err(Error::NotInitialized)` when the contract has not yet been
    /// initialised (mirrors every other read that needs the contract to be live).
    ///
    /// # Accounting and trust
    ///
    /// This function reads contract state; it moves no USDC and grants no
    /// authority. The returned `Claim` values are the same data that
    /// `get_claim` would return one by one. All money-movement invariants
    /// (creator stake, challenger stakes, remaining_escrow, fees) are unchanged
    /// and untouched by this call.
    ///
    /// No migration is required: this is a new additive entry point that does
    /// not alter any existing storage key or function signature.
    pub fn get_claims_batch(
        env: Env,
        ids: Vec<u64>,
    ) -> Result<Vec<Option<Claim>>, Error> {
        // Guard: reject over-sized requests before touching any persistent storage.
        if ids.len() > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }
        // Validate the contract is initialised (mirrors get_claim's implicit
        // check via storage::usdc — but we call a lightweight test here so the
        // error message is clear even when ids is empty).
        if !storage::is_initialized(&env) {
            return Err(Error::NotInitialized);
        }

        let mut results: Vec<Option<Claim>> = Vec::new(&env);
        for id in ids.iter() {
            results.push_back(storage::get_claim_opt(&env, id));
        }
        Ok(results)
    }

    pub fn get_claim_market_config(env: Env, claim_id: u64) -> Result<MarketConfig, Error> {
        Ok(storage::get_claim(&env, claim_id)?.market)
    }

    pub fn get_claim_fees(env: Env, claim_id: u64) -> Result<ClaimFeeView, Error> {
        let claim = storage::get_claim(&env, claim_id)?;
        Ok(ClaimFeeView {
            platform_fee_bps: claim.fees.platform_fee_bps,
            agent_owner_fee_bps: claim.fees.agent_owner_fee_bps,
            platform_recipient: claim.fees.platform_recipient,
            agent_owner_recipient: claim.fees.agent_owner_recipient,
            context_hash: claim.context_hash,
        })
    }

    /// The roster, including each challenger's stake and whether they have
    /// already pulled their settlement.
    pub fn get_challenger_list(env: Env, claim_id: u64) -> Vec<Challenger> {
        storage::challengers(&env, claim_id)
    }

    /// A paginated window into the challenger roster.
    ///
    /// Returns up to `limit` entries starting at `offset` (0-based).  
    /// `limit = 0` returns all entries from `offset` to the end of the roster —
    /// identical to `get_challenger_list` when `offset = 0`.
    ///
    /// The `ChallengerPage` response always carries `total` (full roster length)
    /// so callers can detect the last page without issuing an extra empty fetch.
    ///
    /// Neither `offset` nor `limit` can cause a panic: an `offset` beyond the
    /// end of the roster returns an empty `items` slice with `total` set
    /// correctly.
    pub fn get_challengers_page(
        env: Env,
        claim_id: u64,
        offset: u32,
        limit: u32,
    ) -> ChallengerPage {
        storage::challengers_page(&env, claim_id, offset, limit)
    }

    /// What `claim_challenger_payout` would pay this challenger right now.
    pub fn quote_challenger_payout(
        env: Env,
        claim_id: u64,
        challenger: Address,
    ) -> Result<PayoutQuote, Error> {
        resolve::quote_challenger_payout(&env, claim_id, &challenger)
    }

    pub fn get_platform_stats(env: Env) -> Result<PlatformStats, Error> {
        let usdc = storage::usdc(&env)?;
        Ok(PlatformStats {
            total_claims: storage::claim_count(&env),
            resolved: storage::total_resolved(&env),
            balance: escrow::balance(&env, &usdc),
            fees_accrued: storage::lifetime_fees_accrued(&env),
            fees_claimed: storage::lifetime_fees_claimed(&env),
        })
    }

    pub fn get_fee_policy(env: Env) -> Result<FeePolicy, Error> {
        storage::fee_policy(&env)
    }

    pub fn get_pending_fee_policy(env: Env) -> Option<PendingFeePolicy> {
        storage::pending_fee_policy(&env)
    }

    pub fn get_pending_oracle(env: Env) -> Option<PendingOracle> {
        storage::pending_oracle(&env)
    }

    pub fn get_owner(env: Env) -> Result<Address, Error> {
        storage::owner(&env)
    }

    pub fn get_oracle(env: Env) -> Result<Address, Error> {
        storage::oracle(&env)
    }

    pub fn get_usdc(env: Env) -> Result<Address, Error> {
        storage::usdc(&env)
    }

    pub fn get_withdrawable(env: Env, who: Address) -> i128 {
        storage::withdrawable(&env, &who)
    }

    pub fn get_accrued_fees(env: Env, who: Address) -> i128 {
        storage::accrued_fees(&env, &who)
    }
}
