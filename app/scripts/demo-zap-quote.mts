#!/usr/bin/env -S npx tsx
/**
 * Prices a hypothetical basket against live mainnet data and plans a real buy.
 *
 * Read-only: it quotes Jupiter and reads prices, and signs or sends nothing.
 * The point is to show the zap maths working end to end on real liquidity
 * before any of it is wired to a wallet — and to make the thing people get
 * wrong visible, which is that deposits are pro-rata to current vault
 * balances rather than split evenly.
 *
 * Jupiter is mainnet-only, so this cannot run against devnet. That is a
 * property of the feature, not of the script.
 *
 * Usage (from app/):
 *   npx tsx scripts/demo-zap-quote.mts [--usd 100] [--slippage-bps 100] [--drift]
 */
import { PublicKey } from "@solana/web3.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || !process.argv[i + 1] ? fallback : process.argv[i + 1];
}

const usd = (v: number) => `$${v < 10 ? v.toFixed(4) : v.toFixed(2)}`;
const rule = (t?: string) => console.log(t ? `\n${t}\n${"-".repeat(78)}` : "-".repeat(78));

// Real mainnet mints, the kind a basket here would actually hold.
const BASKET = [
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5 },
  { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", decimals: 6 },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6 },
  { symbol: "POPCAT", mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", decimals: 9 },
];
const SOL = "So11111111111111111111111111111111111111112";
const BASKET_DECIMALS = 9;

async function main() {
  const targetUsd = Number(arg("usd", "100"));
  const slippageBps = Number(arg("slippage-bps", "100"));
  const drift = process.argv.includes("--drift");

  const { computeNav, tokensForUsd, toWhole } = await import("../src/lib/etf/nav.js");
  const { planZapIn } = await import("../src/lib/etf/zap.js");
  const { fetchUsdPrices } = await import("../src/lib/etf/pricing.js");

  const mints = BASKET.map((b) => new PublicKey(b.mint));
  const decimals = BASKET.map((b) => b.decimals);
  const prices = await fetchUsdPrices(BASKET.map((b) => b.mint));

  // Build vaults holding an equal $25,000 of each at today's prices — i.e. a
  // basket seeded right now. `--drift` doubles the first asset instead, which
  // is what a basket looks like after one of its coins runs.
  const PER_ASSET_USD = 25_000;
  const balances = BASKET.map((b, i) => {
    const p = prices[b.mint];
    if (!p) throw new Error(`no price for ${b.symbol} — cannot build the example`);
    const target = PER_ASSET_USD * (drift && i === 0 ? 2 : 1);
    return BigInt(Math.floor((target / p) * 10 ** b.decimals));
  });
  const supply = 1_000_000n * 10n ** BigInt(BASKET_DECIMALS);

  const nav = await computeNav(mints, balances, decimals, supply, BASKET_DECIMALS);

  rule(`BASKET NAV${drift ? "  (after BONK doubled — weights have drifted)" : "  (freshly seeded, equal weight)"}`);
  console.log(`  ${"asset".padEnd(9)}${"price".padStart(14)}${"vault value".padStart(15)}${"weight".padStart(10)}`);
  rule();
  nav.assets.forEach((a, i) => {
    console.log(
      `  ${BASKET[i].symbol.padEnd(9)}${usd(a.priceUsd ?? 0).padStart(14)}${usd(a.valueUsd ?? 0).padStart(15)}${((a.weight ?? 0) * 100).toFixed(1).padStart(9)}%`,
    );
  });
  rule();
  console.log(`  total value        ${usd(nav.totalUsd)}`);
  console.log(`  supply             ${toWhole(supply, BASKET_DECIMALS).toLocaleString("en-US")} tokens`);
  console.log(`  NAV per token      ${usd(nav.navPerToken)}`);
  if (nav.unpriced.length) console.log(`  UNPRICED: ${nav.unpriced.length} asset(s) — total understates`);

  const amountOut = tokensForUsd(targetUsd, nav, BASKET_DECIMALS);
  rule(`BUYING ${usd(targetUsd)} OF IT WITH SOL`);
  console.log(`  that is ${toWhole(amountOut, BASKET_DECIMALS).toFixed(4)} basket tokens at NAV\n`);

  const plan = await planZapIn({
    inputMint: SOL,
    assets: mints,
    vaultBalances: balances,
    supply,
    amountOut,
    slippageBps,
  });

  console.log(
    `  ${"asset".padEnd(9)}${"deposit needed".padStart(18)}${"= USD".padStart(10)}${"SOL cost".padStart(13)}${"impact".padStart(9)}`,
  );
  rule();
  plan.legs.forEach((l, i) => {
    const whole = toWhole(l.deposit, decimals[i]);
    const dollars = whole * (nav.assets[i].priceUsd ?? 0);
    const sol = toWhole(l.costIn, 9);
    const impact = Number(l.quote?.priceImpactPct ?? 0) * 100;
    console.log(
      `  ${BASKET[i].symbol.padEnd(9)}${whole.toLocaleString("en-US", { maximumFractionDigits: 4 }).padStart(18)}${usd(dollars).padStart(10)}${sol.toFixed(6).padStart(13)}${(l.quote ? impact.toFixed(3) + "%" : "no route").padStart(9)}`,
    );
  });
  rule();
  console.log(`  total           ${toWhole(plan.totalIn, 9).toFixed(6)} SOL`);
  console.log(`  worst case      ${toWhole(plan.worstTotalIn, 9).toFixed(6)} SOL  (at ${slippageBps / 100}% slippage)`);
  console.log(`  max extra       ${toWhole(plan.worstTotalIn - plan.totalIn, 9).toFixed(6)} SOL`);
  if (plan.unroutable.length) {
    console.log(`\n  CANNOT PROCEED — no route for ${plan.unroutable.length} asset(s):`);
    plan.unroutable.forEach((m) => console.log(`    ${m.toBase58()}`));
  }

  console.log(
    `\n  Note the USD column: ${drift ? "it is NOT an even split" : "even here, because nothing has drifted yet"}.`,
  );
  console.log("  Deposits track current vault weights, which is what mint_basket");
  console.log("  requires. Run again with --drift to see them diverge.");
  rule();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
