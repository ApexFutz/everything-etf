"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { BasketWithKey, fetchCoinConfig, fetchConfig, listBaskets } from "@/lib/etf/client";
import { Config, CoinConfig } from "@/lib/etf/accounts";
import { COIN_DECIMALS, COIN_TOTAL_SUPPLY } from "@/lib/etf/constants";
import { formatBaseUnits, formatBps } from "@/lib/format";
import { AddressLink, Banner, Card, Stat } from "@/components/ui";

export default function Home() {
  const { connection } = useConnection();
  const [config, setConfig] = useState<Config | null>(null);
  const [coinConfig, setCoinConfig] = useState<CoinConfig | null>(null);
  const [baskets, setBaskets] = useState<BasketWithKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [cfg, coin, bskts] = await Promise.all([
          fetchConfig(connection),
          fetchCoinConfig(connection),
          listBaskets(connection),
        ]);
        if (cancelled) return;
        setConfig(cfg);
        setCoinConfig(coin);
        setBaskets(bskts);
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

  if (loading) return <p className="text-sm text-zinc-500">Loading protocol state…</p>;

  if (error) {
    return (
      <Banner kind="error">
        Couldn&apos;t reach the RPC endpoint or decode the program&apos;s accounts: {error}
      </Banner>
    );
  }

  if (!config || !coinConfig) {
    return (
      <Banner kind="info">
        The program isn&apos;t initialized on this cluster yet (no <code>Config</code> /{" "}
        <code>CoinConfig</code> account found at the expected address). Visit{" "}
        <Link href="/admin" className="underline">
          Admin
        </Link>{" "}
        to run <code>initialize_config</code> and <code>initialize_coin</code>.
      </Banner>
    );
  }

  return (
    <div className="space-y-8">
      <section className="grid gap-4 sm:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-zinc-500 dark:text-zinc-400">Protocol</h2>
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Baskets created" value={config.basketCount.toString()} />
            <Stat label="Protocol fee share" value={formatBps(config.protocolShareBps)} />
            <Stat
              label="Creation fee (SOL)"
              value={formatBaseUnits(config.creationFeeLamports, 9)}
            />
            <Stat label="Treasury" value={<AddressLink address={config.treasury.toBase58()} />} />
          </div>
        </Card>
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-zinc-500 dark:text-zinc-400">$EETF</h2>
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label="Circulating"
              value={formatBaseUnits(COIN_TOTAL_SUPPLY - coinConfig.totalBurned, COIN_DECIMALS)}
            />
            <Stat label="Lifetime burned" value={formatBaseUnits(coinConfig.totalBurned, COIN_DECIMALS)} />
            <Stat label="Dev fees paid" value={formatBaseUnits(coinConfig.totalDevFees, COIN_DECIMALS)} />
            <Stat label="Baskets funded" value={coinConfig.basketsFunded.toString()} />
            <Stat
              label="Creation fee"
              value={`${formatBaseUnits(coinConfig.creationFeeCoin, COIN_DECIMALS)} EETF`}
            />
          </div>
        </Card>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">
            Baskets ({baskets.length})
          </h2>
          <Link href="/baskets/new" className="text-sm underline">
            + Create a basket
          </Link>
        </div>
        {baskets.length === 0 ? (
          <Card>
            <p className="text-sm text-zinc-500">No baskets yet. Be the first to launch one.</p>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {baskets.map((b) => (
              <Link key={b.pubkey.toBase58()} href={`/baskets/${b.id}`}>
                <Card className="transition-colors hover:border-black/30 dark:hover:border-white/30">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">Basket #{b.id.toString()}</span>
                    <span className="text-xs text-zinc-500">{b.assets.length} assets</span>
                  </div>
                  <div className="mt-2 text-xs text-zinc-500">
                    Manager: <AddressLink address={b.manager.toBase58()} />
                  </div>
                  <div className="mt-1 flex gap-3 text-xs text-zinc-500">
                    <span>mint {formatBps(b.mintFeeBps)}</span>
                    <span>redeem {formatBps(b.redeemFeeBps)}</span>
                    <span>stream {formatBps(b.streamingFeeBps)}/yr</span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
