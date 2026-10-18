use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::COIN_SEED;
use crate::errors::EtfError;
use crate::events::CoinBurned;
use crate::state::CoinConfig;
use crate::utils::burn_coin;

/// Burns the entire burn-vault balance. Permissionless: anyone can crank it,
/// and the only possible outcome is a smaller supply.
///
/// The vault is a plain token account owned by the coin PDA, so protocol fee
/// revenue swapped into $EETF (or anything anyone wants to retire) can simply
/// be transferred in; this instruction is the only way it ever moves again.
#[derive(Accounts)]
pub struct CrankBurn<'info> {
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [COIN_SEED], bump = coin_config.bump)]
    pub coin_config: Account<'info, CoinConfig>,

    #[account(mut, address = coin_config.mint)]
    pub coin_mint: Account<'info, Mint>,

    #[account(mut, address = coin_config.burn_vault)]
    pub burn_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CrankBurn>) -> Result<()> {
    let amount = ctx.accounts.burn_vault.amount;
    require!(amount > 0, EtfError::NothingToBurn);

    // The vault is owned by the coin PDA, so the PDA signs for its own burn.
    let bump = [ctx.accounts.coin_config.bump];
    let seeds: &[&[u8]] = &[COIN_SEED, &bump];
    let authority = ctx.accounts.coin_config.to_account_info();
    let from = ctx.accounts.burn_vault.to_account_info();
    let token_program = ctx.accounts.token_program.to_account_info();
    let total_burned = burn_coin(
        &mut ctx.accounts.coin_config,
        &mut ctx.accounts.coin_mint,
        &from,
        &authority,
        &token_program,
        amount,
        &[seeds],
    )?;

    emit!(CoinBurned {
        cranker: ctx.accounts.cranker.key(),
        amount,
        supply_after: ctx.accounts.coin_mint.supply,
        total_burned,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
