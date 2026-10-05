use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::{self, Burn, Mint, MintTo};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::Mint as Mint2022State,
};
use anchor_spl::token_interface::{
    self, Mint as AnyMint, TokenAccount as AnyTokenAccount, TransferChecked,
};

use crate::constants::BASKET_SEED;
use crate::errors::EtfError;
use crate::events::StreamingFeeAccrued;
use crate::math;
use crate::state::{Basket, CoinConfig};

/// Burns $EETF and records it. **This is the only way $EETF may be burned.**
///
/// `CoinConfig.total_burned` is not just a dashboard number: it is the meter
/// that every claim about the supply rests on, and it is intended to gate how
/// fast locked allocations may be released, so a burn that doesn't increment it
/// is a burn that never happened as far as the protocol is concerned. Keeping
/// the CPI and the counter in one place means a new $EETF sink cannot get that
/// pairing wrong — including the `reload()`, without which the caller's
/// `coin_mint.supply` is the pre-burn figure and any event reporting it lies.
///
/// Not for basket tokens. `redeem_basket` and `claim_fees` also call
/// `token::burn`, on a *basket* mint, and those must not touch this counter —
/// the `CoinConfig`/`coin_mint` arguments are what keep that mistake from
/// compiling.
///
/// Pass `&[]` as `signer_seeds` when the burn is authorised by a user who
/// signed the transaction, or the coin PDA's seeds when the protocol itself is
/// burning from an account it owns. Returns the new lifetime total, so callers
/// can emit it without re-borrowing `coin_config`.
pub fn burn_coin<'info>(
    coin_config: &mut Account<'info, CoinConfig>,
    coin_mint: &mut Account<'info, Mint>,
    from: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<u64> {
    // A zero-amount burn is a legitimate no-op (a 100%-dev fee split, say);
    // the CPI would succeed and change nothing, so skip it. Supply is
    // unchanged, which is why there's nothing to reload.
    if amount == 0 {
        return Ok(coin_config.total_burned);
    }

    token::burn(
        CpiContext::new_with_signer(
            token_program.clone(),
            Burn {
                mint: coin_mint.to_account_info(),
                from: from.clone(),
                authority: authority.clone(),
            },
            signer_seeds,
        ),
        amount,
    )?;
    coin_mint.reload()?;

    coin_config.total_burned = coin_config
        .total_burned
        .checked_add(amount)
        .ok_or(EtfError::MathOverflow)?;
    Ok(coin_config.total_burned)
}

/// Picks the token program that owns an asset mint.
pub fn token_program_for<'info>(
    mint: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
) -> Result<AccountInfo<'info>> {
    if *mint.owner == token::ID {
        Ok(token_program.clone())
    } else if *mint.owner == anchor_spl::token_2022::ID {
        Ok(token_2022_program.clone())
    } else {
        err!(EtfError::InvalidAssetMint)
    }
}

/// Rejects asset mints that could trap or drain the vault:
/// - any freeze authority (vault could be frozen)
/// - Token-2022 extensions other than metadata/group pointers
///   (transfer fees break accounting, permanent delegates can drain, hooks can block).
pub fn validate_asset_mint(mint: &AccountInfo) -> Result<()> {
    if *mint.owner == token::ID {
        let data = mint.try_borrow_data()?;
        let state = anchor_spl::token::spl_token::state::Mint::unpack(&data)?;
        require!(
            state.freeze_authority.is_none(),
            EtfError::FreezeAuthorityNotAllowed
        );
        return Ok(());
    }
    if *mint.owner == anchor_spl::token_2022::ID {
        let data = mint.try_borrow_data()?;
        let state = StateWithExtensions::<Mint2022State>::unpack(&data)?;
        require!(
            state.base.freeze_authority.is_none(),
            EtfError::FreezeAuthorityNotAllowed
        );
        for ext in state.get_extension_types()? {
            match ext {
                ExtensionType::MetadataPointer
                | ExtensionType::TokenMetadata
                | ExtensionType::GroupPointer
                | ExtensionType::GroupMemberPointer
                | ExtensionType::TokenGroup
                | ExtensionType::TokenGroupMember => {}
                _ => return err!(EtfError::UnsupportedTokenExtension),
            }
        }
        return Ok(());
    }
    err!(EtfError::InvalidAssetMint)
}

/// One underlying asset's accounts for a mint/redeem/claim/seed instruction.
pub struct AssetLeg<'info> {
    pub mint: AccountInfo<'info>,
    pub vault: AccountInfo<'info>,
    /// The user's (or fee recipient's) token account for this asset.
    pub party: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub decimals: u8,
    pub vault_balance: u64,
}

/// Parses remaining accounts laid out as `[asset_mint, vault, party_account]`
/// per asset, in the basket's asset order, and validates every one.
pub fn load_asset_legs<'info>(
    remaining: &'info [AccountInfo<'info>],
    basket_key: &Pubkey,
    assets: &[Pubkey],
    party_owner: &Pubkey,
    token_program: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
) -> Result<Vec<AssetLeg<'info>>> {
    require!(
        remaining.len() == assets.len() * 3,
        EtfError::InvalidRemainingAccounts
    );
    let mut legs = Vec::with_capacity(assets.len());
    for (i, expected_mint) in assets.iter().enumerate() {
        let mint = &remaining[i * 3];
        let vault = &remaining[i * 3 + 1];
        let party = &remaining[i * 3 + 2];

        require_keys_eq!(mint.key(), *expected_mint, EtfError::AssetMismatch);
        let tp = token_program_for(mint, token_program, token_2022_program)?;

        let expected_vault =
            get_associated_token_address_with_program_id(basket_key, expected_mint, tp.key);
        require_keys_eq!(vault.key(), expected_vault, EtfError::InvalidVault);

        let mint_acc = InterfaceAccount::<AnyMint>::try_from(mint)?;
        let vault_acc = InterfaceAccount::<AnyTokenAccount>::try_from(vault)?;
        let party_acc = InterfaceAccount::<AnyTokenAccount>::try_from(party)?;
        require_keys_eq!(party_acc.mint, *expected_mint, EtfError::AssetMismatch);
        require_keys_eq!(party_acc.owner, *party_owner, EtfError::InvalidTokenOwner);

        legs.push(AssetLeg {
            mint: mint.clone(),
            vault: vault.clone(),
            party: party.clone(),
            token_program: tp,
            decimals: mint_acc.decimals,
            vault_balance: vault_acc.amount,
        });
    }
    Ok(legs)
}

/// party -> vault, signed by the party.
pub fn deposit_leg<'info>(
    leg: &AssetLeg<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new(
            leg.token_program.clone(),
            TransferChecked {
                from: leg.party.clone(),
                mint: leg.mint.clone(),
                to: leg.vault.clone(),
                authority: authority.clone(),
            },
        ),
        amount,
        leg.decimals,
    )
}

/// vault -> party, signed by the basket PDA.
pub fn payout_leg<'info>(
    leg: &AssetLeg<'info>,
    basket: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            leg.token_program.clone(),
            TransferChecked {
                from: leg.vault.clone(),
                mint: leg.mint.clone(),
                to: leg.party.clone(),
                authority: basket.clone(),
            },
            signer,
        ),
        amount,
        leg.decimals,
    )
}

/// Mints the streaming (management) fee for time elapsed since the last
/// accrual into the fee escrow and splits it between protocol and manager.
/// Called at the start of every instruction that reads supply.
pub fn accrue_streaming_fee<'info>(
    basket: &mut Account<'info, Basket>,
    basket_mint: &mut Account<'info, Mint>,
    fee_escrow: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    now: i64,
) -> Result<()> {
    let elapsed = now.saturating_sub(basket.last_fee_accrual).max(0) as u64;
    let minted = math::streaming_fee_tokens(basket_mint.supply, basket.streaming_fee_bps, elapsed)?;
    basket.last_fee_accrual = now;
    if minted == 0 {
        return Ok(());
    }

    let id_bytes = basket.id.to_le_bytes();
    let bump = [basket.bump];
    let seeds: &[&[u8]] = &[BASKET_SEED, &id_bytes, &bump];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program.clone(),
            MintTo {
                mint: basket_mint.to_account_info(),
                to: fee_escrow.clone(),
                authority: basket.to_account_info(),
            },
            &[seeds],
        ),
        minted,
    )?;
    basket_mint.reload()?;

    let (to_protocol, to_manager) = math::split_fee(minted, basket.protocol_share_bps)?;
    basket.protocol_fees_accrued = basket
        .protocol_fees_accrued
        .checked_add(to_protocol)
        .ok_or(EtfError::MathOverflow)?;
    basket.manager_fees_accrued = basket
        .manager_fees_accrued
        .checked_add(to_manager)
        .ok_or(EtfError::MathOverflow)?;

    emit!(StreamingFeeAccrued {
        basket: basket.key(),
        minted,
        to_protocol,
        to_manager,
        elapsed_seconds: elapsed,
        timestamp: now,
    });
    Ok(())
}

/// Credits a mint/redeem fee (already sitting in escrow) to the two ledgers.
pub fn credit_fee(basket: &mut Basket, fee: u64) -> Result<()> {
    let (to_protocol, to_manager) = math::split_fee(fee, basket.protocol_share_bps)?;
    basket.protocol_fees_accrued = basket
        .protocol_fees_accrued
        .checked_add(to_protocol)
        .ok_or(EtfError::MathOverflow)?;
    basket.manager_fees_accrued = basket
        .manager_fees_accrued
        .checked_add(to_manager)
        .ok_or(EtfError::MathOverflow)?;
    Ok(())
}
