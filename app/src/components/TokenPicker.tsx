"use client";

import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { filterTokens, TokenOption } from "@/lib/etf/tokens";
import { formatTokens, shortAddress } from "@/lib/format";

/**
 * Type-to-search token picker. Searches symbol, name, or address prefix over
 * the options provided, and still accepts a pasted mint address that isn't in
 * the list — the list is a convenience, not a whitelist.
 */
export function TokenPicker({
  options,
  selected,
  loading,
  onAdd,
  onRemove,
  disabled,
  max,
}: {
  options: TokenOption[];
  selected: TokenOption[];
  loading?: boolean;
  onAdd: (token: TokenOption) => void;
  onRemove: (mint: PublicKey) => void;
  disabled?: boolean;
  max: number;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // Highlight is stored with the query it was set against, so a new query
  // resets it on read rather than via an effect + extra render.
  const [highlightState, setHighlightState] = useState({ query: "", index: 0 });
  const highlight = highlightState.query === query ? highlightState.index : 0;
  const setHighlight = (next: number | ((n: number) => number)) =>
    setHighlightState({
      query,
      index: typeof next === "function" ? next(highlight) : next,
    });
  const boxRef = useRef<HTMLDivElement>(null);

  const selectedMints = useMemo(
    () => new Set(selected.map((s) => s.mint.toBase58())),
    [selected],
  );

  const matches = useMemo(
    () => filterTokens(options, query).filter((t) => !selectedMints.has(t.mint.toBase58())),
    [options, query, selectedMints],
  );

  /** A pasted address that isn't in the list is still usable. */
  const pastedAddress = useMemo(() => {
    const q = query.trim();
    if (q.length < 32 || matches.length > 0) return null;
    try {
      const mint = new PublicKey(q);
      return selectedMints.has(mint.toBase58()) ? null : mint;
    } catch {
      return null;
    }
  }, [query, matches.length, selectedMints]);

  // Close when clicking away, so the dropdown doesn't linger over the form.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const atMax = selected.length >= max;

  function choose(token: TokenOption) {
    onAdd(token);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[highlight]) choose(matches[highlight]);
      else if (pastedAddress) {
        choose({
          mint: pastedAddress,
          symbol: shortAddress(pastedAddress.toBase58(), 4),
          name: "Pasted address",
          decimals: 0, // resolved by the caller
          owned: false,
        });
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {selected.map((t) => (
            <li
              key={t.mint.toBase58()}
              className="flex items-center gap-2 rounded-full border border-border bg-surface-2 py-1 pl-3 pr-1.5 text-sm"
            >
              <span className="font-medium">{t.symbol}</span>
              <code className="text-xs text-muted">{shortAddress(t.mint.toBase58(), 4)}</code>
              <button
                type="button"
                aria-label={`Remove ${t.symbol}`}
                onClick={() => onRemove(t.mint)}
                className="rounded-full px-1.5 text-muted transition-colors hover:bg-border hover:text-foreground"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div ref={boxRef} className="relative">
        <input
          value={query}
          disabled={disabled || atMax}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={
            atMax
              ? `Maximum ${max} tokens`
              : loading
                ? "Loading your tokens…"
                : "Search a ticker, or paste a mint address"
          }
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-accent disabled:opacity-60"
          role="combobox"
          aria-expanded={open}
          aria-controls="token-picker-list"
        />

        {open && !atMax && (
          <ul
            id="token-picker-list"
            className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border bg-surface shadow-lg"
          >
            {matches.map((t, i) => (
              <li key={t.mint.toBase58()}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(t)}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${
                    i === highlight ? "bg-surface-2" : ""
                  }`}
                >
                  <span className="min-w-0">
                    <span className="font-medium">{t.symbol}</span>{" "}
                    <span className="text-muted">{t.name}</span>
                    <br />
                    <code className="text-xs text-muted">{shortAddress(t.mint.toBase58(), 5)}</code>
                  </span>
                  <span className="shrink-0 text-right text-xs">
                    {t.owned ? (
                      <>
                        <span className="text-muted">you hold</span>
                        <br />
                        <span className="tabular-nums">
                          {formatTokens(t.balance ?? 0n, t.decimals)}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted">not held</span>
                    )}
                  </span>
                </button>
              </li>
            ))}

            {pastedAddress && (
              <li>
                <button
                  type="button"
                  onClick={() =>
                    choose({
                      mint: pastedAddress,
                      symbol: shortAddress(pastedAddress.toBase58(), 4),
                      name: "Pasted address",
                      decimals: 0,
                      owned: false,
                    })
                  }
                  className="w-full px-3 py-2 text-left text-sm hover:bg-surface-2"
                >
                  Use pasted address{" "}
                  <code className="text-xs text-muted">
                    {shortAddress(pastedAddress.toBase58(), 6)}
                  </code>
                </button>
              </li>
            )}

            {matches.length === 0 && !pastedAddress && (
              <li className="px-3 py-3 text-sm text-muted">
                {loading
                  ? "Loading your tokens…"
                  : options.length === 0
                    ? "No tokens found in your wallet on this cluster."
                    : "No match. Paste a mint address to use it anyway."}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
