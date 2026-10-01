use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, MAX_PROTOCOL_SHARE_BPS};
use crate::errors::EtfError;
use crate::events::ConfigInitialized;
use crate::program::EverythingEtf;
use crate::state::Config;

/// One-time setup. Only the program's upgrade authority can call it, so nobody
/// can front-run the deployment and install themselves as protocol admin.
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, EverythingEtf>,

    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ EtfError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeConfig>,
    treasury: Pubkey,
    creation_fee_lamports: u64,
    protocol_share_bps: u16,
) -> Result<()> {
    require!(
        protocol_share_bps <= MAX_PROTOCOL_SHARE_BPS,
        EtfError::ProtocolShareAboveCap
    );
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.treasury = treasury;
    config.creation_fee_lamports = creation_fee_lamports;
    config.protocol_share_bps = protocol_share_bps;
    config.basket_count = 0;
    config.bump = ctx.bumps.config;

    emit!(ConfigInitialized {
        authority: config.authority,
        treasury,
        creation_fee_lamports,
        protocol_share_bps,
    });
    Ok(())
}
