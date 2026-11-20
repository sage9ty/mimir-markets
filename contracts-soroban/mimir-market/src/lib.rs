#no_std
/// Mimir market — oracle-settled prediction market on Soroban.
///
/// Port of `contracts/MimirV2.sol`. Stakes are held in a USDC Stellar Asset
/// Contract; fees are charged on PROFIT only, snapshotted per claim, and any
/// policy change is timelocked under a hard constant cap. Oracle
/// rotation is likewise timelocked so settlement authority cannot move silently.
///
/// Deliberate deviations from the Solidity original are marked
/// `DEVIATION FROM SOLIDITY` at the point they occur.

mod admin;
mod claims;
mod escrow;
mod fees;
pub mod events;
mod resolve;
mod storage;
mod types;
mod util;

pub use contract::{MimirMarket, MimirMarketClient};
pub use types:*;

#[config(test)]
mod test_challenge_lock;
#[config(test)]
mod test_common;
#[config(test)]
mod test_decimals;
#[cfg(test)]
mod test_dust_isolation;
#[config(test)]
mod test_fee_rounding;
#[config(test)]
mod test_fees;
#[cfg(test)]
mod test_fee_recipient_transition;
#[config(test)]
mod test_lifecycle;
#[config(test)]
mod test_pagination;
#[config(test)]
mod test_settlement;
#[config(test)]
mod test_verdict;
#[cfg(test)]
mod test_preflight;
#[config(test)]
mod test_batch_read;
#[config(test)]
mod test_batch_get_claims;
#[config(test)]
mod test_rematch_status;
#[config(test)]
mod test_budgets;
#[config(test)]
mod test_oracle_timelock;
#[config(test)]
mod test_creator_index;
