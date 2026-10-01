use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::constants::BASKET_SEED;
use crate::errors::EtfError;
use crate::events::Redeemed;
use crate::math;
use crate::state::Basket;
use crate::utils::{accrue_streaming_fee, credit_fee, load_asset_legs, payout_leg};

/// In-kind redeem: burn basket tokens, receive each underlying pro-rata.
/// The redeem fee is moved to escrow (not burned), so it stays a claim on the vault.
///
/// Remaining accounts: `[asset_mint, asset_vault, user_asset_account]` per asset.
#[derive(Accounts)]
pub struct RedeemBasket<'info> {
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
    ctx: Context<'_, '_, 'info, 'info, RedeemBasket<'info>>,
    amount: u64,
    min_amounts_out: Vec<u64>,
) -> Result<()> {
    require!(amount > 0, EtfError::ZeroAmount);
    require!(
        min_amounts_out.len() == ctx.accounts.basket.assets.len(),
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

    let fee = math::bps_of(amount, accts.basket.redeem_fee_bps as u64)?;
    let net = amount - fee;

    // Payouts use pre-burn supply (rounded down in the vault's favour).
    let mut payouts = Vec::with_capacity(legs.len());
    for (leg, min_out) in legs.iter().zip(min_amounts_out.iter()) {
        let out = math::payout_for_burn(leg.vault_balance, net, supply)?;
        require!(out >= *min_out, EtfError::SlippageOut);
        payouts.push(out);
    }

    let user_info = accts.user.to_account_info();
    if fee > 0 {
        token::transfer(
            CpiContext::new(
                token_program.clone(),
                Transfer {
                    from: accts.user_basket_account.to_account_info(),
                    to: fee_escrow_info,
                    authority: user_info.clone(),
                },
            ),
            fee,
        )?;
        credit_fee(&mut accts.basket, fee)?;
    }
    if net > 0 {
        token::burn(
            CpiContext::new(
                token_program,
                Burn {
                    mint: accts.basket_mint.to_account_info(),
                    from: accts.user_basket_account.to_account_info(),
                    authority: user_info,
                },
            ),
            net,
        )?;
    }

    let id_bytes = accts.basket.id.to_le_bytes();
    let bump = [accts.basket.bump];
    let seeds: &[&[u8]] = &[BASKET_SEED, &id_bytes, &bump];
    let basket_info = accts.basket.to_account_info();
    for (leg, out) in legs.iter().zip(payouts.iter()) {
        payout_leg(leg, &basket_info, &[seeds], *out)?;
    }

    emit!(Redeemed {
        basket: accts.basket.key(),
        user: accts.user.key(),
        amount_gross: amount,
        amount_burned: net,
        fee,
        payouts,
        supply_after: supply - net,
        timestamp: now,
    });
    Ok(())
}
