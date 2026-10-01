use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use anchor_spl::token_2022::Token2022;

use crate::constants::BASKET_SEED;
use crate::errors::EtfError;
use crate::events::BasketSeeded;
use crate::state::Basket;
use crate::utils::{deposit_leg, load_asset_legs};

/// The manager makes the first deposit and sets the starting supply.
///
/// v0.1 is in-kind: the manager chooses amounts so each asset is roughly equal
/// in value (1/N). Once oracles arrive, the rebalance crank enforces 1/N.
/// Only the manager can seed, which also blocks first-depositor share attacks.
///
/// Remaining accounts: `[asset_mint, asset_vault, manager_asset_account]` per asset.
#[derive(Accounts)]
pub struct SeedBasket<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(mut, has_one = manager @ EtfError::Unauthorized)]
    pub basket: Box<Account<'info, Basket>>,

    #[account(mut, address = basket.mint)]
    pub basket_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = basket_mint, token::authority = manager)]
    pub manager_basket_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, SeedBasket<'info>>,
    initial_supply: u64,
    amounts: Vec<u64>,
) -> Result<()> {
    require!(ctx.accounts.basket_mint.supply == 0, EtfError::AlreadySeeded);
    require!(initial_supply > 0, EtfError::ZeroAmount);
    let basket = &ctx.accounts.basket;
    require!(amounts.len() == basket.assets.len(), EtfError::AmountListMismatch);
    require!(amounts.iter().all(|a| *a > 0), EtfError::ZeroAmount);

    let token_program = ctx.accounts.token_program.to_account_info();
    let token_2022_program = ctx.accounts.token_2022_program.to_account_info();
    let legs = load_asset_legs(
        ctx.remaining_accounts,
        &basket.key(),
        &basket.assets,
        &ctx.accounts.manager.key(),
        &token_program,
        &token_2022_program,
    )?;

    let manager_info = ctx.accounts.manager.to_account_info();
    for (leg, amount) in legs.iter().zip(amounts.iter()) {
        deposit_leg(leg, &manager_info, *amount)?;
    }

    let id_bytes = basket.id.to_le_bytes();
    let bump = [basket.bump];
    let seeds: &[&[u8]] = &[BASKET_SEED, &id_bytes, &bump];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program,
            MintTo {
                mint: ctx.accounts.basket_mint.to_account_info(),
                to: ctx.accounts.manager_basket_account.to_account_info(),
                authority: ctx.accounts.basket.to_account_info(),
            },
            &[seeds],
        ),
        initial_supply,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let basket = &mut ctx.accounts.basket;
    // No streaming fee accrues while a basket is empty.
    basket.last_fee_accrual = now;

    emit!(BasketSeeded {
        basket: basket.key(),
        manager: basket.manager,
        amounts,
        initial_supply,
        timestamp: now,
    });
    Ok(())
}
