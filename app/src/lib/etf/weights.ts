/**
 * Choosing what a basket is made of.
 *
 * The program has no opinion about weights. `seed_basket` takes a raw amount
 * per asset and only insists there are the right number of them and that none
 * is zero — whatever ratio the first deposit lands in *is* the basket, and
 * every later mint is pro-rata to that. "Equal weight" was a convention of
 * this UI, never a rule.
 *
 * Which is just as well, because equal weight is not a property a basket can
 * keep. It is true for exactly as long as it takes the first price to move:
 * nothing rebalances, so a basket seeded at 25/25/25/25 is at 40/20/20/20 the
 * moment one asset doubles. Promising equality would be promising something
 * that stops being true immediately. Letting the creator choose, and showing
 * buyers the live weights, describes what is actually there.
 *
 * So the creator picks a budget and a split. This turns that into the per-asset
 * deposits `seed_basket` wants.
 */

/** Smallest share an asset may be given. Zero is rejected by the program. */
export const MIN_WEIGHT = 0.001; // 0.1%

export interface WeightedAsset {
  /** Share of the budget, 0–1. */
  weight: number;
  /** USD per whole token. */
  priceUsd: number | null;
  decimals: number;
}

/** An even split across `n` assets, as exact fractions that sum to 1. */
export function equalWeights(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

/**
 * Rescales weights to sum to exactly 1, preserving their ratios.
 *
 * Sliders drift — moving one and renormalising the rest accumulates rounding —
 * so the UI works in raw proportions and normalises on read rather than
 * fighting to keep them summing to 1 on every input event.
 */
export function normalize(weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0) return equalWeights(weights.length);
  return weights.map((w) => Math.max(0, w) / total);
}

/**
 * Moves one weight to `target`, absorbing the difference across the others in
 * proportion to their current size — the behaviour a slider needs, where
 * dragging one asset up pulls the rest down evenly rather than pinning them.
 *
 * Every other asset keeps at least `MIN_WEIGHT`, since the program rejects a
 * zero deposit and a slider that can silently invalidate the transaction is
 * worse than one that stops short.
 */
export function setWeight(weights: number[], index: number, target: number): number[] {
  const n = weights.length;
  if (n <= 1) return [1];

  const floor = MIN_WEIGHT * (n - 1);
  const clamped = Math.min(Math.max(target, MIN_WEIGHT), 1 - floor);
  const remaining = 1 - clamped;

  const others = weights.filter((_, i) => i !== index);
  const othersTotal = others.reduce((s, w) => s + w, 0);

  return weights.map((w, i) => {
    if (i === index) return clamped;
    // Spread evenly if the others are all zero; otherwise keep their ratios.
    const share = othersTotal > 0 ? w / othersTotal : 1 / (n - 1);
    return Math.max(MIN_WEIGHT, remaining * share);
  });
}

export interface Allocation {
  /** Dollars going into this asset. */
  usd: number;
  /** Base units to deposit — what `seed_basket` is handed. */
  amount: bigint;
  /** Weight actually achieved after integer truncation. */
  effectiveWeight: number;
}

/**
 * Splits a budget across assets at the given weights and live prices.
 *
 * Returns null entries for assets with no price: a basket can't be sized
 * against something nothing quotes, and guessing would mis-weight the whole
 * basket rather than just that leg.
 */
export function allocateBudget(
  budgetUsd: number,
  assets: WeightedAsset[],
): { allocations: (Allocation | null)[]; unpriced: number[]; totalUsd: number } {
  const weights = normalize(assets.map((a) => a.weight));

  const allocations = assets.map((a, i) => {
    if (a.priceUsd === null || !(a.priceUsd > 0)) return null;
    const usd = budgetUsd * weights[i];
    const whole = usd / a.priceUsd;
    const amount = BigInt(Math.floor(whole * 10 ** a.decimals));
    return { usd, amount, effectiveWeight: weights[i] };
  });

  const priced = allocations.filter((x): x is Allocation => x !== null);
  const totalUsd = priced.reduce((s, a) => s + a.usd, 0);

  return {
    allocations,
    unpriced: assets.map((_, i) => i).filter((i) => allocations[i] === null),
    totalUsd,
  };
}

/**
 * Why a chosen split can't be seeded, or null when it can.
 *
 * Checked here rather than left to the transaction, so the failure arrives
 * while the numbers are still on screen and editable.
 */
export function validateAllocation(
  allocations: (Allocation | null)[],
  unpriced: number[],
): string | null {
  if (unpriced.length > 0) {
    return `No price available for ${unpriced.length} token${unpriced.length === 1 ? "" : "s"} — can't size the basket against ${unpriced.length === 1 ? "it" : "them"}.`;
  }
  const zero = allocations.filter((a) => a !== null && a.amount === 0n).length;
  if (zero > 0) {
    return `${zero} token${zero === 1 ? " gets" : "s get"} rounded to zero at this budget. Raise the budget or its share — every token needs a non-zero deposit.`;
  }
  return null;
}
