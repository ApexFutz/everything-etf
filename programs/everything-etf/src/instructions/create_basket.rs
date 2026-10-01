use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::{self, get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::metadata::{
    create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
    Metadata,
};
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::token_2022::Token2022;

use crate::constants::*;
use crate::errors::EtfError;
use crate::events::BasketCreated;
use crate::state::{Basket, Config};
use crate::utils::{token_program_for, validate_asset_mint};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateBasketParams {
    pub name: String,
    pub symbol: String,
    /// Metadata JSON URI. Its `external_url` should point at the basket page so
    /// pump.fun / fomo token pages link back to the holdings and history.
    pub uri: String,
    pub mint_fee_bps: u16,
    pub redeem_fee_bps: u16,
    pub streaming_fee_bps: u16,
}

/// Creates a basket: state account, basket token mint + metadata, fee escrow,
/// and one vault (ATA owned by the basket PDA) per underlying asset.
///
/// Remaining accounts: `[asset_mint, asset_vault]` per asset, in order.
#[derive(Accounts)]
pub struct CreateBasket<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: receives the creation fee; must match config.treasury.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        init,
        payer = manager,
        space = 8 + Basket::INIT_SPACE,
        seeds = [BASKET_SEED, &config.basket_count.to_le_bytes()],
        bump,
    )]
    pub basket: Box<Account<'info, Basket>>,

    #[account(
        init,
        payer = manager,
        seeds = [BASKET_MINT_SEED, basket.key().as_ref()],
        bump,
        mint::decimals = BASKET_DECIMALS,
        mint::authority = basket,
        mint::token_program = token_program,
    )]
    pub basket_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = manager,
        associated_token::mint = basket_mint,
        associated_token::authority = basket,
        associated_token::token_program = token_program,
    )]
    pub fee_escrow: Box<Account<'info, TokenAccount>>,

    /// CHECK: Metaplex metadata PDA for basket_mint; created by the CPI below.
    #[account(
        mut,
        seeds = [b"metadata", token_metadata_program.key().as_ref(), basket_mint.key().as_ref()],
        bump,
        seeds::program = token_metadata_program.key(),
    )]
    pub metadata: UncheckedAccount<'info>,

    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, CreateBasket<'info>>,
    params: CreateBasketParams,
) -> Result<()> {
    require!(params.name.len() <= MAX_NAME_LEN, EtfError::MetadataTooLong);
    require!(params.symbol.len() <= MAX_SYMBOL_LEN, EtfError::MetadataTooLong);
    require!(params.uri.len() <= MAX_URI_LEN, EtfError::MetadataTooLong);
    require!(params.mint_fee_bps <= MAX_MINT_FEE_BPS, EtfError::FeeAboveCap);
    require!(params.redeem_fee_bps <= MAX_REDEEM_FEE_BPS, EtfError::FeeAboveCap);
    require!(params.streaming_fee_bps <= MAX_STREAMING_FEE_BPS, EtfError::FeeAboveCap);

    let remaining = ctx.remaining_accounts;
    require!(remaining.len() % 2 == 0, EtfError::InvalidRemainingAccounts);
    let n = remaining.len() / 2;
    require!((MIN_ASSETS..=MAX_ASSETS).contains(&n), EtfError::InvalidAssetCount);

    let basket_key = ctx.accounts.basket.key();
    let token_program = ctx.accounts.token_program.to_account_info();
    let token_2022_program = ctx.accounts.token_2022_program.to_account_info();

    // Validate assets and create one vault per asset.
    let mut assets: Vec<Pubkey> = Vec::with_capacity(n);
    for i in 0..n {
        let mint = &remaining[i * 2];
        let vault = &remaining[i * 2 + 1];
        require!(!assets.contains(&mint.key()), EtfError::DuplicateAsset);
        validate_asset_mint(mint)?;

        let tp = token_program_for(mint, &token_program, &token_2022_program)?;
        let expected_vault = get_associated_token_address_with_program_id(&basket_key, mint.key, tp.key);
        require_keys_eq!(vault.key(), expected_vault, EtfError::InvalidVault);

        associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: ctx.accounts.manager.to_account_info(),
                associated_token: vault.clone(),
                authority: ctx.accounts.basket.to_account_info(),
                mint: mint.clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: tp,
            },
        ))?;
        assets.push(mint.key());
    }

    // Creation fee -> protocol treasury.
    let config = &mut ctx.accounts.config;
    let creation_fee = config.creation_fee_lamports;
    if creation_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.manager.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            creation_fee,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    let id = config.basket_count;
    let protocol_share_bps = config.protocol_share_bps;
    config.basket_count = id.checked_add(1).ok_or(EtfError::MathOverflow)?;

    let basket = &mut ctx.accounts.basket;
    basket.id = id;
    basket.manager = ctx.accounts.manager.key();
    basket.mint = ctx.accounts.basket_mint.key();
    basket.fee_escrow = ctx.accounts.fee_escrow.key();
    basket.assets = assets.clone();
    basket.mint_fee_bps = params.mint_fee_bps;
    basket.redeem_fee_bps = params.redeem_fee_bps;
    basket.streaming_fee_bps = params.streaming_fee_bps;
    basket.protocol_share_bps = protocol_share_bps;
    basket.manager_fees_accrued = 0;
    basket.protocol_fees_accrued = 0;
    basket.last_fee_accrual = now;
    basket.created_at = now;
    basket.bump = ctx.bumps.basket;
    basket.mint_bump = ctx.bumps.basket_mint;

    // Basket token metadata. The basket PDA is update authority, so nobody
    // (including the manager) can silently swap the name or link.
    let id_bytes = id.to_le_bytes();
    let bump = [basket.bump];
    let seeds: &[&[u8]] = &[BASKET_SEED, &id_bytes, &bump];
    create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            ctx.accounts.token_metadata_program.to_account_info(),
            CreateMetadataAccountsV3 {
                metadata: ctx.accounts.metadata.to_account_info(),
                mint: ctx.accounts.basket_mint.to_account_info(),
                mint_authority: ctx.accounts.basket.to_account_info(),
                payer: ctx.accounts.manager.to_account_info(),
                update_authority: ctx.accounts.basket.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            &[seeds],
        ),
        DataV2 {
            name: params.name.clone(),
            symbol: params.symbol.clone(),
            uri: params.uri.clone(),
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        },
        true,
        true,
        None,
    )?;

    emit!(BasketCreated {
        basket: basket_key,
        id,
        manager: ctx.accounts.manager.key(),
        mint: ctx.accounts.basket_mint.key(),
        assets,
        name: params.name,
        symbol: params.symbol,
        uri: params.uri,
        mint_fee_bps: params.mint_fee_bps,
        redeem_fee_bps: params.redeem_fee_bps,
        streaming_fee_bps: params.streaming_fee_bps,
        protocol_share_bps,
        creation_fee_lamports: creation_fee,
        timestamp: now,
    });
    Ok(())
}
