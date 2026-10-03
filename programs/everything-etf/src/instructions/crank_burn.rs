use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

use crate::constants::COIN_SEED;
use crate::errors::EtfError;
use crate::events::CoinBurned;
use crate::state::CoinConfig;

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

    let bump = [ctx.accounts.coin_config.bump];
    let seeds: &[&[u8]] = &[COIN_SEED, &bump];
    token::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.coin_mint.to_account_info(),
                from: ctx.accounts.burn_vault.to_account_info(),
                authority: ctx.accounts.coin_config.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    ctx.accounts.coin_mint.reload()?;

    let coin_config = &mut ctx.accounts.coin_config;
    coin_config.total_burned = coin_config
        .total_burned
        .checked_add(amount)
        .ok_or(EtfError::MathOverflow)?;

    emit!(CoinBurned {
        cranker: ctx.accounts.cranker.key(),
        amount,
        supply_after: ctx.accounts.coin_mint.supply,
        total_burned: coin_config.total_burned,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
