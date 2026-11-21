//! Value types for the squad pool. Mirrors `contracts/MimirSquad.sol`.

use soroban_sdk::{contracterror, contracttype, Address};

// ── Constants (mirror MimirSquad.sol) ────────────────────────────────────────

pub const SIDE_A: u32 = 1;
pub const SIDE_B: u32 = 2;
pub const RESULT_CANCELLED: u32 = 3;

pub const MAX_FEE_BPS: u32 = 1_000;
pub const MAX_PARTICIPANTS_PER_SIDE: u32 = 200;
/// Hard ceiling on the total number of members across **both** sides of a single
/// squad market.  This is distinct from [`MAX_PARTICIPANTS_PER_SIDE`], which
/// caps each side independently.  A squad may never have more than
/// `MAX_SQUAD_MEMBERS` unique addresses with an open position at any given time.
///
/// With two sides of 200 each the combined ceiling is 400, which equals 2 ×
/// [`MAX_PARTICIPANTS_PER_SIDE`] — the tightest consistent bound without further
/// restricting the per-side limit.
pub const MAX_SQUAD_MEMBERS: u32 = 400;
pub const MIN_DURATION: u64 = 600; // 10 minutes
pub const MAX_DURATION: u64 = 31_536_000; // 365 days

/// Maximum number of market ids accepted by `get_markets_batch` in a single call.
pub const MAX_BATCH_SIZE: u32 = 50;

/// Upper bound on the byte length of a market question.
///
/// The question is free text supplied by the captain and carried on the
/// `MarketCreated` event; it is bounded at the boundary rather than truncated,
/// so a rejected caller knows to shorten it. Mirrors
/// `mimir-market::MAX_METADATA_BYTES`.
pub const MAX_QUESTION_BYTES: u32 = 512;

pub const BPS_DIVISOR: i128 = 10_000;

/// Decimals of the escrow token. A Stellar Asset Contract exposes every classic
/// asset, Circle's USDC included, with exactly 7. Shares equal deposited atomic
/// units, so this is also the scale every share is read at off-chain;
/// `initialize` refuses a token that reports any other.
pub const USDC_DECIMALS: u32 = 7;

/// A queued oracle rotation cannot take effect before this much time passes.
pub const ORACLE_TIMELOCK_SECONDS: u64 = 172_800; // 2 days

/// A queued fee-recipient rotation cannot take effect before this much time passes.
pub const FEE_RECIPIENT_TIMELOCK_SECONDS: u64 = 172_800; // 2 days

// ── Storage shapes ───────────────────────────────────────────────────────────

/// A queued oracle rotation, executable once `executable_at` has passed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingOracle {
    pub next: Address,
    pub executable_at: u64,
}

/// A queued fee-recipient rotation, executable once `executable_at` has passed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingFeeRecipient {
    pub next: Address,
    pub executable_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub captain: Address,
    pub deadline: u64,
    pub fee_bps: u32,
    /// `0` until resolved, then SIDE_A / SIDE_B / RESULT_CANCELLED.
    pub result: u32,
    pub resolved: bool,
    pub pool_a: i128,
    pub pool_b: i128,
    pub remaining_escrow: i128,
    pub participants_a: u32,
    pub participants_b: u32,
    pub winner_claims: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimResult {
    pub gross: i128,
    pub fee: i128,
    pub net: i128,
}

/// Explicit claim state for a wallet's position in a squad market.
///
/// Distinguishes the states that were previously collapsed into a zero amount:
/// a wallet with no position, a wallet whose share is claimable right now, and
/// a wallet whose payout has already been claimed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClaimStatus {
    /// The wallet has no position in the market (read-only path, no error).
    NoPosition,
    /// The wallet has a claimable payout of `net` atomic units.
    Claimable(i128),
    /// The wallet's payout has already been claimed.
    AlreadyClaimed,
}

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    ZeroAddress = 3,
    EmptyQuestion = 4,
    BadDeadline = 5,
    FeeCapExceeded = 6,
    MarketNotFound = 7,
    MarketClosed = 8,
    BadSide = 9,
    ZeroAmount = 10,
    SideFull = 11,
    Locked = 12,
    BadAmount = 13,
    NotOracle = 14,
    NotResolvable = 15,
    BadResult = 16,
    EmptyWinner = 17,
    NotClaimable = 18,
    NotWinner = 19,
    AlreadyClaimed = 20,
    NotFeeRecipient = 21,
    NoFees = 22,
    UnsupportedToken = 23,
    Overflow = 24,
    UnsupportedDecimals = 25,
    ConservationViolation = 26,
    /// The market question exceeded `MAX_QUESTION_BYTES`. Refused rather than
    /// truncated.
    QuestionTooLong = 27,
    /// All [`MAX_SQUAD_MEMBERS`] slots across both sides have been filled.
    /// Distinct from [`Error::SideFull`], which fires when a single side reaches
    /// [`MAX_PARTICIPANTS_PER_SIDE`].  A new depositor is rejected once
    /// `participants_a + participants_b == MAX_SQUAD_MEMBERS` even if the target
    /// side still has room.
    SquadFull = 28,
    /// A payout could not be delivered because the token transfer trapped
    /// (frozen or deauthorized trustline). The amount is parked, not lost:
    /// `claim` succeeds and holds it, `claim_parked_payout` retries it.
    PayoutParked = 29,
    /// `cancel_market` was called on a market that is already resolved or
    /// cancelled.
    AlreadyResolved = 30,
    /// `cancel_oracle` / `execute_oracle` found no queued oracle rotation.
    NothingQueued = 31,
    /// `execute_oracle` was called before the rotation's timelock elapsed.
    Timelocked = 32,
    /// `get_markets_batch` was called with more than `MAX_BATCH_SIZE` ids. Refused before reading storage.
    BatchTooLarge = 33,
    /// `cancel_fee_recipient` / `execute_fee_recipient` found no queued
    /// fee-recipient rotation.
    NoFeeRecipientQueued = 34,
}
