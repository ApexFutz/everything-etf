use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::Basket;
use crate::utils::accrue_streaming_fee;

/// Permissionless: brings the streaming fee up to date. Useful for dashboards
/// that want exact accrued numbers without waiting for the next mint/redeem.
#[derive(Accounts)]
pub struct AccrueFees<'info> {
    #[account(mut)]
    pub basket: Box<Account<'info, Basket>>,

    #[account(mut, address = basket.mint)]
    pub basket_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = basket.fee_escrow)]
    pub fee_escrow: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<AccrueFees>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let token_program = ctx.accounts.token_program.to_account_info();
    let fee_escrow_info = ctx.accounts.fee_escrow.to_account_info();
    let accts = &mut *ctx.accounts;
    accrue_streaming_fee(
        &mut accts.basket,
        &mut accts.basket_mint,
        &fee_escrow_info,
        &token_program,
        now,
    )
}
