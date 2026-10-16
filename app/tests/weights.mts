#!/usr/bin/env -S npx tsx
/**
 * Unit tests for the weight allocator.
 *
 * Pure maths, no chain and no network, so unlike program-consistency.mts this
 * runs anywhere. The cases worth pinning are the ones that would otherwise
 * surface as a reverted transaction: a slider driving some asset to zero, and
 * a budget too small to buy a whole base unit of something.
 */
import assert from "node:assert/strict";
import {
  MIN_WEIGHT,
  allocateBudget,
  equalWeights,
  normalize,
  setWeight,
  validateAllocation,
} from "../src/lib/etf/weights.js";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);
const sums1 = (ws: number[]) => near(ws.reduce((s, w) => s + w, 0), 1);

// --- equalWeights / normalize ---------------------------------------------
sums1(equalWeights(4));
near(equalWeights(4)[0], 0.25);
sums1(equalWeights(7)); // 1/7 doesn't terminate in binary; must still sum to 1
console.log("OK  equal weights sum to exactly 1, including 1/7");

sums1(normalize([2, 1, 1]));
near(normalize([2, 1, 1])[0], 0.5);
near(normalize([0, 0, 0])[0], 1 / 3, 1e-12); // degenerate input falls back to equal
near(normalize([-5, 1])[0], 0); // negatives are clamped, not propagated
console.log("OK  normalize rescales, clamps negatives, survives all-zero");

// --- setWeight -------------------------------------------------------------
{
  const w = setWeight(equalWeights(4), 0, 0.7);
  sums1(w);
  near(w[0], 0.7);
  // the other three absorb the remainder evenly, since they started equal
  near(w[1], 0.1);
  near(w[2], 0.1);
  near(w[3], 0.1);
  console.log("OK  dragging one weight up pulls the rest down proportionally");
}
{
  // Ratios are preserved, not flattened: 3:1 between the others stays 3:1.
  const w = setWeight([0.25, 0.6, 0.2, 0.2], 0, 0.5);
  sums1(w);
  near(w[1] / w[2], 3);
  console.log("OK  the untouched assets keep their ratios to each other");
}
{
  // Nobody can be driven to zero — the program rejects a zero deposit.
  const w = setWeight(equalWeights(5), 0, 0.999);
  sums1(w);
  assert.ok(w.slice(1).every((x) => x >= MIN_WEIGHT), "every other asset keeps the floor");
  assert.ok(w[0] < 1, "the dragged asset cannot take everything");
  console.log("OK  a slider at the extreme still leaves every asset above the floor");
}
{
  const w = setWeight(equalWeights(3), 1, -1); // below the floor
  sums1(w);
  near(w[1], MIN_WEIGHT);
  console.log("OK  a weight below the floor is clamped up, not accepted");
}
assert.deepEqual(setWeight([1], 0, 0.5), [1]); // single asset is always 100%
console.log("OK  a one-asset basket stays at 100%");

// --- allocateBudget --------------------------------------------------------
{
  const { allocations, totalUsd, unpriced } = allocateBudget(1000, [
    { weight: 0.5, priceUsd: 2, decimals: 6 },
    { weight: 0.25, priceUsd: 0.5, decimals: 9 },
    { weight: 0.25, priceUsd: 100, decimals: 6 },
  ]);
  assert.equal(unpriced.length, 0);
  near(totalUsd, 1000);
  near(allocations[0]!.usd, 500);
  assert.equal(allocations[0]!.amount, 250_000_000n); // $500 / $2 = 250 tokens, 6dp
  assert.equal(allocations[1]!.amount, 500_000_000_000n); // $250 / $0.50 = 500, 9dp
  assert.equal(allocations[2]!.amount, 2_500_000n); // $250 / $100 = 2.5, 6dp
  console.log("OK  a budget splits by weight and converts at each price and decimals");
}
{
  // An unpriced asset is reported, never guessed at.
  const { allocations, unpriced } = allocateBudget(100, [
    { weight: 0.5, priceUsd: 1, decimals: 6 },
    { weight: 0.5, priceUsd: null, decimals: 6 },
  ]);
  assert.equal(allocations[1], null);
  assert.deepEqual(unpriced, [1]);
  assert.match(validateAllocation(allocations, unpriced)!, /No price available for 1 token/);
  console.log("OK  an unpriced asset blocks the allocation instead of being guessed");
}
{
  // $1 split across an asset priced at $50,000 with 2 decimals rounds to zero,
  // which seed_basket would reject — caught here instead.
  const { allocations, unpriced } = allocateBudget(1, [
    { weight: 0.5, priceUsd: 1, decimals: 6 },
    { weight: 0.5, priceUsd: 50_000, decimals: 2 },
  ]);
  assert.equal(allocations[1]!.amount, 0n);
  assert.match(validateAllocation(allocations, unpriced)!, /rounded to zero/);
  console.log("OK  a deposit that rounds to zero is caught before it reverts on chain");
}
{
  const { allocations, unpriced } = allocateBudget(1000, [
    { weight: 0.5, priceUsd: 2, decimals: 6 },
    { weight: 0.5, priceUsd: 2, decimals: 6 },
  ]);
  assert.equal(validateAllocation(allocations, unpriced), null);
  console.log("OK  a well-formed allocation validates clean");
}

console.log("\nAll weight-allocator checks passed.");
