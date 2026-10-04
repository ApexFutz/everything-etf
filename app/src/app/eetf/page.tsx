"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { crankBurnTx, fetchCoinConfig } from "@/lib/etf/client";
import { CoinConfig } from "@/lib/etf/accounts";
import { COIN_DECIMALS, COIN_TOTAL_SUPPLY, MIN_CREATION_BURN_BPS } from "@/lib/etf/constants";
import { CREATION_FEE_USD_TARGET } from "@/lib/etf/pricing";
import { explorerTxUrl, formatBps, formatTokens } from "@/lib/format";
import { AddressLink, Banner, Button, Card, Pill, Stat } from "@/components/ui";
import { useSendTx } from "@/hooks/useSendTx";

export default function EetfPage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { send, pending, error, signature } = useSendTx();

  const [coin, setCoin] = useState<CoinConfig | null>(null);
  const [burnVaultBalance, setBurnVaultBalance] = useState<bigint | null>(null);
  const [mintSupply, setMintSupply] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const c = await fetchCoinConfig(connection);
      setCoin(c);
      if (c) {
        const [vault, mint] = await Promise.all([
          connection.getAccountInfo(c.burnVault),
          connection.getAccountInfo(c.mint),
        ]);
        // Raw SPL layouts: token account amount is a u64 at offset 64; mint
        // supply is a u64 at offset 36.
        setBurnVaultBalance(vault ? vault.data.readBigUInt64LE(64) : 0n);
        setMintSupply(mint ? mint.data.readBigUInt64LE(36) : null);
      }
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; refresh() doubles as the post-transaction reload.
    refresh();
  }, [refresh]);

  const burnedPct =
    coin && COIN_TOTAL_SUPPLY > 0n
      ? (Number(coin.totalBurned) / Number(COIN_TOTAL_SUPPLY)) * 100
      : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-6 py-10">
      <div>
        <Pill tone="accent">Fixed supply · burn only</Pill>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">$EETF</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          One coin for the whole launchpad, minted once and never again. Everything on this page is
          read straight off the program&apos;s own accounts, so circulating supply and lifetime burn
          are verifiable without trusting this dashboard.
        </p>
      </div>

      {loading && <p className="text-sm text-muted">Loading on-chain figures…</p>}
      {loadError && <Banner kind="error">Couldn&apos;t read the coin accounts: {loadError}</Banner>}

      {!loading && !coin && (
        <Banner kind="info">
          $EETF hasn&apos;t been initialized on this cluster yet — no <code>CoinConfig</code> account
          at the expected address.
        </Banner>
      )}

      {coin && (
        <>
          <Card>
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              <Stat
                label="Genesis supply"
                value={formatTokens(COIN_TOTAL_SUPPLY, COIN_DECIMALS)}
                sub="minted once, authority revoked"
              />
              <Stat
                label="Circulating"
                value={formatTokens(COIN_TOTAL_SUPPLY - coin.totalBurned, COIN_DECIMALS)}
                sub={mintSupply !== null ? "matches on-chain mint supply" : undefined}
              />
              <Stat
                label="Lifetime burned"
                value={formatTokens(coin.totalBurned, COIN_DECIMALS)}
                tone="burn"
                sub={`${burnedPct.toFixed(4)}% of genesis`}
              />
              <Stat label="Baskets funded" value={coin.basketsFunded.toString()} />
            </div>

            {/* Supply retired, as a bar. Tiny percentages still want to show
                *something*, hence the minimum width. */}
            <div className="mt-6">
              <div className="mb-1.5 flex justify-between text-xs text-muted">
                <span>Supply retired</span>
                <span className="tabular-nums">{burnedPct.toFixed(4)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-burn"
                  style={{ width: `${Math.max(burnedPct, burnedPct > 0 ? 0.5 : 0)}%` }}
                />
              </div>
            </div>
          </Card>

          {mintSupply !== null && mintSupply !== COIN_TOTAL_SUPPLY - coin.totalBurned && (
            <Banner kind="warn">
              The SPL mint&apos;s supply ({formatTokens(mintSupply, COIN_DECIMALS)}) doesn&apos;t
              match genesis minus <code>total_burned</code> (
              {formatTokens(COIN_TOTAL_SUPPLY - coin.totalBurned, COIN_DECIMALS)}). Those should
              always agree — worth investigating.
            </Banner>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <h2 className="font-semibold">Cost to launch a basket</h2>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Stat
                  label="Creation fee"
                  value={`${formatTokens(coin.creationFeeCoin, COIN_DECIMALS)}`}
                  sub={`EETF, per basket — targets $${CREATION_FEE_USD_TARGET}`}
                />
                <Stat label="Burned" value={formatBps(coin.creationBurnBps)} tone="burn" />
              </div>
              <p className="mt-4 text-sm leading-relaxed text-muted">
                The burn share can be raised but never pushed below{" "}
                {formatBps(MIN_CREATION_BURN_BPS)} — that floor is hardcoded, not a setting. The
                remainder ({formatTokens(coin.totalDevFees, COIN_DECIMALS)} EETF so far) goes to
                the dev treasury.
              </p>
            </Card>

            <Card>
              <h2 className="font-semibold">Burn vault</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                A one-way sink owned by the coin PDA. Anyone can send $EETF in; the only instruction
                that moves it again destroys it. Cranking is permissionless — the only possible
                outcome is a smaller supply.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Stat
                  label="Waiting to burn"
                  value={
                    burnVaultBalance !== null
                      ? formatTokens(burnVaultBalance, COIN_DECIMALS)
                      : "…"
                  }
                  tone="burn"
                />
                <Stat label="Vault" value={<AddressLink address={coin.burnVault.toBase58()} />} />
              </div>
              <div className="mt-4">
                <Button
                  variant="secondary"
                  disabled={pending || !publicKey || !burnVaultBalance}
                  onClick={async () => {
                    if (!publicKey) return;
                    const sig = await send(crankBurnTx({ cranker: publicKey }));
                    if (sig) await refresh();
                  }}
                >
                  {pending
                    ? "Burning…"
                    : !publicKey
                      ? "Connect a wallet to crank"
                      : !burnVaultBalance
                        ? "Nothing to burn"
                        : "Crank the burn"}
                </Button>
              </div>
            </Card>
          </div>

          {error && <Banner kind="error">{error}</Banner>}
          {signature && (
            <Banner kind="success">
              Burned.{" "}
              <a
                className="underline"
                href={explorerTxUrl(signature)}
                target="_blank"
                rel="noreferrer"
              >
                View transaction
              </a>
            </Banner>
          )}

          <Card className="border-dashed">
            <h2 className="font-semibold">What $EETF is not</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              It does <strong>not</strong> entitle holders to any share of protocol fees, is{" "}
              <strong>not</strong> required to hold or trade a basket token, and does{" "}
              <strong>not</strong> vote on anything. Treasury revenue being swapped into $EETF and
              sent to the burn vault is a stated policy, not something the program enforces.
            </p>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Mint</dt>
                <dd className="mt-0.5">
                  <AddressLink address={coin.mint.toBase58()} chars={6} />
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Dev treasury</dt>
                <dd className="mt-0.5">
                  <AddressLink address={coin.devTreasury.toBase58()} chars={6} />
                </dd>
              </div>
            </dl>
          </Card>
        </>
      )}
    </div>
  );
}
