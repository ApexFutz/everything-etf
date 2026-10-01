use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::constants::{BASKET_SEED, CONFIG_SEED};
use crate::errors::EtfError;
use crate::events::FeesClaimed;
use crate::math;
use crate::state::{Basket, Config, FeeRecipient};
use crate::utils::{accrue_streaming_fee, load_asset_legs, payout_leg};

/// Pays out accrued fees. This is the ONLY fee outflow in the program, and the
/// amount is fully determined by the on-chain ledgers.
///
/// Split for every recipient: 25% as basket tokens, 75% as the cash leg.
/// v0.1 pays the cash leg in-kind (pro-rata underlyings). Step 2 swaps it to
/// SOL through Jupiter inside this same instruction.
///
/// - Manager claim: signed by basket.manager, paid to the manager.
/// - Protocol claim: signed by config.authority, paid to config.treasury.
///
/// Remaining accounts: `[asset_mint, asset_vault, payout_owner_asset_account]` per asset.
#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub claimer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub basket: Box<Account<'info, Basket>>,

    #[account(mut, address = basket.mint)]
    pub basket_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = basket.fee_escrow)]
    pub fee_escrow: Box<Account<'info, TokenAccount>>,

    /// Payout owner's basket-token account (receives the 25% token leg).
    #[account(mut, token::mint = basket_mint)]
    pub payout_basket_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ClaimFees<'info>>,
    recipient: FeeRecipient,
) -> Result<()> {
    let payout_owner = match recipient {
        FeeRecipient::Manager => {
            require_keys_eq!(
                ctx.accounts.claimer.key(),
                ctx.accounts.basket.manager,
                EtfError::Unauthorized
            );
            ctx.accounts.basket.manager
        }
        FeeRecipient::Protocol => {
            require_keys_eq!(
                ctx.accounts.claimer.key(),
                ctx.accounts.config.authority,
                EtfError::Unauthorized
            );
            ctx.accounts.config.treasury
        }
    };
    require_keys_eq!(
        ctx.accounts.payout_basket_account.owner,
        payout_owner,
        EtfError::InvalidTokenOwner
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

    let total = match recipient {
        FeeRecipient::Manager => accts.basket.manager_fees_accrued,
        FeeRecipient::Protocol => accts.basket.protocol_fees_accrued,
    };
    require!(total > 0, EtfError::NothingToClaim);

    let (token_leg, cash_leg) = math::split_claim(total)?;
    let supply = accts.basket_mint.supply;

    let legs = load_asset_legs(
        ctx.remaining_accounts,
        &accts.basket.key(),
        &accts.basket.assets,
        &payout_owner,
        &token_program,
        &token_2022_program,
    )?;

    // Cash leg: pro-rata underlyings for `cash_leg` basket tokens (pre-burn supply).
    let mut cash_payouts = Vec::with_capacity(legs.len());
    for leg in legs.iter() {
        cash_payouts.push(math::payout_for_burn(leg.vault_balance, cash_leg, supply)?);
    }

    // Zero the ledger before any transfers.
    match recipient {
        FeeRecipient::Manager => accts.basket.manager_fees_accrued = 0,
        FeeRecipient::Protocol => accts.basket.protocol_fees_accrued = 0,
    }

    let id_bytes = accts.basket.id.to_le_bytes();
    let bump = [accts.basket.bump];
    let seeds: &[&[u8]] = &[BASKET_SEED, &id_bytes, &bump];
    let basket_info = accts.basket.to_account_info();

    if token_leg > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.clone(),
                Transfer {
                    from: fee_escrow_info.clone(),
                    to: accts.payout_basket_account.to_account_info(),
                    authority: basket_info.clone(),
                },
                &[seeds],
            ),
            token_leg,
        )?;
    }
    if cash_leg > 0 {
        token::burn(
            CpiContext::new_with_signer(
                token_program,
                Burn {
                    mint: accts.basket_mint.to_account_info(),
                    from: fee_escrow_info,
                    authority: basket_info.clone(),
                },
                &[seeds],
            ),
            cash_leg,
        )?;
        for (leg, out) in legs.iter().zip(cash_payouts.iter()) {
            payout_leg(leg, &basket_info, &[seeds], *out)?;
        }
    }

    emit!(FeesClaimed {
        basket: accts.basket.key(),
        recipient,
        payout_owner,
        total,
        basket_tokens_paid: token_leg,
        cash_leg_burned: cash_leg,
        cash_leg_payouts: cash_payouts,
        timestamp: now,
    });
    Ok(())
}
