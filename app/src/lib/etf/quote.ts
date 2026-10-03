/**
 * Pure math mirroring programs/everything-etf/src/math.rs's
 * deposit_for_mint/payout_for_burn/bps_of exactly (same rounding direction,
 * same bigint-equivalent u128 intermediate — u64 overflow isn't a concern in
 * JS's arbitrary-precision bigint the way it is in Rust's u128). Used to
 * quote real max_amounts_in/min_amounts_out instead of sending permissive
 * placeholder bounds.
 *
 * These are quotes, not guarantees: vault balances and supply can change
 * between quoting and the transaction landing. That's exactly what the
 * slippage tolerance applied on top is for — it does not make staleness
 * disappear, only bounds how much of it you'll accept.
 */
import { BPS } from "./constants";

/** `amount * bps / 10_000`, rounded down — matches `math::bps_of`. */
export function bpsOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / BPS;
}

/** Underlying deposit required for `amount` basket tokens. Rounds up. */
export function depositForMint(vaultBalance: bigint, amount: bigint, supply: bigint): bigint {
  if (supply <= 0n) throw new Error("basket has not been seeded yet");
  return (vaultBalance * amount + supply - 1n) / supply;
}

/** Underlying payout for burning `amount` of `supply`. Rounds down. */
export function payoutForBurn(vaultBalance: bigint, amount: bigint, supply: bigint): bigint {
  if (supply <= 0n) throw new Error("basket has not been seeded yet");
  return (vaultBalance * amount) / supply;
}

/**
 * Per-asset deposit quote for `mint_basket`, with a slippage tolerance
 * applied on top (e.g. 0.01 for 1%) to get `max_amounts_in`.
 */
export function quoteMintDeposits(
  vaultBalances: bigint[],
  grossAmount: bigint,
  supply: bigint,
  slippage: number,
): { quoted: bigint[]; maxAmountsIn: bigint[] } {
  const quoted = vaultBalances.map((v) => depositForMint(v, grossAmount, supply));
  const maxAmountsIn = quoted.map((q) => q + bpsOf(q, Math.round(slippage * 10_000)));
  return { quoted, maxAmountsIn };
}

/**
 * Per-asset payout quote for `redeem_basket` (fee taken out first, exactly
 * as the program does), with a slippage tolerance applied to get
 * `min_amounts_out`.
 */
export function quoteRedeemPayouts(
  vaultBalances: bigint[],
  grossAmount: bigint,
  supply: bigint,
  redeemFeeBps: number,
  slippage: number,
): { quoted: bigint[]; minAmountsOut: bigint[] } {
  const fee = bpsOf(grossAmount, redeemFeeBps);
  const net = grossAmount - fee;
  const quoted = vaultBalances.map((v) => payoutForBurn(v, net, supply));
  const minAmountsOut = quoted.map((q) => {
    const slip = bpsOf(q, Math.round(slippage * 10_000));
    return q > slip ? q - slip : 0n;
  });
  return { quoted, minAmountsOut };
}
