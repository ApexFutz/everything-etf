/**
 * Seeding a basket/SOL liquidity pool.
 *
 * A basket token is already an SPL mint — what it lacks is a public market.
 * Minting is in-kind at NAV, so the only people who can "buy" a basket today
 * are arbitrageurs who already hold every underlying in the right ratio. A
 * basket/SOL pool fixes that: once it exists, the token is quotable through
 * Jupiter and surfaces in the aggregator-fed UIs (pump.fun, fomo, DexScreener),
 * and the existing in-kind mint/redeem path keeps the pool honest — mint when
 * the pool trades above NAV, redeem when below, until the two meet. See
 * `nav.ts` for why NAV is the value of the backing, not the market price.
 *
 * This module is the client-side brain for that step: it works out how much of
 * each side to deposit so the pool *opens at NAV*, and it builds the venue
 * links. The actual Raydium create-pool instruction is wired at mainnet-launch
 * time — devnet has no Raydium liquidity and the aggregators don't index
 * devnet, so there is nothing to seed or verify there. Execution is therefore
 * deliberately deferred; see {@link buildSeedPoolPlan}.
 *
 * Why Raydium CPMM (constant-product), not a concentrated pool, for the first
 * cut: a full-range pool never drifts out of range and is the simplest thing to
 * seed and leave alone. A concentrated pool around NAV (Raydium CLMM) is more
 * capital-efficient — because arbitrage holds the token near NAV, it behaves
 * like a soft-pegged asset, exactly the case concentrated liquidity is best at —
 * and is the planned optimisation, not v1.
 */
import type { PublicKey } from "@solana/web3.js";
import { BASKET_DECIMALS } from "./constants";
import { WRAPPED_SOL_MINT } from "./pricing";

/** Lamports in one SOL (SOL has 9 decimals, same as a basket token). */
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Raydium Constant-Product AMM (CPMM) program, mainnet-beta. The devnet
 * deployment is a different address; it is only needed once pool seeding is
 * wired, which happens at mainnet-launch time (see {@link buildSeedPoolPlan}).
 */
export const RAYDIUM_CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

/**
 * The two deposits that open a basket/SOL pool at NAV, plus the prices they
 * imply for display. A constant-product pool opens at the ratio of its two
 * deposits, and at that price the two sides hold equal value — so seeding "at
 * NAV" is just depositing equal USD value of basket token and SOL.
 */
export interface PoolSeed {
  /** Basket-token side, base units. */
  basketTokenAmount: bigint;
  /** SOL side, lamports. */
  solLamports: bigint;
  /** Opening price, SOL per whole basket token. */
  priceSolPerToken: number;
  /** Opening price, USD per whole basket token — equals NAV by construction. */
  priceUsdPerToken: number;
  /** Total USD seeded across both sides. */
  totalUsd: number;
}

/**
 * Size a pool from a chosen amount of SOL on the SOL side, matching it with the
 * basket tokens of equal value at NAV so the pool opens exactly at NAV.
 *
 * `navPerTokenUsd` is `BasketNav.navPerToken` (`nav.ts`); `solPriceUsd` is the
 * live SOL price (`fetchUsdPrice(WRAPPED_SOL_MINT)` from `pricing.ts`). Both
 * come from Jupiter's mainnet index, which is the whole reason this runs on
 * mainnet — a basket with any unpriced asset has an understated NAV and must
 * not be seeded against it (the caller checks `BasketNav.unpriced` first).
 */
export function seedFromSol(
  solAmount: number,
  navPerTokenUsd: number,
  solPriceUsd: number,
  basketDecimals: number = BASKET_DECIMALS,
): PoolSeed {
  if (!(navPerTokenUsd > 0)) {
    throw new Error("basket has no priced NAV to seed a pool against");
  }
  if (!(solPriceUsd > 0)) {
    throw new Error("need a live SOL price to size the pool");
  }
  if (!(solAmount > 0)) {
    throw new Error("seed SOL must be positive");
  }

  const solUsd = solAmount * solPriceUsd;
  const wholeTokens = solUsd / navPerTokenUsd;
  const basketTokenAmount = BigInt(Math.floor(wholeTokens * 10 ** basketDecimals));
  if (basketTokenAmount < 1n) {
    throw new Error("seed too small for even one base unit of the basket token");
  }

  return {
    basketTokenAmount,
    solLamports: BigInt(Math.round(solAmount * LAMPORTS_PER_SOL)),
    priceSolPerToken: navPerTokenUsd / solPriceUsd,
    priceUsdPerToken: navPerTokenUsd,
    totalUsd: solUsd * 2,
  };
}

/**
 * Size a pool from a total USD budget, split evenly across the two sides. A
 * convenience wrapper over {@link seedFromSol} for callers who think in "I want
 * ~$X of launch liquidity" rather than in SOL.
 */
export function seedFromUsd(
  totalUsd: number,
  navPerTokenUsd: number,
  solPriceUsd: number,
  basketDecimals: number = BASKET_DECIMALS,
): PoolSeed {
  if (!(totalUsd > 0)) {
    throw new Error("seed budget must be positive");
  }
  if (!(solPriceUsd > 0)) {
    throw new Error("need a live SOL price to size the pool");
  }
  // Half the budget funds the SOL side; seedFromSol matches the other half in
  // basket tokens, so the two sides end up equal-value at NAV.
  return seedFromSol(totalUsd / 2 / solPriceUsd, navPerTokenUsd, solPriceUsd, basketDecimals);
}

/** Aggregator / explorer links where a seeded basket token can be traded or inspected. */
export interface VenueLinks {
  /** Jupiter swap UI, prefilled SOL -> basket token. */
  jupiter: string;
  /** DexScreener token page (pairs appear once a pool is indexed). */
  dexscreener: string;
  /** Birdeye token page. */
  birdeye: string;
  /**
   * pump.fun's token board. pump.fun surfaces any aggregator-indexed token, so
   * this is how a basket shows up there — it is *not* a pump.fun bonding-curve
   * mint (that would price the token by a curve instead of its NAV).
   */
  pumpfun: string;
}

/**
 * Links are mainnet URLs: these venues only index mainnet, which is the same
 * reason seeding itself is mainnet-only. On devnet the UI should explain that
 * rather than render dead links.
 */
export function venueLinks(basketMint: string): VenueLinks {
  return {
    jupiter: `https://jup.ag/swap/SOL-${basketMint}`,
    dexscreener: `https://dexscreener.com/solana/${basketMint}`,
    birdeye: `https://birdeye.so/token/${basketMint}?chain=solana`,
    pumpfun: `https://pump.fun/coin/${basketMint}`,
  };
}

/** Inputs to build the on-chain pool-seed transaction(s). */
export interface SeedPoolParams {
  /** The basket token mint to pair against SOL. */
  basketMint: PublicKey;
  basketDecimals?: number;
  /** Deposit amounts, from {@link seedFromSol} / {@link seedFromUsd}. */
  seed: PoolSeed;
  /** Who pays for and owns the initial LP position. */
  payer: PublicKey;
  /** Wrapped-SOL mint to pair against; defaults to the canonical mainnet mint. */
  quoteMint?: string;
}

/**
 * Build the Raydium CPMM "create pool + deposit" transaction(s).
 *
 * Intentionally not implemented yet. Seeding runs on mainnet-beta (devnet has
 * no Raydium liquidity and the aggregator UIs don't index devnet), so there is
 * nothing to exercise here until launch. When it is wired, do it through
 * `@raydium-io/raydium-sdk-v2` rather than hand-building the account list — the
 * CPMM program's config/observation/authority accounts are version-specific and
 * are exactly the kind of thing the consistency philosophy of this repo says to
 * verify against a source of truth, not transcribe from memory. The two deposit
 * amounts come straight from {@link seedFromSol}/{@link seedFromUsd}.
 */
export function buildSeedPoolPlan(params: SeedPoolParams): never {
  const { basketMint, seed } = params;
  throw new Error(
    `Pool seeding for ${basketMint.toBase58()} executes on mainnet-beta; wire ` +
      "Raydium CPMM create-pool + deposit here via @raydium-io/raydium-sdk-v2 at " +
      `launch time. The deposit amounts (${seed.basketTokenAmount} token base units ` +
      `+ ${seed.solLamports} lamports) come from seedFromSol/seedFromUsd in this module.`,
  );
}

export { WRAPPED_SOL_MINT };
