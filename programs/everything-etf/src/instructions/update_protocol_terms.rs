use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, MAX_PROTOCOL_SHARE_BPS};
use crate::errors::EtfError;
use crate::events::ProtocolTermsUpdated;
use crate::state::Config;

/// Changes terms for baskets created *after* this call. Existing baskets keep
/// the protocol share they were created with.
#[derive(Accounts)]
pub struct UpdateProtocolTerms<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ EtfError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler(
    ctx: Context<UpdateProtocolTerms>,
    treasury: Pubkey,
    creation_fee_lamports: u64,
    protocol_share_bps: u16,
) -> Result<()> {
    require!(
        protocol_share_bps <= MAX_PROTOCOL_SHARE_BPS,
        EtfError::ProtocolShareAboveCap
    );
    let config = &mut ctx.accounts.config;
    config.treasury = treasury;
    config.creation_fee_lamports = creation_fee_lamports;
    config.protocol_share_bps = protocol_share_bps;

    emit!(ProtocolTermsUpdated {
        treasury,
        creation_fee_lamports,
        protocol_share_bps,
    });
    Ok(())
}
