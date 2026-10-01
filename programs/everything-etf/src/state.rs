use anchor_lang::prelude::*;

/// Global protocol settings. One per deployment.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Protocol admin (can change terms for *future* baskets and claim protocol fees).
    pub authority: Pubkey,
    /// Wallet that receives creation fees and protocol fee payouts.
    pub treasury: Pubkey,
    /// Flat fee charged when a basket is created (0.25 SOL by default).
    pub creation_fee_lamports: u64,
    /// Protocol share of every fee, snapshotted onto each basket at creation.
    pub protocol_share_bps: u16,
    /// Number of baskets created; also the next basket's id.
    pub basket_count: u64,
    pub bump: u8,
}

/// One equal-weight basket.
#[account]
#[derive(InitSpace)]
pub struct Basket {
    pub id: u64,
    pub manager: Pubkey,
    /// The basket token mint (classic SPL Token, mint authority = this PDA).
    pub mint: Pubkey,
    /// Basket-token account that holds accrued, unclaimed fees.
    pub fee_escrow: Pubkey,
    /// Underlying asset mints. Each gets 1/N of the basket by design.
    #[max_len(10)]
    pub assets: Vec<Pubkey>,
    pub mint_fee_bps: u16,
    pub redeem_fee_bps: u16,
    /// Annual streaming (management) fee.
    pub streaming_fee_bps: u16,
    /// Protocol share locked in at creation. Later protocol changes never touch it.
    pub protocol_share_bps: u16,
    /// Accrued fees in basket-token units, held in `fee_escrow`.
    /// Invariant: fee_escrow balance == manager_fees_accrued + protocol_fees_accrued.
    pub manager_fees_accrued: u64,
    pub protocol_fees_accrued: u64,
    pub last_fee_accrual: i64,
    pub created_at: i64,
    pub bump: u8,
    pub mint_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum FeeRecipient {
    Manager,
    Protocol,
}
