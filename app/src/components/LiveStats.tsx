"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { fetchCoinConfig, fetchConfig } from "@/lib/etf/client";
import { CoinConfig, Config } from "@/lib/etf/accounts";
import { COIN_DECIMALS, COIN_TOTAL_SUPPLY } from "@/lib/etf/constants";
import { formatBaseUnits } from "@/lib/format";

/** Compact whole-token display — landing-page stats don't want 9 decimals. */
function whole(amount: bigint, decimals: number): string {
  const n = Number(formatBaseUnits(amount, decimals));
  if (!Number.isFinite(n)) return formatBaseUnits(amount, decimals);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function LiveStats() {
  const { connection } = useConnection();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "uninitialized" }
    | { kind: "error"; message: string }
    | { kind: "ready"; config: Config; coin: CoinConfig }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [config, coin] = await Promise.all([fetchConfig(connection), fetchCoinConfig(connection)]);
        if (cancelled) return;
        setState(config && coin ? { kind: "ready", config, coin } : { kind: "uninitialized" });
      } catch (e) {
        if (!cancelled) {
          setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const items: { label: string; value: string; tone?: "burn" | "accent" }[] =
    state.kind === "ready"
      ? [
          { label: "Baskets launched", value: state.config.basketCount.toString(), tone: "accent" },
          {
            label: "$EETF burned",
            value: whole(state.coin.totalBurned, COIN_DECIMALS),
            tone: "burn",
          },
          {
            label: "$EETF circulating",
            value: whole(COIN_TOTAL_SUPPLY - state.coin.totalBurned, COIN_DECIMALS),
          },
          {
            label: "Supply retired",
            value: `${((Number(state.coin.totalBurned) / Number(COIN_TOTAL_SUPPLY)) * 100).toFixed(3)}%`,
            tone: "burn",
          },
        ]
      : [];

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
      {state.kind === "ready"
        ? items.map((it) => (
            <div key={it.label} className="bg-surface px-4 py-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted">{it.label}</div>
              <div
                className={`mt-1 text-2xl font-semibold tabular-nums ${
                  it.tone === "burn" ? "text-burn" : it.tone === "accent" ? "text-accent" : ""
                }`}
              >
                {it.value}
              </div>
            </div>
          ))
        : ["Baskets launched", "$EETF burned", "$EETF circulating", "Supply retired"].map((label) => (
            <div key={label} className="bg-surface px-4 py-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
              <div className="mt-1 text-2xl font-semibold text-muted">
                {state.kind === "loading" ? "…" : "—"}
              </div>
            </div>
          ))}
      {state.kind === "uninitialized" && (
        <p className="col-span-2 bg-surface px-4 pb-4 text-xs text-muted sm:col-span-4">
          No protocol accounts found on this cluster yet — the numbers appear once{" "}
          <code>initialize_config</code> and <code>initialize_coin</code> have run.
        </p>
      )}
      {state.kind === "error" && (
        <p className="col-span-2 bg-surface px-4 pb-4 text-xs text-muted sm:col-span-4">
          Couldn&apos;t reach the RPC endpoint: {state.message}
        </p>
      )}
    </div>
  );
}
