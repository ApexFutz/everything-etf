use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
    Metadata,
};
use anchor_spl::token::{
    self, spl_token::instruction::AuthorityType, Mint, MintTo, SetAuthority, Token, TokenAccount,
};

use crate::constants::*;
use crate::errors::EtfError;
use crate::events::CoinInitialized;
use crate::state::{CoinConfig, Config};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeCoinParams {
    pub name: String,
    pub symbol: String,
    /// Metadata JSON URI. **Permanent** — the metadata is created immutable.
    pub uri: String,
    /// Basket-creation fee in $EETF base units.
    pub creation_fee_coin: u64,
    /// Share of each creation fee that is burned (>= MIN_CREATION_BURN_BPS).
    pub creation_burn_bps: u16,
    pub dev_treasury: Pubkey,
}

/// Creates $EETF: mints the entire fixed supply to `genesis_account` and then
/// revokes the mint authority in the same transaction, so the supply is capped
/// forever and can only fall as baskets are created.
///
/// One-time; the `coin_config` PDA init makes a second call impossible.
#[derive(Accounts)]
pub struct InitializeCoin<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ EtfError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = authority,
        space = 8 + CoinConfig::INIT_SPACE,
        seeds = [COIN_SEED],
        bump,
    )]
    pub coin_config: Box<Account<'info, CoinConfig>>,

    #[account(
        init,
        payer = authority,
        seeds = [COIN_MINT_SEED],
        bump,
        mint::decimals = COIN_DECIMALS,
        mint::authority = coin_config,
        mint::token_program = token_program,
    )]
    pub coin_mint: Box<Account<'info, Mint>>,

    /// CHECK: owner of the genesis account; distribution happens off-chain from here.
    pub genesis_owner: UncheckedAccount<'info>,

    /// Receives 100% of the supply at genesis.
    #[account(
        init,
        payer = authority,
        associated_token::mint = coin_mint,
        associated_token::authority = genesis_owner,
        associated_token::token_program = token_program,
    )]
    pub genesis_account: Box<Account<'info, TokenAccount>>,

    /// One-way sink: anyone can send $EETF here, `crank_burn` destroys it.
    #[account(
        init,
        payer = authority,
        associated_token::mint = coin_mint,
        associated_token::authority = coin_config,
        associated_token::token_program = token_program,
    )]
    pub burn_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Metaplex metadata PDA for coin_mint; created by the CPI below.
    #[account(
        mut,
        seeds = [b"metadata", token_metadata_program.key().as_ref(), coin_mint.key().as_ref()],
        bump,
        seeds::program = token_metadata_program.key(),
    )]
    pub metadata: UncheckedAccount<'info>,

    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializeCoin>, params: InitializeCoinParams) -> Result<()> {
    require!(params.name.len() <= MAX_NAME_LEN, EtfError::MetadataTooLong);
    require!(params.symbol.len() <= MAX_SYMBOL_LEN, EtfError::MetadataTooLong);
    require!(params.uri.len() <= MAX_URI_LEN, EtfError::MetadataTooLong);
    require!(
        params.creation_burn_bps >= MIN_CREATION_BURN_BPS,
        EtfError::BurnShareBelowFloor
    );
    require!(params.creation_burn_bps as u64 <= BPS, EtfError::BurnShareBelowFloor);
    require!(
        params.creation_fee_coin <= MAX_CREATION_FEE_COIN,
        EtfError::CreationFeeAboveCap
    );

    let now = Clock::get()?.unix_timestamp;
    let coin_config = &mut ctx.accounts.coin_config;
    coin_config.mint = ctx.accounts.coin_mint.key();
    coin_config.dev_treasury = params.dev_treasury;
    coin_config.burn_vault = ctx.accounts.burn_vault.key();
    coin_config.creation_fee_coin = params.creation_fee_coin;
    coin_config.creation_burn_bps = params.creation_burn_bps;
    coin_config.total_burned = 0;
    coin_config.total_dev_fees = 0;
    coin_config.baskets_funded = 0;
    coin_config.bump = ctx.bumps.coin_config;
    coin_config.mint_bump = ctx.bumps.coin_mint;

    let bump = [coin_config.bump];
    let seeds: &[&[u8]] = &[COIN_SEED, &bump];
    let coin_config_info = coin_config.to_account_info();

    // Metadata first, while the PDA is still mint authority. `is_mutable = false`:
    // name, symbol and URI are frozen at genesis.
    create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            ctx.accounts.token_metadata_program.to_account_info(),
            CreateMetadataAccountsV3 {
                metadata: ctx.accounts.metadata.to_account_info(),
                mint: ctx.accounts.coin_mint.to_account_info(),
                mint_authority: coin_config_info.clone(),
                payer: ctx.accounts.authority.to_account_info(),
                update_authority: coin_config_info.clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            &[seeds],
        ),
        DataV2 {
            name: params.name,
            symbol: params.symbol,
            uri: params.uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        },
        false,
        true,
        None,
    )?;

    // The one and only mint.
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.coin_mint.to_account_info(),
                to: ctx.accounts.genesis_account.to_account_info(),
                authority: coin_config_info.clone(),
            },
            &[seeds],
        ),
        COIN_TOTAL_SUPPLY,
    )?;

    // Revoke it, in the same transaction. Nothing can ever mint $EETF again.
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: coin_config_info,
                account_or_mint: ctx.accounts.coin_mint.to_account_info(),
            },
            &[seeds],
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    ctx.accounts.coin_mint.reload()?;
    require!(
        ctx.accounts.coin_mint.mint_authority.is_none(),
        EtfError::MintAuthorityNotRevoked
    );

    emit!(CoinInitialized {
        mint: ctx.accounts.coin_mint.key(),
        genesis_account: ctx.accounts.genesis_account.key(),
        total_supply: COIN_TOTAL_SUPPLY,
        dev_treasury: params.dev_treasury,
        burn_vault: ctx.accounts.burn_vault.key(),
        creation_fee_coin: params.creation_fee_coin,
        creation_burn_bps: params.creation_burn_bps,
        timestamp: now,
    });
    Ok(())
}
