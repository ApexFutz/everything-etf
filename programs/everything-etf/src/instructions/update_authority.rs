use anchor_lang::prelude::*;

use crate::constants::CONFIG_SEED;
use crate::errors::EtfError;
use crate::events::AuthorityUpdated;
use crate::state::Config;

/// Hands the protocol authority to a new key.
///
/// **Both** the current and the incoming authority must sign. That is the only
/// guard against the failure mode that matters here: setting this field to an
/// address nobody controls (a typo, a wrong clipboard paste, a wallet that was
/// never actually backed up) would permanently lock the protocol out of its own
/// admin role, with no way back short of a program upgrade. An address that
/// can't produce a signature can't be installed, so that can't happen.
///
/// This is what makes it possible to put the authority behind a multisig after
/// the fact — the multisig signs as the incoming party. Without this
/// instruction the authority was whatever key called `initialize_config`,
/// forever.
#[derive(Accounts)]
pub struct UpdateAuthority<'info> {
    pub authority: Signer<'info>,

    /// The incoming authority. A `Signer`, not a bare pubkey argument, on
    /// purpose — see the note above.
    pub new_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ EtfError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<UpdateAuthority>) -> Result<()> {
    let previous = ctx.accounts.config.authority;
    let new_authority = ctx.accounts.new_authority.key();

    // Rotating to the key that already holds it is a no-op that would emit a
    // misleading event; treat it as a mistake rather than silently accepting.
    require_keys_neq!(previous, new_authority, EtfError::AuthorityUnchanged);

    ctx.accounts.config.authority = new_authority;

    emit!(AuthorityUpdated {
        previous,
        new_authority,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
