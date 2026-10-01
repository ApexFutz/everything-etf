use anchor_lang::prelude::*;

#[error_code]
pub enum EtfError {
    #[msg("A basket needs between 2 and 10 assets")]
    InvalidAssetCount,
    #[msg("The same asset was listed twice")]
    DuplicateAsset,
    #[msg("Asset mint is not owned by the SPL Token or Token-2022 program")]
    InvalidAssetMint,
    #[msg("Asset mints with a freeze authority are not allowed")]
    FreezeAuthorityNotAllowed,
    #[msg("Asset uses a Token-2022 extension that is not supported")]
    UnsupportedTokenExtension,
    #[msg("Remaining accounts do not match the expected layout")]
    InvalidRemainingAccounts,
    #[msg("Asset account does not match the basket's asset list")]
    AssetMismatch,
    #[msg("Vault account is not the basket's associated token account")]
    InvalidVault,
    #[msg("Token account has the wrong owner")]
    InvalidTokenOwner,
    #[msg("Fee exceeds the protocol hard cap")]
    FeeAboveCap,
    #[msg("Fees can only be lowered")]
    FeeIncreaseNotAllowed,
    #[msg("Protocol share exceeds the hard cap")]
    ProtocolShareAboveCap,
    #[msg("Name, symbol or URI is too long")]
    MetadataTooLong,
    #[msg("Basket has already been seeded")]
    AlreadySeeded,
    #[msg("Basket has not been seeded yet")]
    NotSeeded,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Amount list length does not match the number of assets")]
    AmountListMismatch,
    #[msg("Required deposit exceeds max_amounts_in")]
    SlippageIn,
    #[msg("Payout is below min_amounts_out")]
    SlippageOut,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Signer is not allowed to perform this action")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
