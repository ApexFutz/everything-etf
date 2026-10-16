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
import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readU64LE } from "./codec";
import { resolveForPricing } from "./demo";
import { fetchPriceData } from "./pricing";

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
  /** Percent move over 24h, e.g. -4.5. Absent when the source doesn't report one. */
  change24h?: number;
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
  /**
   * The basket's 24h move: each asset's move weighted by how much of the
   * basket it currently is. Null when nothing priced reports one.
   *
   * This is what the basket DID, not what a holder made. It ignores mints and
   * redeems, and there is no on-chain record of NAV at launch to measure a
   * since-inception return against.
   */
  change24h: number | null;
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
  /**
   * Mint to price each asset *as*, when that differs from the mint the vault
   * holds. Devnet stand-ins have no market of their own and are priced as the
   * real token they represent; everything else passes through unchanged.
   */
  priceKeys?: string[],
): Promise<BasketNav> {
  const keys = priceKeys ?? assets.map((a) => a.toBase58());
  const prices = await fetchPriceData(keys);

  const valued: AssetValue[] = assets.map((mint, i) => {
    const data = prices[keys[i]];
    const priceUsd = data?.usdPrice ?? null;
    const valueUsd = priceUsd === null ? null : toWhole(balances[i], decimals[i]) * priceUsd;
    return {
      mint,
      decimals: decimals[i],
      balance: balances[i],
      priceUsd,
      valueUsd,
      weight: null,
      change24h: data?.change24h,
    };
  });

  const totalUsd = valued.reduce((sum, a) => sum + (a.valueUsd ?? 0), 0);
  for (const a of valued) {
    a.weight = a.valueUsd === null || totalUsd === 0 ? null : a.valueUsd / totalUsd;
  }

  // Weighted by current value, so a 50% asset moves the basket twice as much as
  // a 25% one. Assets with no reported move are left out of both sides rather
  // than counted as flat, which would drag the result toward zero.
  const movers = valued.filter((a) => a.change24h !== undefined && a.valueUsd !== null);
  const moverValue = movers.reduce((acc, a) => acc + a.valueUsd!, 0);
  const change24h =
    movers.length > 0 && moverValue > 0
      ? movers.reduce((acc, a) => acc + a.change24h! * (a.valueUsd! / moverValue), 0)
      : null;

  const wholeSupply = toWhole(supply, basketDecimals);
  return {
    change24h,
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

/**
 * NAV for a whole page of baskets at once.
 *
 * The per-basket path would be two RPC round trips per asset; ten baskets of
 * ten assets is two hundred calls and a list page that takes seconds to show
 * anything. This reads every vault and every mint across every basket in
 * batched `getMultipleAccountsInfo` calls instead, then prices the lot in one
 * request.
 *
 * Layouts are read directly rather than through spl-token's parsers because
 * those take one account at a time: SPL token account amount is a u64 at 64,
 * mint decimals a u8 at 44.
 */
export async function fetchBasketNavs(
  connection: Connection,
  baskets: { pubkey: PublicKey; assets: PublicKey[] }[],
  supplies: bigint[],
  basketDecimals: number,
): Promise<(BasketNav | null)[]> {
  if (baskets.length === 0) return [];

  // Flatten to one address list, remembering where each basket's slice starts.
  const vaults: PublicKey[] = [];
  const offsets: number[] = [];
  for (const b of baskets) {
    offsets.push(vaults.length);
    for (const a of b.assets) vaults.push(getAssociatedTokenAddressSync(a, b.pubkey, true));
  }
  const mints = [...new Set(baskets.flatMap((b) => b.assets.map((a) => a.toBase58())))];

  const [vaultInfos, mintInfos] = await Promise.all([
    getMultipleBatched(connection, vaults),
    getMultipleBatched(connection, mints.map((m) => new PublicKey(m))),
  ]);

  const decimalsByMint = new Map<string, number>();
  mints.forEach((m, i) => {
    const info = mintInfos[i];
    if (info && info.data.length >= 82) decimalsByMint.set(m, info.data[44]);
  });

  return Promise.all(
    baskets.map(async (b, i) => {
      const start = offsets[i];
      const decimals = b.assets.map((a) => decimalsByMint.get(a.toBase58()));
      // A basket we can't read every decimal for would be mis-valued by orders
      // of magnitude, so report nothing rather than something wrong.
      if (decimals.some((d) => d === undefined)) return null;

      const balances = b.assets.map((_, j) => {
        const info = vaultInfos[start + j];
        return info && info.data.length >= 72 ? readU64LE(info.data, 64) : 0n;
      });

      return computeNav(
        b.assets,
        balances,
        decimals as number[],
        supplies[i],
        basketDecimals,
        resolveForPricing(b.assets),
      );
    }),
  );
}

/** `getMultipleAccountsInfo` caps at 100 keys per call. */
async function getMultipleBatched(connection: Connection, keys: PublicKey[]) {
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 100))));
  }
  return out;
}
