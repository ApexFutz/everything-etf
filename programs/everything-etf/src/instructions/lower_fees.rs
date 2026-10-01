use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::EtfError;
use crate::events::FeesLowered;
use crate::state::Basket;
use crate::utils::accrue_streaming_fee;

/// Managers can lower fees instantly. Raising fees will go through the
/// timelock (step 6) and can never exceed the hard caps in constants.rs.
#[derive(Accounts)]
pub struct LowerFees<'info> {
    pub manager: Signer<'info>,

    #[account(mut, has_one = manager @ EtfError::Unauthorized)]
    pub basket: Box<Account<'info, Basket>>,

    #[account(mut, address = basket.mint)]
    pub basket_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = basket.fee_escrow)]
    pub fee_escrow: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<LowerFees>,
    mint_fee_bps: u16,
    redeem_fee_bps: u16,
    streaming_fee_bps: u16,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let token_program = ctx.accounts.token_program.to_account_info();
    let fee_escrow_info = ctx.accounts.fee_escrow.to_account_info();
    let accts = &mut *ctx.accounts;

    // Settle the old streaming rate up to now before changing it.
    accrue_streaming_fee(
        &mut accts.basket,
        &mut accts.basket_mint,
        &fee_escrow_info,
        &token_program,
        now,
    )?;

    let basket = &mut accts.basket;
    require!(mint_fee_bps <= basket.mint_fee_bps, EtfError::FeeIncreaseNotAllowed);
    require!(redeem_fee_bps <= basket.redeem_fee_bps, EtfError::FeeIncreaseNotAllowed);
    require!(
        streaming_fee_bps <= basket.streaming_fee_bps,
        EtfError::FeeIncreaseNotAllowed
    );
    basket.mint_fee_bps = mint_fee_bps;
    basket.redeem_fee_bps = redeem_fee_bps;
    basket.streaming_fee_bps = streaming_fee_bps;

    emit!(FeesLowered {
        basket: basket.key(),
        mint_fee_bps,
        redeem_fee_bps,
        streaming_fee_bps,
        timestamp: now,
    });
    Ok(())
}
