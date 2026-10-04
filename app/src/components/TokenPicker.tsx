"use client";

import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Cluster, filterTokens, searchTokens, TokenOption } from "@/lib/etf/tokens";
import { formatTokens, shortAddress } from "@/lib/format";

/**
 * Type-to-search token picker. Matches the wallet's own holdings locally and
 * queries Jupiter's index for everything else, so a basket can be built out of
 * pump.fun-style tokens by ticker instead of by pasted address. A pasted
 * address still works for anything neither source knows about.
 */
export function TokenPicker({
  walletTokens,
  selected,
  cluster,
  loading,
  onAdd,
  onRemove,
  max,
}: {
  walletTokens: TokenOption[];
  selected: TokenOption[];
  cluster: Cluster;
  loading?: boolean;
  onAdd: (token: TokenOption) => void;
  onRemove: (mint: PublicKey) => void;
  max: number;
}) {
  const { connection } = useConnection();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<TokenOption[]>([]);
  const [searching, setSearching] = useState(false);
  // Highlight is stored with the query it was set against, so a new query
  // resets it on read rather than via an effect + extra render.
  const [highlightState, setHighlightState] = useState({ query: "", index: 0 });
  const highlight = highlightState.query === query ? highlightState.index : 0;
  const setHighlight = (next: number | ((n: number) => number)) =>
    setHighlightState({ query, index: typeof next === "function" ? next(highlight) : next });
  const boxRef = useRef<HTMLDivElement>(null);

  const selectedMints = useMemo(() => new Set(selected.map((s) => s.mint.toBase58())), [selected]);

  const localMatches = useMemo(
    () => filterTokens(walletTokens, query).filter((t) => !selectedMints.has(t.mint.toBase58())),
    [walletTokens, query, selectedMints],
  );

  // Remote search, debounced. Anything the wallet already covers is dropped so
  // the same token doesn't appear twice.
  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    const t = setTimeout(async () => {
      const results = q.length < 2 ? [] : await searchTokens(q, cluster, connection);
      if (!cancelled) {
        setRemote(results);
        setSearching(false);
      }
    }, q.length < 2 ? 0 : 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, cluster, connection]);

  const localMints = useMemo(
    () => new Set(localMatches.map((t) => t.mint.toBase58())),
    [localMatches],
  );
  const remoteMatches = useMemo(
    () =>
      remote.filter(
        (t) => !selectedMints.has(t.mint.toBase58()) && !localMints.has(t.mint.toBase58()),
      ),
    [remote, selectedMints, localMints],
  );
  const matches = useMemo(
    () => [...localMatches, ...remoteMatches],
    [localMatches, remoteMatches],
  );
  const selectable = useMemo(() => matches.filter((t) => !t.blockedReason), [matches]);

  /** A pasted address neither source knows about is still usable. */
  const pastedAddress = useMemo(() => {
    const q = query.trim();
    if (q.length < 32) return null;
    try {
      const mint = new PublicKey(q);
      if (selectedMints.has(mint.toBase58())) return null;
      if (matches.some((m) => m.mint.equals(mint))) return null;
      return mint;
    } catch {
      return null;
    }
  }, [query, matches, selectedMints]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const atMax = selected.length >= max;

  function choose(token: TokenOption) {
    if (token.blockedReason) return;
    onAdd(token);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, selectable.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectable[highlight]) choose(selectable[highlight]);
      else if (pastedAddress) choosePasted(pastedAddress);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function choosePasted(mint: PublicKey) {
    choose({
      mint,
      symbol: shortAddress(mint.toBase58(), 4),
      name: "Pasted address",
      decimals: 0, // the caller resolves this, and checks eligibility
      owned: false,
    });
  }

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {selected.map((t) => (
            <li
              key={t.mint.toBase58()}
              className="flex items-center gap-2 rounded-full border border-border bg-surface-2 py-1 pl-2 pr-1.5 text-sm"
            >
              {t.icon && (
                // eslint-disable-next-line @next/next/no-img-element -- arbitrary remote token icons; not worth a next/image remote-pattern allowlist
                <img src={t.icon} alt="" className="h-5 w-5 rounded-full" />
              )}
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
          disabled={atMax}
          onChange={(e) => {
            setQuery(e.target.value);
            setSearching(e.target.value.trim().length >= 2);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={
            atMax ? `Maximum ${max} tokens` : "Search any token by ticker, or paste a mint address"
          }
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-accent disabled:opacity-60"
          role="combobox"
          aria-expanded={open}
          aria-controls="token-picker-list"
        />

        {open && !atMax && (
          <ul
            id="token-picker-list"
            className="absolute z-10 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-border bg-surface shadow-lg"
          >
            {matches.map((t) => {
              const i = selectable.indexOf(t);
              const blocked = Boolean(t.blockedReason);
              return (
                <li key={t.mint.toBase58()}>
                  <button
                    type="button"
                    disabled={blocked}
                    onMouseEnter={() => !blocked && setHighlight(i)}
                    onClick={() => choose(t)}
                    className={`flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm ${
                      blocked ? "cursor-not-allowed opacity-60" : i === highlight ? "bg-surface-2" : ""
                    }`}
                  >
                    <span className="flex min-w-0 gap-2.5">
                      {t.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element -- see above
                        <img src={t.icon} alt="" className="mt-0.5 h-7 w-7 shrink-0 rounded-full" />
                      ) : (
                        <span className="mt-0.5 h-7 w-7 shrink-0 rounded-full bg-surface-2" />
                      )}
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{t.symbol}</span>
                          {t.verified && <Badge tone="accent">verified</Badge>}
                          {t.owned && <Badge tone="accent">in your wallet</Badge>}
                          {t.scoreLabel === "low" && !t.owned && <Badge tone="muted">low activity</Badge>}
                        </span>
                        <span className="block truncate text-muted">{t.name}</span>
                        {blocked && (
                          <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-400">
                            {t.blockedReason}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-muted">
                      {t.owned ? (
                        <>
                          you hold
                          <br />
                          <span className="tabular-nums text-foreground">
                            {formatTokens(t.balance ?? 0n, t.decimals)}
                          </span>
                        </>
                      ) : t.liquidityUsd ? (
                        <>
                          liquidity
                          <br />
                          <span className="tabular-nums">
                            ${Intl.NumberFormat("en-US", { notation: "compact" }).format(t.liquidityUsd)}
                          </span>
                        </>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}

            {pastedAddress && (
              <li>
                <button
                  type="button"
                  onClick={() => choosePasted(pastedAddress)}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-surface-2"
                >
                  Use pasted address{" "}
                  <code className="text-xs text-muted">{shortAddress(pastedAddress.toBase58(), 6)}</code>
                </button>
              </li>
            )}

            {matches.length === 0 && !pastedAddress && (
              <li className="px-3 py-3 text-sm text-muted">
                {loading || searching
                  ? "Searching…"
                  : query.trim().length < 2
                    ? "Type a ticker to search, or paste a mint address."
                    : "No tokens found."}
              </li>
            )}
          </ul>
        )}
      </div>

      {cluster === "devnet" && (
        <p className="text-xs text-muted">
          Search covers mainnet tokens, which can&apos;t be launched on devnet — only tokens in your
          wallet can. Use the test-token button below to get some.
        </p>
      )}
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "accent" | "muted" }) {
  const styles =
    tone === "accent" ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${styles}`}>{children}</span>;
}
