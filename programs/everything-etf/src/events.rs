//! Every state change emits an event. An indexer (e.g. Helius webhooks) turns
//! these into each basket page's public history.
use anchor_lang::prelude::*;

use crate::state::FeeRecipient;

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub creation_fee_lamports: u64,
    pub protocol_share_bps: u16,
}

#[event]
pub struct ProtocolTermsUpdated {
    pub treasury: Pubkey,
    pub creation_fee_lamports: u64,
    pub protocol_share_bps: u16,
}

#[event]
pub struct BasketCreated {
    pub basket: Pubkey,
    pub id: u64,
    pub manager: Pubkey,
    pub mint: Pubkey,
    pub assets: Vec<Pubkey>,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub mint_fee_bps: u16,
    pub redeem_fee_bps: u16,
    pub streaming_fee_bps: u16,
    pub protocol_share_bps: u16,
    pub creation_fee_lamports: u64,
    pub timestamp: i64,
}

#[event]
pub struct BasketSeeded {
    pub basket: Pubkey,
    pub manager: Pubkey,
    pub amounts: Vec<u64>,
    pub initial_supply: u64,
    pub timestamp: i64,
}

#[event]
pub struct Minted {
    pub basket: Pubkey,
    pub user: Pubkey,
    pub amount_gross: u64,
    pub amount_to_user: u64,
    pub fee: u64,
    pub deposits: Vec<u64>,
    pub supply_after: u64,
    pub timestamp: i64,
}

#[event]
pub struct Redeemed {
    pub basket: Pubkey,
    pub user: Pubkey,
    pub amount_gross: u64,
    pub amount_burned: u64,
    pub fee: u64,
    pub payouts: Vec<u64>,
    pub supply_after: u64,
    pub timestamp: i64,
}

#[event]
pub struct StreamingFeeAccrued {
    pub basket: Pubkey,
    pub minted: u64,
    pub to_protocol: u64,
    pub to_manager: u64,
    pub elapsed_seconds: u64,
    pub timestamp: i64,
}

#[event]
pub struct FeesClaimed {
    pub basket: Pubkey,
    pub recipient: FeeRecipient,
    pub payout_owner: Pubkey,
    pub total: u64,
    pub basket_tokens_paid: u64,
    pub cash_leg_burned: u64,
    pub cash_leg_payouts: Vec<u64>,
    pub timestamp: i64,
}

#[event]
pub struct FeesLowered {
    pub basket: Pubkey,
    pub mint_fee_bps: u16,
    pub redeem_fee_bps: u16,
    pub streaming_fee_bps: u16,
    pub timestamp: i64,
}
