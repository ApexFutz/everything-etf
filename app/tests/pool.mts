#!/usr/bin/env -S npx tsx
/**
 * Unit tests for basket/SOL pool seeding math.
 *
 * Pure maths, no chain and no network, so like weights.mts this runs anywhere
 * (including the Windows dev machine). The thing worth pinning is that a pool
 * seeded by these amounts opens *at NAV* — equal USD value on each side — and
 * that the degenerate inputs that would otherwise mint a mispriced pool (no
 * NAV, no SOL price, a seed too small for one base unit) are refused.
 */
import assert from "node:assert/strict";
import { seedFromSol, seedFromUsd, venueLinks } from "../src/lib/etf/pool.js";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

// --- seedFromSol opens at NAV ---------------------------------------------
{
  // NAV $2/token, SOL $100, put 5 SOL on the SOL side.
  const s = seedFromSol(5, 2, 100, 9);
  assert.equal(s.solLamports, 5_000_000_000n); // 5 SOL
  assert.equal(s.basketTokenAmount, 250_000_000_000n); // $500 / $2 = 250 tokens
  near(s.priceUsdPerToken, 2); // opens exactly at NAV
  near(s.priceSolPerToken, 0.02); // 2 / 100
  near(s.totalUsd, 1000); // both sides, $500 each
  console.log("OK  seedFromSol opens at NAV with equal-value sides");
}

// --- the two sides really are equal value at NAV --------------------------
{
  const nav = 3.5;
  const solPrice = 150;
  const s = seedFromSol(2, nav, solPrice, 9);
  const tokenUsd = (Number(s.basketTokenAmount) / 1e9) * nav;
  const solUsd = (Number(s.solLamports) / 1e9) * solPrice;
  near(tokenUsd, solUsd, 1e-6);
  console.log("OK  basket-token side and SOL side carry equal USD value");
}

// --- seedFromUsd splits a budget evenly and hits the budget ---------------
{
  const s = seedFromUsd(1000, 2, 100, 9);
  near(s.totalUsd, 1000);
  assert.equal(s.solLamports, 5_000_000_000n); // $500 of SOL at $100
  assert.equal(s.basketTokenAmount, 250_000_000_000n); // $500 of token at $2
  console.log("OK  seedFromUsd splits the budget 50/50 across the sides");
}

// --- flooring: a non-even token amount rounds down, never up --------------
{
  // $100 of SOL / $3 NAV = 33.333… tokens -> floor to 33.333333333
  const s = seedFromSol(1, 3, 100, 9);
  assert.equal(s.basketTokenAmount, 33_333_333_333n);
  console.log("OK  basket-token amount floors (favours not over-seeding)");
}

// --- degenerate inputs are refused ----------------------------------------
{
  assert.throws(() => seedFromSol(5, 0, 100), /priced NAV/);
  assert.throws(() => seedFromSol(5, 2, 0), /SOL price/);
  assert.throws(() => seedFromSol(0, 2, 100), /positive/);
  assert.throws(() => seedFromUsd(0, 2, 100), /positive/);
  // NAV so high that the whole seed buys less than one base unit.
  assert.throws(() => seedFromSol(0.000001, 1_000_000, 1), /one base unit/);
  console.log("OK  no NAV / no SOL price / zero / dust seed all throw");
}

// --- venue links carry the mint -------------------------------------------
{
  const mint = "So11111111111111111111111111111111111111112";
  const links = venueLinks(mint);
  for (const url of Object.values(links)) {
    assert.ok(url.includes(mint), `expected ${url} to include the mint`);
  }
  assert.ok(links.jupiter.startsWith("https://jup.ag/swap/SOL-"));
  console.log("OK  venueLinks embed the basket mint in every URL");
}

console.log("\nAll pool-seeding checks passed.");
