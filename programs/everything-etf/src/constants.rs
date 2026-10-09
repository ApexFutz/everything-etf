//! Protocol-wide constants. Fee caps are hardcoded so no manager or admin can
//! ever raise fees beyond these limits, even with a program-level setting.

/// Basis-point denominator (100% = 10_000 bps).
pub const BPS: u64 = 10_000;

/// Basket size limits.
pub const MIN_ASSETS: usize = 2;
pub const MAX_ASSETS: usize = 10;

/// Hard fee caps — all zero. **A basket charges nothing.**
///
/// The only thing anyone pays is the launch fee, once, to create the basket.
/// After that a basket is a pure in-kind wrapper: minting, holding and
/// redeeming are all free, forever, for everyone.
///
/// Three things fall out of that, and they are the reason for it:
///
/// - **The basket tracks NAV as tightly as the mechanism allows.** Every basis
///   point charged on the way in or out widens the band the market price can
///   drift inside before arbitrage pays to close it. At zero there is no band.
/// - **A manager earns by being right, not by extracting.** They hold 100% of
///   the starting supply, so their return is the basket appreciating — the same
///   way every other holder makes money. There is no fee stream to harvest and
///   nothing to dump.
/// - **Nothing can be turned on later behind a holder's back.** These are
///   compiled in, not configured, so no authority can raise them.
///
/// The fee plumbing underneath (`fee_escrow`, the accrual and claim
/// instructions, `protocol_share_bps`) is left in place but unreachable: with
/// every cap at zero, nothing ever accrues and there is never anything to
/// claim. Future revenue is intended to come from mechanics that sit beside
/// the basket rather than taxing it.
pub const MAX_MINT_FEE_BPS: u16 = 0;
pub const MAX_REDEEM_FEE_BPS: u16 = 0;
pub const MAX_STREAMING_FEE_BPS: u16 = 0;
/// Moot while the caps above are zero — there are no fees to take a share of —
/// but still enforced on `initialize_config` so the stored value can't be
/// nonsense if fees ever return.
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

// ---------------------------------------------------------------------------
// $EETF — the protocol coin
// ---------------------------------------------------------------------------

/// Coin decimals (same as basket tokens).
pub const COIN_DECIMALS: u8 = 9;

/// Fixed supply: 1,000,000,000 EETF. Minted once in `initialize_coin`, which
/// then revokes the mint authority forever. Supply can only ever go down.
pub const COIN_TOTAL_SUPPLY: u64 = 1_000_000_000 * 1_000_000_000;

/// Floor on the burned share of every basket-creation fee. The protocol
/// authority can raise the burn share but never push it below this.
pub const MIN_CREATION_BURN_BPS: u16 = 5_000; // 50%

/// Ceiling on the basket-creation fee, so the authority can never price new
/// managers out: 1% of the genesis supply.
pub const MAX_CREATION_FEE_COIN: u64 = 10_000_000 * 1_000_000_000;

/// Coin PDA seeds.
pub const COIN_SEED: &[u8] = b"coin";
pub const COIN_MINT_SEED: &[u8] = b"coin_mint";
