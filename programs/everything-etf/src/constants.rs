//! Protocol-wide constants. Fee caps are hardcoded so no manager or admin can
//! ever raise fees beyond these limits, even with a program-level setting.

/// Basis-point denominator (100% = 10_000 bps).
pub const BPS: u64 = 10_000;

/// Basket size limits.
pub const MIN_ASSETS: usize = 2;
pub const MAX_ASSETS: usize = 10;

/// Hard fee caps.
pub const MAX_MINT_FEE_BPS: u16 = 100; // 1%
pub const MAX_REDEEM_FEE_BPS: u16 = 100; // 1%
pub const MAX_STREAMING_FEE_BPS: u16 = 300; // 3% per year
pub const MAX_PROTOCOL_SHARE_BPS: u16 = 3_000; // 30% of fees, ever

/// Every fee claim (manager or protocol) pays 25% in basket tokens and 75% in
/// the "cash" leg. In v0.1 the cash leg is paid in-kind (underlying tokens);
/// step 2 routes it through Jupiter so it arrives as SOL.
pub const TOKEN_PAYOUT_BPS: u64 = 2_500;

pub const SECONDS_PER_YEAR: u64 = 31_536_000;

/// Basket token decimals.
pub const BASKET_DECIMALS: u8 = 9;

/// Metadata limits (Metaplex limits are 32 / 10 / 200).
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;

/// PDA seeds.
pub const CONFIG_SEED: &[u8] = b"config";
pub const BASKET_SEED: &[u8] = b"basket";
pub const BASKET_MINT_SEED: &[u8] = b"basket_mint";
