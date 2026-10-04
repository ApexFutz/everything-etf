"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { BasketWithKey, fetchCoinConfig, fetchConfig, listBasketsPage } from "@/lib/etf/client";
import { Config, CoinConfig } from "@/lib/etf/accounts";
import { COIN_DECIMALS } from "@/lib/etf/constants";
import { formatBps, formatTokens } from "@/lib/format";
import { AddressLink, Banner, Button, ButtonLink, Card, Stat } from "@/components/ui";

const PAGE_SIZE = 10;

export default function BasketsPage() {
  const { connection } = useConnection();
  const [config, setConfig] = useState<Config | null>(null);
  const [coinConfig, setCoinConfig] = useState<CoinConfig | null>(null);
  const [baskets, setBaskets] = useState<BasketWithKey[]>([]);
  const [nextBefore, setNextBefore] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [cfg, coin, page] = await Promise.all([
          fetchConfig(connection),
          fetchCoinConfig(connection),
          listBasketsPage(connection, { pageSize: PAGE_SIZE }),
        ]);
        if (cancelled) return;
        setConfig(cfg);
        setCoinConfig(coin);
        setBaskets(page.baskets);
        setNextBefore(page.nextBefore);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  async function loadMore() {
    if (nextBefore === null) return;
    setLoadingMore(true);
    try {
      const page = await listBasketsPage(connection, { before: nextBefore, pageSize: PAGE_SIZE });
      setBaskets((prev) => [...prev, ...page.baskets]);
      setNextBefore(page.nextBefore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Baskets</h1>
          <p className="mt-1 text-sm text-muted">
            Every basket this program has launched, newest first.
          </p>
        </div>
        <ButtonLink href="/baskets/new">Launch a basket</ButtonLink>
      </div>

      {loading && <p className="text-sm text-muted">Loading protocol state…</p>}

      {error && (
        <Banner kind="error">
          Couldn&apos;t reach the RPC endpoint or decode the program&apos;s accounts: {error}
        </Banner>
      )}

      {!loading && !error && (!config || !coinConfig) && (
        <Banner kind="info">
          The program isn&apos;t initialized on this cluster yet (no <code>Config</code> /{" "}
          <code>CoinConfig</code> account at the expected address). Visit{" "}
          <Link href="/admin" className="underline">
            Admin
          </Link>{" "}
          to run <code>initialize_config</code> and <code>initialize_coin</code>.
        </Banner>
      )}

      {config && coinConfig && (
        <>
          <section className="grid gap-4 sm:grid-cols-2">
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-muted">Protocol</h2>
              <div className="grid grid-cols-2 gap-4">
                <Stat label="Baskets created" value={config.basketCount.toString()} />
                <Stat label="Protocol fee share" value={formatBps(config.protocolShareBps)} />
                <Stat
                  label="SOL creation fee"
                  value={formatTokens(config.creationFeeLamports, 9)}
                />
                <Stat label="Treasury" value={<AddressLink address={config.treasury.toBase58()} />} />
              </div>
            </Card>
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-muted">Cost to launch</h2>
              <div className="grid grid-cols-2 gap-4">
                <Stat
                  label="$EETF fee"
                  value={formatTokens(coinConfig.creationFeeCoin, COIN_DECIMALS)}
                />
                <Stat
                  label="Of which burned"
                  value={formatBps(coinConfig.creationBurnBps)}
                  tone="burn"
                />
                <Stat
                  label="Lifetime burned"
                  value={formatTokens(coinConfig.totalBurned, COIN_DECIMALS)}
                  tone="burn"
                />
                <Stat label="Baskets funded" value={coinConfig.basketsFunded.toString()} />
              </div>
            </Card>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">
              {baskets.length} of {config.basketCount.toString()} shown
            </h2>
            {baskets.length === 0 ? (
              <Card>
                <p className="text-sm text-muted">No baskets yet. Be the first to launch one.</p>
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {baskets.map((b) => (
                  <Link key={b.pubkey.toBase58()} href={`/baskets/${b.id}`} className="group">
                    <Card className="h-full transition-colors group-hover:border-accent">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">Basket #{b.id.toString()}</span>
                        <span className="text-xs text-muted">{b.assets.length} assets</span>
                      </div>
                      <div className="mt-2 text-xs text-muted">
                        Manager <AddressLink address={b.manager.toBase58()} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                        <span>mint {formatBps(b.mintFeeBps)}</span>
                        <span>redeem {formatBps(b.redeemFeeBps)}</span>
                        <span>stream {formatBps(b.streamingFeeBps)}/yr</span>
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
            {nextBefore !== null && (
              <div className="mt-4">
                <Button variant="secondary" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
