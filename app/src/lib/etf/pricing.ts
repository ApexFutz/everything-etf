/**
 * USD pricing for the launch fee.
 *
 * The $EETF creation fee is stored on-chain as a fixed number of base units,
 * but the *policy* is a dollar amount: launching a basket should cost about
 * $5 of $EETF. A fixed token amount can't hold that on its own — if $EETF
 * appreciates 10x, launching costs 10x in real terms and launches stop, which
 * stops the burn that the whole supply story rests on; if it craters, the fee
 * stops filtering anything and spam baskets return.
 *
 * So the fixed amount is treated as a cached quote of the real target, and
 * `scripts/repeg-coin-fee-devnet.mts` re-quotes it through `update_coin_terms`
 * when it drifts. Everything here is the shared math between that script and
 * the UI, which shows the live dollar value next to the fee so drift is
 * visible to anyone launching rather than only to whoever runs the script.
 */
import { COIN_DECIMALS } from "./constants";

/** The policy: a basket launch costs this much in $EETF, whatever the price. */
export const CREATION_FEE_USD_TARGET = 5;

/**
 * How far the on-chain amount may drift from the target before it's worth a
 * re-peg transaction. Re-pegging on every wobble is noise; this is wide enough
 * that normal volatility doesn't trigger it and narrow enough that the fee
 * can't quietly become 2x or half the target.
 */
export const REPEG_TOLERANCE = 0.25;

const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";

/**
 * Wrapped SOL, for pricing the SOL leg of the launch cost. Jupiter's index is
 * mainnet, so this is the mainnet mint regardless of which cluster the app is
 * pointed at — a devnet SOL price is still the mainnet SOL price.
 */
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Spot USD price from Jupiter, or null when the token has no market yet —
 * which is the case for $EETF until it trades, so callers must handle it
 * rather than defaulting to a number.
 */
export async function fetchUsdPrice(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`${JUPITER_PRICE_URL}?ids=${mint}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, { usdPrice?: number } | undefined>;
    const price = body[mint]?.usdPrice;
    return typeof price === "number" && price > 0 ? price : null;
  } catch {
    return null; // offline or rate-limited — callers fall back to the cached amount
  }
}

/** Base units of $EETF worth `usd` at `priceUsd` per whole coin. */
export function coinAmountForUsd(usd: number, priceUsd: number): bigint {
  if (!(priceUsd > 0)) throw new Error("price must be positive");
  const whole = usd / priceUsd;
  // Round to whole coins: a fee quoted to nine decimals is false precision,
  // and a round number is what a launcher sees in their wallet.
  return BigInt(Math.max(1, Math.round(whole))) * 10n ** BigInt(COIN_DECIMALS);
}

/** Dollar value of a raw $EETF amount. */
export function usdValueOfCoin(amount: bigint, priceUsd: number): number {
  return (Number(amount) / 10 ** COIN_DECIMALS) * priceUsd;
}

/** The price at which `amount` of $EETF is worth exactly the target. */
export function impliedPriceForTarget(amount: bigint, usd = CREATION_FEE_USD_TARGET): number {
  const whole = Number(amount) / 10 ** COIN_DECIMALS;
  return whole > 0 ? usd / whole : 0;
}
