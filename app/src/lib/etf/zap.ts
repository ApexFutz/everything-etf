/**
 * Buying and selling a whole basket with one asset.
 *
 * Minting is in-kind: to get basket tokens you must deposit every underlying
 * in the right proportion. That is fine for an arbitrageur and useless for a
 * person, who holds SOL and wants "$100 of this basket". A zap closes that
 * gap — swap the one asset into each underlying, then mint — and it is what
 * makes the basket buyable at all, with or without a DEX pool for the basket
 * token itself.
 *
 * The proportions are NOT equal. Equal weight is true only at the moment a
 * basket is seeded; the program never rebalances, so weights drift with price
 * from then on. `mint_basket` requires deposits pro-rata to the *current*
 * vault balances (`vault * amount / supply`), so that is what this targets.
 * Splitting the input evenly across assets instead would overshoot whatever
 * has fallen and undershoot whatever has risen, and the mint would either
 * breach `max_amounts_in` or strand most of the money as dust.
 *
 * Everything here is mainnet-only in practice: it routes through Jupiter, and
 * Jupiter does not serve devnet. The maths is exercised by unit tests that
 * don't need a network.
 */
import { PublicKey } from "@solana/web3.js";
import { depositForMint } from "./quote";

export const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** Worst case: max spent for ExactOut, min received for ExactIn. */
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  priceImpactPct: string;
  slippageBps: number;
}

export interface ZapLeg {
  mint: PublicKey;
  /** Base units of this asset the mint requires. */
  deposit: bigint;
  /** Null when no route exists — the caller must surface this, not ignore it. */
  quote: JupiterQuote | null;
  /** Input base units this leg costs at quote, worst case. */
  costIn: bigint;
  worstCostIn: bigint;
}

export interface ZapPlan {
  /** Basket tokens the user receives, base units. */
  amountOut: bigint;
  legs: ZapLeg[];
  /** Summed input needed, at quote and worst case. */
  totalIn: bigint;
  worstTotalIn: bigint;
  /** Legs Jupiter could not route. Non-empty means the zap cannot proceed. */
  unroutable: PublicKey[];
  /** Largest single-leg price impact, as a fraction (0.01 = 1%). */
  worstPriceImpact: number;
}

/**
 * One Jupiter quote. `ExactOut` is the mode that matters here: minting needs
 * an exact deposit per asset, so fixing the output makes the whole plan
 * deterministic and lets every transaction be built and signed up front
 * instead of re-deriving amounts after each swap lands.
 *
 * Returns null rather than throwing when there is no route — illiquid
 * memecoins frequently have no ExactOut path, and one dead leg shouldn't
 * destroy the quote for the others.
 */
export async function jupiterQuote(args: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  swapMode?: "ExactIn" | "ExactOut";
  signal?: AbortSignal;
}): Promise<JupiterQuote | null> {
  const params = new URLSearchParams({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount.toString(),
    slippageBps: String(args.slippageBps),
    swapMode: args.swapMode ?? "ExactOut",
  });
  try {
    const res = await fetch(`${JUPITER_QUOTE_URL}?${params}`, {
      headers: { accept: "application/json" },
      signal: args.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as JupiterQuote & { error?: string };
    return body?.outAmount ? body : null;
  } catch {
    return null;
  }
}

/**
 * Plans a buy: how much of `inputMint` it takes to end up holding
 * `amountOut` basket tokens.
 *
 * Quotes every leg concurrently — ten sequential round trips to Jupiter is a
 * visibly slow form, and the legs are independent.
 */
export async function planZapIn(args: {
  inputMint: string;
  assets: PublicKey[];
  vaultBalances: bigint[];
  supply: bigint;
  amountOut: bigint;
  slippageBps: number;
  signal?: AbortSignal;
}): Promise<ZapPlan> {
  const { inputMint, assets, vaultBalances, supply, amountOut, slippageBps } = args;

  const deposits = vaultBalances.map((v) => depositForMint(v, amountOut, supply));

  const quotes = await Promise.all(
    assets.map((mint, i) =>
      // An asset already denominated in the input needs no swap at all.
      mint.toBase58() === inputMint
        ? Promise.resolve(null)
        : jupiterQuote({
            inputMint,
            outputMint: mint.toBase58(),
            amount: deposits[i],
            slippageBps,
            swapMode: "ExactOut",
            signal: args.signal,
          }),
    ),
  );

  const legs: ZapLeg[] = assets.map((mint, i) => {
    const isInput = mint.toBase58() === inputMint;
    const q = quotes[i];
    // The input asset passes straight through; its "cost" is the deposit.
    const costIn = isInput ? deposits[i] : BigInt(q?.inAmount ?? 0);
    const worst = isInput ? deposits[i] : BigInt(q?.otherAmountThreshold ?? 0);
    return { mint, deposit: deposits[i], quote: q, costIn, worstCostIn: worst };
  });

  const unroutable = legs
    .filter((l) => l.quote === null && l.mint.toBase58() !== inputMint)
    .map((l) => l.mint);

  return {
    amountOut,
    legs,
    totalIn: legs.reduce((s, l) => s + l.costIn, 0n),
    worstTotalIn: legs.reduce((s, l) => s + l.worstCostIn, 0n),
    unroutable,
    worstPriceImpact: legs.reduce(
      (m, l) => Math.max(m, Math.abs(Number(l.quote?.priceImpactPct ?? 0))),
      0,
    ),
  };
}

/**
 * Plans a sell: redeem `amountIn` basket tokens, then swap each underlying
 * into `outputMint`.
 *
 * ExactIn here, because redemption hands you whatever the vaults hold rather
 * than an amount you choose.
 */
export async function planZapOut(args: {
  outputMint: string;
  assets: PublicKey[];
  payouts: bigint[];
  slippageBps: number;
  signal?: AbortSignal;
}): Promise<{ legs: ZapLeg[]; totalOut: bigint; worstTotalOut: bigint; unroutable: PublicKey[] }> {
  const { outputMint, assets, payouts, slippageBps } = args;

  const quotes = await Promise.all(
    assets.map((mint, i) =>
      mint.toBase58() === outputMint
        ? Promise.resolve(null)
        : jupiterQuote({
            inputMint: mint.toBase58(),
            outputMint,
            amount: payouts[i],
            slippageBps,
            swapMode: "ExactIn",
            signal: args.signal,
          }),
    ),
  );

  const legs: ZapLeg[] = assets.map((mint, i) => {
    const isOutput = mint.toBase58() === outputMint;
    const q = quotes[i];
    return {
      mint,
      deposit: payouts[i],
      quote: q,
      costIn: isOutput ? payouts[i] : BigInt(q?.outAmount ?? 0),
      worstCostIn: isOutput ? payouts[i] : BigInt(q?.otherAmountThreshold ?? 0),
    };
  });

  return {
    legs,
    totalOut: legs.reduce((s, l) => s + l.costIn, 0n),
    worstTotalOut: legs.reduce((s, l) => s + l.worstCostIn, 0n),
    unroutable: legs
      .filter((l) => l.quote === null && l.mint.toBase58() !== outputMint)
      .map((l) => l.mint),
  };
}
