/**
 * What a basket is worth, in dollars.
 *
 * The program deliberately has no oracle — redemption is defined by division
 * (`vault_balance * amount / supply`), so the chain never needs to know what
 * anything is priced at. But a person deciding whether to buy one does, so
 * valuation lives here, off-chain, and is never used to settle anything.
 *
 * Note what this is NOT: the market price of the basket token. It is the value
 * of the assets backing it. Those are the same number only when arbitrage is
 * working, which is the whole point of charging nothing to mint or redeem.
 */
import { PublicKey } from "@solana/web3.js";
import { fetchUsdPrices } from "./pricing";

export interface AssetValue {
  mint: PublicKey;
  decimals: number;
  /** Raw vault balance, base units. */
  balance: bigint;
  /** USD per whole token, or null when nothing quotes it. */
  priceUsd: number | null;
  /** balance × price, or null when unpriced. */
  valueUsd: number | null;
  /** Share of the basket's total value, 0–1. Null when unpriced. */
  weight: number | null;
}

export interface BasketNav {
  assets: AssetValue[];
  /** Summed value of everything priced. */
  totalUsd: number;
  /** Basket-token supply, base units. */
  supply: bigint;
  /** USD backing one whole basket token. */
  navPerToken: number;
  /**
   * Assets we couldn't price. A basket with any of these has a `totalUsd`
   * that understates it, so callers must surface this rather than quietly
   * showing a number that's too low.
   */
  unpriced: PublicKey[];
}

/** Whole-token count from a raw base-unit amount. */
export function toWhole(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * Values each vault at its live price and derives the per-token NAV.
 *
 * `decimals` must line up with `assets` and `balances` — the caller already
 * has them from the mint accounts it read to get the balances.
 */
export async function computeNav(
  assets: PublicKey[],
  balances: bigint[],
  decimals: number[],
  supply: bigint,
  basketDecimals: number,
): Promise<BasketNav> {
  const prices = await fetchUsdPrices(assets.map((a) => a.toBase58()));

  const valued: AssetValue[] = assets.map((mint, i) => {
    const priceUsd = prices[mint.toBase58()] ?? null;
    const valueUsd = priceUsd === null ? null : toWhole(balances[i], decimals[i]) * priceUsd;
    return { mint, decimals: decimals[i], balance: balances[i], priceUsd, valueUsd, weight: null };
  });

  const totalUsd = valued.reduce((sum, a) => sum + (a.valueUsd ?? 0), 0);
  for (const a of valued) {
    a.weight = a.valueUsd === null || totalUsd === 0 ? null : a.valueUsd / totalUsd;
  }

  const wholeSupply = toWhole(supply, basketDecimals);
  return {
    assets: valued,
    totalUsd,
    supply,
    navPerToken: wholeSupply > 0 ? totalUsd / wholeSupply : 0,
    unpriced: valued.filter((a) => a.priceUsd === null).map((a) => a.mint),
  };
}

/**
 * How many basket tokens (base units) a given dollar amount buys at NAV.
 *
 * Deliberately exact rather than rounded to whole tokens: the deposit each
 * asset needs is derived from this number, and rounding here would show the
 * user a dollar figure that doesn't match what they're charged.
 */
export function tokensForUsd(usd: number, nav: BasketNav, basketDecimals: number): bigint {
  if (!(nav.navPerToken > 0)) throw new Error("basket has no priced value");
  return BigInt(Math.floor((usd / nav.navPerToken) * 10 ** basketDecimals));
}
