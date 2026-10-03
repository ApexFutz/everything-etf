//! Pure fee and share math. No accounts, so it is fully unit-tested on the host.
//!
//! Rounding always favours the vault (existing holders):
//! deposits round up, payouts round down, fees round down.

use anchor_lang::prelude::*;

use crate::constants::{BPS, SECONDS_PER_YEAR, TOKEN_PAYOUT_BPS};
use crate::errors::EtfError;

fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(EtfError::MathOverflow))
}

/// `amount * bps / 10_000`, rounded down.
pub fn bps_of(amount: u64, bps: u64) -> Result<u64> {
    to_u64((amount as u128) * (bps as u128) / (BPS as u128))
}

/// Splits a fee into (protocol, manager). The manager gets the rounding remainder.
pub fn split_fee(fee: u64, protocol_share_bps: u16) -> Result<(u64, u64)> {
    let protocol = bps_of(fee, protocol_share_bps as u64)?;
    Ok((protocol, fee - protocol))
}

/// Splits a claim into (basket-token leg, cash leg) using the 25/75 rule.
pub fn split_claim(total: u64) -> Result<(u64, u64)> {
    let token_leg = bps_of(total, TOKEN_PAYOUT_BPS)?;
    Ok((token_leg, total - token_leg))
}

/// Splits a basket-creation fee into (burned, development). The dev treasury
/// gets the rounding remainder; the burn leg is what the floor protects.
pub fn split_creation_fee(fee: u64, burn_bps: u16) -> Result<(u64, u64)> {
    let burned = bps_of(fee, burn_bps as u64)?;
    Ok((burned, fee - burned))
}

/// Underlying amount a minter must deposit for `amount` basket tokens. Rounds up.
pub fn deposit_for_mint(vault_balance: u64, amount: u64, supply: u64) -> Result<u64> {
    require!(supply > 0, EtfError::NotSeeded);
    let num = (vault_balance as u128) * (amount as u128);
    let s = supply as u128;
    to_u64((num + s - 1) / s)
}

/// Underlying amount paid out for burning `amount` of `supply`. Rounds down.
pub fn payout_for_burn(vault_balance: u64, amount: u64, supply: u64) -> Result<u64> {
    require!(supply > 0, EtfError::NotSeeded);
    to_u64((vault_balance as u128) * (amount as u128) / (supply as u128))
}

/// Basket tokens to mint so that, after minting, the fee recipients own exactly
/// `rate * elapsed / year` of the new supply:
///   x / (S + x) = f   =>   x = S * f / (1 - f)
/// with f = bps * elapsed / (10_000 * year). `elapsed` is capped at one year,
/// and since bps <= 300 the denominator always stays positive.
pub fn streaming_fee_tokens(supply: u64, annual_bps: u16, elapsed_seconds: u64) -> Result<u64> {
    if supply == 0 || annual_bps == 0 || elapsed_seconds == 0 {
        return Ok(0);
    }
    let elapsed = elapsed_seconds.min(SECONDS_PER_YEAR) as u128;
    let bps = annual_bps as u128;
    let full = (BPS as u128) * (SECONDS_PER_YEAR as u128);
    let num = (supply as u128) * bps * elapsed;
    let den = full
        .checked_sub(bps * elapsed)
        .ok_or(error!(EtfError::MathOverflow))?;
    to_u64(num / den)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{COIN_TOTAL_SUPPLY, MAX_CREATION_FEE_COIN, MIN_CREATION_BURN_BPS};

    #[test]
    fn fee_split_protocol_ten_percent() {
        // 1 SOL worth of fee units, 10% protocol share.
        let (p, m) = split_fee(1_000_000_000, 1_000).unwrap();
        assert_eq!(p, 100_000_000);
        assert_eq!(m, 900_000_000);
    }

    #[test]
    fn fee_split_remainder_goes_to_manager() {
        let (p, m) = split_fee(7, 1_000).unwrap();
        assert_eq!(p + m, 7);
        assert_eq!(p, 0);
    }

    #[test]
    fn claim_split_is_25_75() {
        let (tok, cash) = split_claim(1_000).unwrap();
        assert_eq!(tok, 250);
        assert_eq!(cash, 750);
        let (tok, cash) = split_claim(3).unwrap();
        assert_eq!(tok + cash, 3);
    }

    #[test]
    fn full_fee_flow_matches_design() {
        // 1 unit of fee: protocol 0.075 cash + 0.025 tokens, manager 0.675 + 0.225.
        let fee = 1_000_000;
        let (p, m) = split_fee(fee, 1_000).unwrap();
        assert_eq!(split_claim(p).unwrap(), (25_000, 75_000));
        assert_eq!(split_claim(m).unwrap(), (225_000, 675_000));
    }

    #[test]
    fn creation_fee_splits_burn_and_dev() {
        let (burn, dev) = split_creation_fee(1_000_000, 7_000).unwrap();
        assert_eq!(burn, 700_000);
        assert_eq!(dev, 300_000);
    }

    #[test]
    fn creation_fee_split_is_exhaustive() {
        for fee in [0u64, 1, 3, 7, 999_999, u64::MAX] {
            for bps in [MIN_CREATION_BURN_BPS, 6_666, 10_000] {
                let (burn, dev) = split_creation_fee(fee, bps).unwrap();
                assert_eq!(burn.checked_add(dev), Some(fee), "fee {fee} bps {bps}");
            }
        }
    }

    #[test]
    fn creation_fee_floor_always_burns_at_least_half() {
        let fee = 1_000_000_000;
        let (burn, _) = split_creation_fee(fee, MIN_CREATION_BURN_BPS).unwrap();
        assert!(burn >= fee / 2);
    }

    #[test]
    fn genesis_supply_fits_in_u64() {
        assert!(COIN_TOTAL_SUPPLY < u64::MAX);
        assert!(MAX_CREATION_FEE_COIN < COIN_TOTAL_SUPPLY);
    }

    #[test]
    fn deposit_rounds_up_payout_rounds_down() {
        assert_eq!(deposit_for_mint(10, 1, 3).unwrap(), 4); // 3.33 -> 4
        assert_eq!(payout_for_burn(10, 1, 3).unwrap(), 3); // 3.33 -> 3
    }

    #[test]
    fn mint_then_redeem_never_profits() {
        let (vault, supply) = (1_000_003u64, 999_999u64);
        for amt in [1u64, 7, 1_000, 123_457] {
            let dep = deposit_for_mint(vault, amt, supply).unwrap();
            let out = payout_for_burn(vault + dep, amt, supply + amt).unwrap();
            assert!(out <= dep, "amt {amt}: out {out} > dep {dep}");
        }
    }

    #[test]
    fn streaming_fee_one_year_is_exact_share() {
        let supply = 1_000_000_000_000u64;
        let x = streaming_fee_tokens(supply, 200, SECONDS_PER_YEAR).unwrap();
        // Recipients should own ~2% of the new supply.
        let share = x as f64 / (supply + x) as f64;
        assert!((share - 0.02).abs() < 1e-9, "share {share}");
    }

    #[test]
    fn streaming_fee_caps_elapsed_at_one_year() {
        let a = streaming_fee_tokens(1_000_000, 300, SECONDS_PER_YEAR).unwrap();
        let b = streaming_fee_tokens(1_000_000, 300, SECONDS_PER_YEAR * 5).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn streaming_fee_zero_cases() {
        assert_eq!(streaming_fee_tokens(0, 200, 100).unwrap(), 0);
        assert_eq!(streaming_fee_tokens(100, 0, 100).unwrap(), 0);
        assert_eq!(streaming_fee_tokens(100, 200, 0).unwrap(), 0);
    }

    #[test]
    fn large_values_do_not_overflow() {
        assert!(deposit_for_mint(u64::MAX, u64::MAX, u64::MAX).is_ok());
        assert!(streaming_fee_tokens(u64::MAX / 2, 300, SECONDS_PER_YEAR).is_ok());
    }
}
