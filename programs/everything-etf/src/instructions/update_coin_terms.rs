use anchor_lang::prelude::*;

use crate::constants::{BPS, COIN_SEED, CONFIG_SEED, MAX_CREATION_FEE_COIN, MIN_CREATION_BURN_BPS};
use crate::errors::EtfError;
use crate::events::CoinTermsUpdated;
use crate::state::{CoinConfig, Config};

/// Repoints the dev treasury and reprices basket creation. Both knobs are
/// bounded by hardcoded limits: the fee can never exceed MAX_CREATION_FEE_COIN
/// and the burn share can never drop below MIN_CREATION_BURN_BPS, so the
/// authority can neither price managers out nor switch the burn off.
#[derive(Accounts)]
pub struct UpdateCoinTerms<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ EtfError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [COIN_SEED], bump = coin_config.bump)]
    pub coin_config: Account<'info, CoinConfig>,
}

pub fn handler(
    ctx: Context<UpdateCoinTerms>,
    dev_treasury: Pubkey,
    creation_fee_coin: u64,
    creation_burn_bps: u16,
) -> Result<()> {
    require!(
        creation_burn_bps >= MIN_CREATION_BURN_BPS,
        EtfError::BurnShareBelowFloor
    );
    require!(creation_burn_bps as u64 <= BPS, EtfError::BurnShareBelowFloor);
    require!(
        creation_fee_coin <= MAX_CREATION_FEE_COIN,
        EtfError::CreationFeeAboveCap
    );

    let coin_config = &mut ctx.accounts.coin_config;
    coin_config.dev_treasury = dev_treasury;
    coin_config.creation_fee_coin = creation_fee_coin;
    coin_config.creation_burn_bps = creation_burn_bps;

    emit!(CoinTermsUpdated {
        dev_treasury,
        creation_fee_coin,
        creation_burn_bps,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
