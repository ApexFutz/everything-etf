//! Everything ETF — launchpad for equal-weight, on-chain basket tokens.
//!
//! v0.1 (this program): the $EETF coin, baskets, in-kind mint/redeem, fees, events.
//! See README.md for the full roadmap.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;
pub mod utils;

use instructions::*;
use state::FeeRecipient;

declare_id!("9mT7xrj7xWiTPkH8pMQ8yzz8d8Fs9TacqyYQ61yPUzyq");

#[program]
pub mod everything_etf {
    use super::*;

    /// One-time protocol setup (upgrade authority only).
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        treasury: Pubkey,
        creation_fee_lamports: u64,
        protocol_share_bps: u16,
    ) -> Result<()> {
        instructions::initialize_config::handler(ctx, treasury, creation_fee_lamports, protocol_share_bps)
    }

    /// Change terms for future baskets only.
    pub fn update_protocol_terms(
        ctx: Context<UpdateProtocolTerms>,
        treasury: Pubkey,
        creation_fee_lamports: u64,
        protocol_share_bps: u16,
    ) -> Result<()> {
        instructions::update_protocol_terms::handler(ctx, treasury, creation_fee_lamports, protocol_share_bps)
    }

    /// Mint $EETF: whole fixed supply at once, then the mint authority is
    /// revoked in the same instruction. Callable exactly once.
    pub fn initialize_coin(
        ctx: Context<InitializeCoin>,
        params: InitializeCoinParams,
    ) -> Result<()> {
        instructions::initialize_coin::handler(ctx, params)
    }

    /// Reprice basket creation / repoint the dev treasury, within hard caps.
    pub fn update_coin_terms(
        ctx: Context<UpdateCoinTerms>,
        dev_treasury: Pubkey,
        creation_fee_coin: u64,
        creation_burn_bps: u16,
    ) -> Result<()> {
        instructions::update_coin_terms::handler(ctx, dev_treasury, creation_fee_coin, creation_burn_bps)
    }

    /// Permissionlessly burn everything sitting in the $EETF burn vault.
    pub fn crank_burn(ctx: Context<CrankBurn>) -> Result<()> {
        instructions::crank_burn::handler(ctx)
    }

    /// Launch a new basket. Burns the $EETF creation fee and pays the dev share.
    pub fn create_basket<'info>(
        ctx: Context<'_, '_, 'info, 'info, CreateBasket<'info>>,
        params: CreateBasketParams,
    ) -> Result<()> {
        instructions::create_basket::handler(ctx, params)
    }

    /// Manager's first deposit; sets the starting supply.
    pub fn seed_basket<'info>(
        ctx: Context<'_, '_, 'info, 'info, SeedBasket<'info>>,
        initial_supply: u64,
        amounts: Vec<u64>,
    ) -> Result<()> {
        instructions::seed_basket::handler(ctx, initial_supply, amounts)
    }

    /// In-kind mint at NAV.
    pub fn mint_basket<'info>(
        ctx: Context<'_, '_, 'info, 'info, MintBasket<'info>>,
        amount: u64,
        max_amounts_in: Vec<u64>,
    ) -> Result<()> {
        instructions::mint_basket::handler(ctx, amount, max_amounts_in)
    }

    /// In-kind redeem at NAV.
    pub fn redeem_basket<'info>(
        ctx: Context<'_, '_, 'info, 'info, RedeemBasket<'info>>,
        amount: u64,
        min_amounts_out: Vec<u64>,
    ) -> Result<()> {
        instructions::redeem_basket::handler(ctx, amount, min_amounts_out)
    }

    /// Permissionless streaming-fee accrual.
    pub fn accrue_fees(ctx: Context<AccrueFees>) -> Result<()> {
        instructions::accrue_fees::handler(ctx)
    }

    /// Pay out accrued fees (25% basket tokens / 75% cash leg).
    pub fn claim_fees<'info>(
        ctx: Context<'_, '_, 'info, 'info, ClaimFees<'info>>,
        recipient: FeeRecipient,
    ) -> Result<()> {
        instructions::claim_fees::handler(ctx, recipient)
    }

    /// Lower (never raise) a basket's fees.
    pub fn lower_fees(
        ctx: Context<LowerFees>,
        mint_fee_bps: u16,
        redeem_fee_bps: u16,
        streaming_fee_bps: u16,
    ) -> Result<()> {
        instructions::lower_fees::handler(ctx, mint_fee_bps, redeem_fee_bps, streaming_fee_bps)
    }
}
