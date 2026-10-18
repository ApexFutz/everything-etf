use anchor_lang::prelude::*;

use crate::constants::{MAX_PROFILE_NAME_LEN, PROFILE_SEED};
use crate::errors::EtfError;
use crate::events::ProfileSet;
use crate::state::Profile;

/// Sets or changes the caller's display name.
///
/// `init_if_needed` rather than separate create and update instructions: the
/// account is a PDA seeded by the signer, so only that wallet can ever reach
/// it, and the whole payload is a name that same wallet is free to overwrite.
/// There is no value to drain and no state an attacker could usefully reset,
/// which is the situation the feature's warnings are about.
#[derive(Accounts)]
pub struct SetProfile<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Profile::INIT_SPACE,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump,
    )]
    pub profile: Account<'info, Profile>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SetProfile>, name: String) -> Result<()> {
    let trimmed = name.trim();

    require!(!trimmed.is_empty(), EtfError::ProfileNameEmpty);
    // Bytes, not characters: that is what the account was sized for, and a
    // 32-character name of multi-byte glyphs would not fit.
    require!(
        trimmed.len() <= MAX_PROFILE_NAME_LEN,
        EtfError::ProfileNameTooLong
    );
    // Control characters would let a name break the layout of anything
    // rendering it, or hide text from whoever is reading it.
    require!(
        !trimmed.chars().any(|c| c.is_control()),
        EtfError::ProfileNameNotPrintable
    );

    let profile = &mut ctx.accounts.profile;
    profile.owner = ctx.accounts.owner.key();
    profile.name = trimmed.to_string();
    profile.bump = ctx.bumps.profile;

    emit!(ProfileSet {
        owner: profile.owner,
        name: profile.name.clone(),
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
