"use client";

import { Allocation, MIN_WEIGHT, setWeight } from "@/lib/etf/weights";
import { Banner, Field, TextInput } from "@/components/ui";
import { formatTokens, shortAddress } from "@/lib/format";

export interface AllocatorAsset {
  key: string;
  symbol: string;
  decimals: number;
  priceUsd: number | null;
}

/**
 * Splits a budget across the basket's tokens.
 *
 * The weights are the creator's to choose. Equal weight is offered as a
 * starting point rather than a rule, because it isn't one the basket can keep:
 * nothing rebalances, so the first price move ends it. Showing the split
 * explicitly — here and again to buyers — describes what is actually in the
 * vault instead of implying a symmetry that lasts minutes.
 */
export function WeightAllocator({
  assets,
  weights,
  budgetUsd,
  allocations,
  onWeightsChange,
  onBudgetChange,
}: {
  assets: AllocatorAsset[];
  weights: number[];
  budgetUsd: string;
  allocations: (Allocation | null)[];
  onWeightsChange: (next: number[]) => void;
  onBudgetChange: (next: string) => void;
}) {
  const n = assets.length;
  const equal = 1 / n;
  const isEqual = weights.every((w) => Math.abs(w - equal) < 0.0005);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Budget (USD)" hint="split across the tokens below">
          <TextInput
            value={budgetUsd}
            onChange={(e) => onBudgetChange(e.target.value)}
            inputMode="decimal"
            placeholder="500"
          />
        </Field>
        <button
          type="button"
          onClick={() => onWeightsChange(Array.from({ length: n }, () => equal))}
          disabled={isEqual}
          className="rounded-lg border border-border px-3 py-2 text-xs transition-colors hover:border-accent disabled:opacity-40"
        >
          {isEqual ? "Equal weight ✓" : "Reset to equal weight"}
        </button>
      </div>

      <ul className="space-y-3">
        {assets.map((a, i) => {
          const alloc = allocations[i];
          const pct = weights[i] * 100;
          return (
            <li key={a.key} className="rounded-lg border border-border bg-surface-2 px-3 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{a.symbol}</span>
                  <code className="text-xs text-muted">{shortAddress(a.key, 4)}</code>
                </span>
                <span className="text-sm tabular-nums">
                  <strong>{pct.toFixed(1)}%</strong>
                  {alloc && (
                    <span className="text-muted">
                      {" · "}${alloc.usd.toFixed(2)}
                    </span>
                  )}
                </span>
              </div>

              <input
                type="range"
                min={MIN_WEIGHT * 100}
                max={100 - MIN_WEIGHT * 100 * (n - 1)}
                step={0.5}
                value={pct}
                aria-label={`${a.symbol} share of the basket`}
                onChange={(e) => onWeightsChange(setWeight(weights, i, Number(e.target.value) / 100))}
                className="mt-2 w-full accent-[var(--accent)]"
                disabled={n <= 1}
              />

              <div className="mt-1 text-xs text-muted">
                {a.priceUsd === null ? (
                  <span className="text-amber-700 dark:text-amber-400">
                    No price — can&apos;t size this one automatically.
                  </span>
                ) : alloc ? (
                  <>
                    deposits{" "}
                    <span className="tabular-nums text-foreground">
                      {formatTokens(alloc.amount, a.decimals)}
                    </span>{" "}
                    {a.symbol} at ${a.priceUsd < 0.01 ? a.priceUsd.toPrecision(3) : a.priceUsd.toFixed(4)}
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <Banner kind="info">
        These weights are the basket&apos;s starting composition, not a promise. Nothing rebalances,
        so they drift with price from the first trade onward — a basket seeded 25/25/25/25 reads
        40/20/20/20 once one token doubles. Buyers always see the live weights, not these.
      </Banner>
    </div>
  );
}
