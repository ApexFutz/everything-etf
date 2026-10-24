#!/usr/bin/env -S npx tsx
/**
 * Illustrative simulation of a *proposed* managed "PunchCard Index" basket on
 * top of the Tote primitive. Nothing here is wired to the program —
 * it's a napkin model to reason about tokenomics before building.
 *
 * What it faithfully reproduces from the real program:
 *   - in-kind mint: deposit_i = ceil(vault_i * amount / supply)   (rounds UP)
 *   - in-kind redeem: payout_i = floor(vault_i * amount / supply)  (rounds DOWN)
 *   - supply moves 1:1 with the minted/redeemed amount; fees are zero
 *
 * What it adds (not in the program): a constant-product (x*y=k) pool per
 * underlying, so "buy/sell the basket with SOL" moves the attached tokens'
 * prices the way a Jupiter zap actually would. NAV is marked at pool mid-price,
 * exactly like nav.ts does off-chain.
 *
 * Run:  npx tsx scripts/simulate-punchcard-index.mts   (from app/)
 */

const SOL_USD = 150;
const SWAP_FEE = 0.0025; // 0.25%, typical Raydium CPMM tier

// ---- tiny constant-product AMM -------------------------------------------
interface Pool {
  sym: string;
  S: number; // SOL reserve
  T: number; // token reserve
}
const priceSol = (p: Pool) => p.S / p.T; // SOL per whole token
const priceUsd = (p: Pool) => priceSol(p) * SOL_USD;

/** Buy an exact `tokensOut` from the pool; returns SOL paid (fee on input). */
function buyExactOut(p: Pool, tokensOut: number): number {
  const solIn = (p.S * tokensOut) / (p.T - tokensOut) / (1 - SWAP_FEE);
  p.S += solIn;
  p.T -= tokensOut;
  return solIn;
}
/** Spend an exact `solIn`; returns tokens received (fee on input). */
function buyWithSol(p: Pool, solIn: number): number {
  const eff = solIn * (1 - SWAP_FEE);
  const tokensOut = (p.T * eff) / (p.S + eff);
  p.S += solIn;
  p.T -= tokensOut;
  return tokensOut;
}
/** Sell an exact `tokensIn` into the pool; returns SOL received (fee on input). */
function sellExactIn(p: Pool, tokensIn: number): number {
  const eff = tokensIn * (1 - SWAP_FEE);
  const solOut = (p.S * eff) / (p.T + eff);
  p.S -= solOut;
  p.T += tokensIn;
  return solOut;
}

// ---- formatting -----------------------------------------------------------
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 0.01 ? 6 : 2 })}`;
const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const rule = () => console.log("-".repeat(72));

// ---- 1. the index at genesis ---------------------------------------------
// Four PunchCard business tokens, each with its own thin pump.fun/Raydium pool.
const pools: Record<string, Pool> = {
  BREW: { sym: "BREW", S: 30, T: 3_000_000 }, // coffee shop  $0.0015, TVL ~$9k
  SLICE: { sym: "SLICE", S: 20, T: 4_000_000 }, // pizzeria    $0.00075, TVL ~$6k
  CUTZ: { sym: "CUTZ", S: 12, T: 6_000_000 }, // barber       $0.0003,  TVL ~$3.6k
  WASH: { sym: "WASH", S: 10, T: 2_000_000 }, // laundromat   $0.00075, TVL ~$3k
};
const syms = Object.keys(pools);

// Manager seeds from inventory (pools untouched): equal ~$750 per leg.
const vault: Record<string, number> = {
  BREW: 500_000, // $750
  SLICE: 1_000_000, // $750
  CUTZ: 2_500_000, // $750
  WASH: 1_000_000, // $750
};
let supply = 1_000_000; // PCLI tokens

const navUsd = () => syms.reduce((s, k) => s + vault[k] * priceUsd(pools[k]), 0);
const navPerToken = () => navUsd() / supply;

console.log("\n=== 1. PunchCard Local Index (PCLI) at genesis ===\n");
console.log("sym     price      pool TVL     vault qty        vault $    weight");
rule();
for (const k of syms) {
  const w = (vault[k] * priceUsd(pools[k])) / navUsd();
  console.log(
    `${k.padEnd(6)} ${usd(priceUsd(pools[k])).padStart(9)}  ${usd(2 * pools[k].S * SOL_USD).padStart(9)}  ${num(vault[k]).padStart(12)}  ${usd(vault[k] * priceUsd(pools[k])).padStart(9)}  ${pct(w).padStart(6)}`,
  );
}
rule();
console.log(`NAV ${usd(navUsd())}   supply ${num(supply)} PCLI   NAV/token ${usd(navPerToken())}\n`);

// ---- 2. BUY $300 of PCLI with SOL (zap: swap into each leg, then mint) ----
console.log("=== 2. Buy $300 of PCLI with SOL (zap-in) ===\n");
const budgetUsd = 300;
const mintAmount = Math.round(budgetUsd / navPerToken()); // PCLI to mint
const frac = mintAmount / supply;

console.log(`Target: mint ${num(mintAmount)} PCLI  (= ${pct(frac)} of supply)\n`);
console.log("Each leg must be BOUGHT on its pool to deposit it in-kind:\n");
console.log("sym       deposit   mid cost   actual SOL    $ paid   price impact");
rule();
let totalSolPaid = 0;
const navBeforeMid = navPerToken();
for (const k of syms) {
  // in-kind deposit the program would require (rounds UP, favouring the vault)
  const deposit = Math.ceil((vault[k] * mintAmount) / supply);
  const before = priceUsd(pools[k]);
  const solIn = buyExactOut(pools[k], deposit); // moves the pool
  const after = priceUsd(pools[k]);
  totalSolPaid += solIn;
  vault[k] += deposit; // deposited into the basket vault
  console.log(
    `${k.padEnd(6)} ${num(deposit).padStart(11)}  ${usd(deposit * before).padStart(8)}  ${solIn.toFixed(4).padStart(9)} SOL  ${usd(solIn * SOL_USD).padStart(8)}   ${pct(after / before - 1).padStart(7)}`,
  );
}
supply += mintAmount; // minting the basket token
rule();
console.log(`\nPaid ${totalSolPaid.toFixed(4)} SOL (${usd(totalSolPaid * SOL_USD)}) for ${num(mintAmount)} PCLI`);
console.log(`Effective price ${usd((totalSolPaid * SOL_USD) / (mintAmount / 1))} per PCLI vs NAV/token ${usd(navBeforeMid)} before the buy`);
console.log(`Slippage+fees the buyer ate: ${pct((totalSolPaid * SOL_USD) / (budgetUsd) - 1)} over the $300 mid cost`);
console.log(`NAV/token now marks at ${usd(navPerToken())} (buyer's own impact marked UP every holder's bag)\n`);

// ---- 3. SELL the PCLI back (redeem in-kind, then swap each leg to SOL) ----
console.log("=== 3. Immediately sell those PCLI back (zap-out) ===\n");
const sellAmount = mintAmount;
const sellFrac = sellAmount / supply;
console.log(`Redeem ${num(sellAmount)} PCLI  (= ${pct(sellFrac)} of supply)\n`);
console.log("sym        payout    sell into pool     $ got   price impact");
rule();
let totalSolBack = 0;
for (const k of syms) {
  const payout = Math.floor((vault[k] * sellAmount) / supply); // rounds DOWN
  const before = priceUsd(pools[k]);
  const solOut = sellExactIn(pools[k], payout);
  const after = priceUsd(pools[k]);
  totalSolBack += solOut;
  vault[k] -= payout;
  console.log(
    `${k.padEnd(6)} ${num(payout).padStart(12)}  ${solOut.toFixed(4).padStart(9)} SOL      ${usd(solOut * SOL_USD).padStart(8)}   ${pct(after / before - 1).padStart(7)}`,
  );
}
supply -= sellAmount;
rule();
console.log(`\nPaid ${totalSolPaid.toFixed(4)} SOL in, got ${totalSolBack.toFixed(4)} SOL back`);
console.log(`Round-trip loss: ${usd((totalSolPaid - totalSolBack) * SOL_USD)} = ${pct(totalSolBack / totalSolPaid - 1)} (two fee legs + trading against your own impact in thin pools)\n`);

// ---- 4. Fee-funded reconstitution: a new PunchCard token joins -----------
console.log("=== 4. A new PunchCard token launches -> fee-funded add (no new supply) ===\n");
const harvestedSol = 1.5; // LP fees PCLI's own pool earned from trading volume
const taco: Pool = { sym: "TACO", S: 10, T: 2_000_000 }; // fresh, thin pool $0.00075
const navBeforeAdd = navPerToken();
const tacoBefore = priceUsd(taco);
const got = buyWithSol(taco, harvestedSol); // crank spends fees to buy TACO
const tacoAfter = priceUsd(taco);
pools.TACO = taco;
syms.push("TACO");
vault.TACO = got; // added to a new vault; supply UNCHANGED

const costBasisNav = navBeforeAdd * supply + harvestedSol * SOL_USD; // what we actually spent
const midMarkNav = navUsd(); // what mid-price marking claims it's worth
console.log(`Harvested ${harvestedSol} SOL (${usd(harvestedSol * SOL_USD)}) of pool fees -> bought ${num(got)} TACO`);
console.log(`TACO pool price ${usd(tacoBefore)} -> ${usd(tacoAfter)}  (${pct(tacoAfter / tacoBefore - 1)} from the crank's own buy)\n`);
console.log(`Supply unchanged: ${num(supply)} PCLI`);
console.log(`NAV/token  cost-basis: ${usd(costBasisNav / supply)}   (from ${usd(navBeforeAdd)} — fees compounded INTO holders)`);
console.log(`NAV/token  mid-mark:   ${usd(midMarkNav / supply)}   <- overstates: ${usd((midMarkNav - costBasisNav))} is unrealizable paper from buying a thin pool`);
console.log("\nNew composition (mid-mark):");
rule();
for (const k of syms) {
  const w = (vault[k] * priceUsd(pools[k])) / navUsd();
  console.log(`${k.padEnd(6)} ${num(vault[k]).padStart(12)}  ${usd(vault[k] * priceUsd(pools[k])).padStart(9)}  ${pct(w).padStart(6)}`);
}
rule();
console.log();
