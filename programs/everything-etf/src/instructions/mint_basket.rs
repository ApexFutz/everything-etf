use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use anchor_spl::token_2022::Token2022;

use crate::constants::BASKET_SEED;
use crate::errors::EtfError;
use crate::events::Minted;
use crate::math;
use crate::state::Basket;
use crate::utils::{accrue_streaming_fee, credit_fee, deposit_leg, load_asset_legs};

/// In-kind mint: deposit each underlying pro-rata, receive basket tokens at NAV.
/// This is the instruction arbitrageurs use when the pool price trades above NAV.
///
/// Remaining accounts: `[asset_mint, asset_vault, user_asset_account]` per asset.
#[derive(Accounts)]
pub struct MintBasket<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub basket: Box<Account<'info, Basket>>,

    #[account(mut, address = basket.mint)]
    pub basket_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = basket.fee_escrow)]
    pub fee_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = basket_mint, token::authority = user)]
    pub user_basket_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, MintBasket<'info>>,
    amount: u64,
    max_amounts_in: Vec<u64>,
) -> Result<()> {
    require!(amount > 0, EtfError::ZeroAmount);
    require!(
        max_amounts_in.len() == ctx.accounts.basket.assets.len(),
        EtfError::AmountListMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    let token_program = ctx.accounts.token_program.to_account_info();
    let token_2022_program = ctx.accounts.token_2022_program.to_account_info();
    let fee_escrow_info = ctx.accounts.fee_escrow.to_account_info();

    let accts = &mut *ctx.accounts;
    accrue_streaming_fee(
        &mut accts.basket,
        &mut accts.basket_mint,
        &fee_escrow_info,
        &token_program,
        now,
    )?;

    let supply = accts.basket_mint.supply;
    require!(supply > 0, EtfError::NotSeeded);

    let legs = load_asset_legs(
        ctx.remaining_accounts,
        &accts.basket.key(),
        &accts.basket.assets,
        &accts.user.key(),
        &token_program,
        &token_2022_program,
    )?;

    // Pull deposits (rounded up in the vault's favour).
    let user_info = accts.user.to_account_info();
    let mut deposits = Vec::with_capacity(legs.len());
    for (leg, max_in) in legs.iter().zip(max_amounts_in.iter()) {
        let dep = math::deposit_for_mint(leg.vault_balance, amount, supply)?;
        require!(dep <= *max_in, EtfError::SlippageIn);
        deposit_leg(leg, &user_info, dep)?;
        deposits.push(dep);
    }

    // Mint net to the user and the fee to escrow.
    let fee = math::bps_of(amount, accts.basket.mint_fee_bps as u64)?;
    let to_user = amount - fee;

    let id_bytes = accts.basket.id.to_le_bytes();
    let bump = [accts.basket.bump];
    let seeds: &[&[u8]] = &[BASKET_SEED, &id_bytes, &bump];
    let basket_info = accts.basket.to_account_info();
    let mint_info = accts.basket_mint.to_account_info();

    token::mint_to(
        CpiContext::new_with_signer(
            token_program.clone(),
            MintTo {
                mint: mint_info.clone(),
                to: accts.user_basket_account.to_account_info(),
                authority: basket_info.clone(),
            },
            &[seeds],
        ),
        to_user,
    )?;
    if fee > 0 {
        token::mint_to(
            CpiContext::new_with_signer(
                token_program,
                MintTo {
                    mint: mint_info,
                    to: fee_escrow_info,
                    authority: basket_info,
                },
                &[seeds],
            ),
            fee,
        )?;
        credit_fee(&mut accts.basket, fee)?;
    }

    emit!(Minted {
        basket: accts.basket.key(),
        user: accts.user.key(),
        amount_gross: amount,
        amount_to_user: to_user,
        fee,
        deposits,
        supply_after: supply + amount,
        timestamp: now,
    });
    Ok(())
}
