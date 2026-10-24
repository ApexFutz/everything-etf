"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getMint } from "@solana/spl-token";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  accrueFeesTx,
  BasketWithKey,
  claimFeesTx,
  fetchBasketById,
  fetchConfig,
  fetchVaultBalances,
  mintBasketTx,
  redeemBasketTx,
  seedBasketTx,
  fetchProfile,
} from "@/lib/etf/client";
import { quoteMintDeposits, quoteRedeemPayouts } from "@/lib/etf/quote";
import { BasketNav, computeNav } from "@/lib/etf/nav";
import { resolveForPricing } from "@/lib/etf/demo";
import { Creator } from "@/components/Creator";
import { ZapTrade } from "@/components/ZapTrade";
import { fetchUsdPrice, WRAPPED_SOL_MINT } from "@/lib/etf/pricing";
import { fetchMetadataFor } from "@/lib/etf/metadata";
import { getStandIn } from "@/lib/etf/demo";
import { FeeRecipient } from "@/lib/etf/instructions";
import { Config } from "@/lib/etf/accounts";
import { BASKET_DECIMALS } from "@/lib/etf/constants";
import { seedFromSol, venueLinks, type PoolSeed } from "@/lib/etf/pool";
import {
  formatBaseUnits,
  formatBps,
  formatTokens,
  parseToBaseUnits,
  explorerTxUrl,
} from "@/lib/format";
import { AddressLink, Banner, Button, Card, Field, Stat, TextInput } from "@/components/ui";
import { useSendTx } from "@/hooks/useSendTx";

export default function BasketPage() {
  const params = useParams<{ id: string }>();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { send, pending, error, signature, setError } = useSendTx();

  const [basket, setBasket] = useState<BasketWithKey | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [supply, setSupply] = useState<bigint | null>(null);
  const [assetDecimals, setAssetDecimals] = useState<number[]>([]);
  const [nav, setNav] = useState<BasketNav | null>(null);
  const [managerName, setManagerName] = useState<string | null>(null);
  const [solPriceUsd, setSolPriceUsd] = useState<number | null>(null);
  /** Symbols for the basket's assets, for labelling the swap steps. */
  const [assetSymbols, setAssetSymbols] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const id = BigInt(params.id);
      const [b, cfg] = await Promise.all([fetchBasketById(connection, id), fetchConfig(connection)]);
      if (!b) {
        setLoadError(`no basket #${params.id} on this cluster`);
        return;
      }
      setBasket(b);
      setConfig(cfg);
      const mint = await getMint(connection, b.mint);
      setSupply(mint.supply);
      const decimals = await Promise.all(b.assets.map(async (a) => (await getMint(connection, a)).decimals));
      setAssetDecimals(decimals);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [connection, params.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount; refresh() is also reused as a manual post-tx reload.
    refresh();
  }, [refresh]);

  /**
   * Live composition, priced off-chain. Kept out of `refresh` because it
   * depends on an external price API that can be slow or down, and the page
   * must still render the chain's own numbers when it is.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!basket || supply === null || assetDecimals.length !== basket.assets.length) return;
      const balances = await fetchVaultBalances(connection, basket.pubkey, basket.assets);
      const next = await computeNav(
        basket.assets,
        balances,
        assetDecimals,
        supply,
        BASKET_DECIMALS,
        // Demo baskets hold devnet stand-ins; price them as the real tokens.
        resolveForPricing(basket.assets),
      );
      if (!cancelled) setNav(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, basket, supply, assetDecimals]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!basket) return;
      const [p, sol, meta] = await Promise.all([
        fetchProfile(connection, basket.manager),
        fetchUsdPrice(WRAPPED_SOL_MINT),
        fetchMetadataFor(connection, basket.assets),
      ]);
      if (cancelled) return;
      setManagerName(p?.name ?? null);
      setSolPriceUsd(sol);
      setAssetSymbols(
        basket.assets.map(
          (a, i) => meta[i]?.symbol || getStandIn(a)?.symbol || a.toBase58().slice(0, 4),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, basket]);

  if (loading && !basket) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <p className="text-sm text-muted">Loading basket…</p>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Banner kind="error">{loadError}</Banner>
      </div>
    );
  }
  if (!basket || supply === null) return null;

  const isManager = publicKey?.equals(basket.manager) ?? false;
  const isProtocolAuthority = (config && publicKey?.equals(config.authority)) ?? false;
  const isSeeded = supply > 0n;
  // Pools and the aggregator UIs only index mainnet, so the seed action is
  // mainnet-only; devnet gets the preview math but a disabled button.
  const isMainnet = /mainnet/i.test(connection.rpcEndpoint);
  const accruedFees = basket.managerFeesAccrued + basket.protocolFeesAccrued;

  async function after(sig: string | null) {
    if (sig) await refresh();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">Basket #{basket.id.toString()}</h1>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <span>by</span>
          <Creator address={basket.manager} size="md" showAddress={false} chosenName={managerName} />
          <AddressLink address={basket.manager.toBase58()} />
          <span>· mint</span>
          <AddressLink address={basket.mint.toBase58()} />
        </p>
      </div>

      <Card>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Supply" value={formatTokens(supply, BASKET_DECIMALS, 4)} />
          <Stat label="Fees" value="None" sub="mint, redeem and holding are all free" />
          <Stat label="Assets" value={basket.assets.length} />
          {/* Accrued fees and the protocol's share of them are shown only when
              there is something to show. Every fee cap is zero, so for any
              basket created now these are permanently 0 and a "10% protocol
              share" beside them reads as a cut that is never taken. Baskets
              created before the caps went to zero still carry real balances,
              and hiding those would be hiding someone's money. */}
          {accruedFees > 0n && (
            <>
              <Stat
                label="Manager fees accrued"
                value={formatTokens(basket.managerFeesAccrued, BASKET_DECIMALS, 4)}
                sub="from before fees were removed"
              />
              <Stat
                label="Protocol fees accrued"
                value={formatTokens(basket.protocolFeesAccrued, BASKET_DECIMALS, 4)}
              />
              <Stat label="Protocol share" value={formatBps(basket.protocolShareBps)} />
            </>
          )}
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="font-medium">What&apos;s in it</span>
            {nav && nav.totalUsd > 0 && (
              <span className="text-muted">
                ${nav.totalUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} total ·{" "}
                <span className="tabular-nums">
                  ${nav.navPerToken < 0.01 ? nav.navPerToken.toPrecision(3) : nav.navPerToken.toFixed(4)}
                </span>{" "}
                per token
                {nav.change24h !== null && (
                  <span
                    className={
                      nav.change24h >= 0
                        ? " text-emerald-600 dark:text-emerald-400"
                        : " text-red-600 dark:text-red-400"
                    }
                  >
                    {" · "}
                    {nav.change24h >= 0 ? "+" : ""}
                    {nav.change24h.toFixed(2)}% 24h
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="space-y-1.5 text-sm">
            {basket.assets.map((a, i) => {
              const v = nav?.assets[i];
              return (
                <div key={a.toBase58()}>
                  <div className="flex items-baseline justify-between gap-3">
                    <AddressLink address={a.toBase58()} chars={6} />
                    <span className="shrink-0 tabular-nums text-muted">
                      {v?.weight != null ? (
                        <>
                          <span className="text-foreground">{(v.weight * 100).toFixed(1)}%</span>
                          {v.valueUsd != null && <> · ${v.valueUsd.toFixed(2)}</>}
                          {v.change24h !== undefined && (
                            <span
                              className={
                                v.change24h >= 0
                                  ? " text-emerald-600 dark:text-emerald-400"
                                  : " text-red-600 dark:text-red-400"
                              }
                            >
                              {" "}
                              {v.change24h >= 0 ? "+" : ""}
                              {v.change24h.toFixed(2)}%
                            </span>
                          )}
                        </>
                      ) : (
                        <>{assetDecimals[i]} decimals</>
                      )}
                    </span>
                  </div>
                  {v?.weight != null && (
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${Math.max(v.weight * 100, 0.5)}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {nav && nav.unpriced.length > 0 && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              {nav.unpriced.length} token{nav.unpriced.length === 1 ? " has" : "s have"} no price —
              the total above excludes {nav.unpriced.length === 1 ? "it" : "them"}, so it understates
              the basket.
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            Live weights, not the ones it launched with. Nothing rebalances, so these move with
            price.
          </p>
        </div>
      </Card>

      {error && <Banner kind="error">{error}</Banner>}
      {signature && (
        <Banner kind="success">
          Confirmed.{" "}
          <a className="underline" href={explorerTxUrl(signature)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </Banner>
      )}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-muted">Permissionless</h2>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={async () => after(await send(accrueFeesTx({ basket: basket.pubkey, basketMint: basket.mint, feeEscrow: basket.feeEscrow })))}
        >
          Accrue streaming fees now
        </Button>
      </Card>

      {!isSeeded && isManager && (
        <SeedForm basket={basket} decimals={assetDecimals} pending={pending} send={send} onDone={after} setError={setError} />
      )}
      {!isSeeded && !isManager && (
        <Banner kind="info">This basket hasn&apos;t been seeded yet. Only its manager can seed it.</Banner>
      )}

      {isSeeded && (
        <>
          <ZapTrade
            basket={basket}
            nav={nav}
            solPriceUsd={solPriceUsd}
            supply={supply}
            symbols={assetSymbols}
            onDone={refresh}
          />
          <MintRedeemForm
            kind="mint"
            basket={basket}
            pending={pending}
            send={send}
            onDone={after}
            setError={setError}
          />
          <MintRedeemForm
            kind="redeem"
            basket={basket}
            pending={pending}
            send={send}
            onDone={after}
            setError={setError}
          />
          <SeedPoolCard
            basket={basket}
            nav={nav}
            solPriceUsd={solPriceUsd}
            isManager={isManager}
            isMainnet={isMainnet}
          />
        </>
      )}

      {isManager && basket.managerFeesAccrued > 0n && (
        <ClaimCard
          label="Claim manager fees"
          recipient={FeeRecipient.Manager}
          basket={basket}
          payoutOwner={basket.manager}
          pending={pending}
          send={send}
          onDone={after}
        />
      )}
      {isProtocolAuthority && config && basket.protocolFeesAccrued > 0n && (
        <ClaimCard
          label="Claim protocol fees"
          recipient={FeeRecipient.Protocol}
          basket={basket}
          payoutOwner={config.treasury}
          pending={pending}
          send={send}
          onDone={after}
        />
      )}

    </div>
  );
}

type SendFn = ReturnType<typeof useSendTx>["send"];

function SeedForm({
  basket,
  decimals,
  pending,
  send,
  onDone,
  setError,
}: {
  basket: BasketWithKey;
  decimals: number[];
  pending: boolean;
  send: SendFn;
  onDone: (sig: string | null) => void;
  setError: (e: string | null) => void;
}) {
  const [initialSupply, setInitialSupply] = useState("1000");
  const [amounts, setAmounts] = useState<string[]>(basket.assets.map(() => "1000"));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const amountsBase = amounts.map((a, i) => parseToBaseUnits(a, decimals[i] ?? 9));
      const ixs = seedBasketTx({
        manager: basket.manager,
        basket: basket.pubkey,
        basketMint: basket.mint,
        assets: basket.assets,
        initialSupply: parseToBaseUnits(initialSupply, BASKET_DECIMALS),
        amounts: amountsBase,
      });
      onDone(await send(ixs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-muted">Seed this basket</h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Initial basket-token supply">
          <TextInput value={initialSupply} onChange={(e) => setInitialSupply(e.target.value)} />
        </Field>
        {basket.assets.map((a, i) => (
          <Field key={a.toBase58()} label={`Deposit: ${a.toBase58().slice(0, 8)}… (${decimals[i] ?? "?"} dec.)`}>
            <TextInput
              value={amounts[i]}
              onChange={(e) => setAmounts((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
            />
          </Field>
        ))}
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Seed basket"}
        </Button>
      </form>
    </Card>
  );
}

function MintRedeemForm({
  kind,
  basket,
  pending,
  send,
  onDone,
  setError,
}: {
  kind: "mint" | "redeem";
  basket: BasketWithKey;
  pending: boolean;
  send: SendFn;
  onDone: (sig: string | null) => void;
  setError: (e: string | null) => void;
}) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("1");
  const [slippagePct, setSlippagePct] = useState("1");
  const [preview, setPreview] = useState<{ quoted: bigint[]; decimals: number[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  async function quoteNow(amt: bigint, slippage: number) {
    const [vaultBalances, decimals, supply] = await Promise.all([
      fetchVaultBalances(connection, basket.pubkey, basket.assets),
      Promise.all(basket.assets.map(async (a) => (await getMint(connection, a)).decimals)),
      getMint(connection, basket.mint).then((m) => m.supply),
    ]);
    if (kind === "mint") {
      const { quoted, maxAmountsIn } = quoteMintDeposits(vaultBalances, amt, supply, slippage);
      return { quoted, bound: maxAmountsIn, decimals };
    }
    const { quoted, minAmountsOut } = quoteRedeemPayouts(
      vaultBalances,
      amt,
      supply,
      basket.redeemFeeBps,
      slippage,
    );
    return { quoted, bound: minAmountsOut, decimals };
  }

  async function onPreview() {
    setError(null);
    setPreviewing(true);
    try {
      const amt = parseToBaseUnits(amount, BASKET_DECIMALS);
      const { quoted, decimals } = await quoteNow(amt, Number(slippagePct) / 100);
      setPreview({ quoted, decimals });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) return setError("connect a wallet first");
    try {
      const amt = parseToBaseUnits(amount, BASKET_DECIMALS);
      // Re-quote fresh right before sending rather than reusing a possibly
      // stale preview — the slippage tolerance covers the gap between this
      // quote and the transaction actually landing, not between this quote
      // and an earlier one.
      const { bound } = await quoteNow(amt, Number(slippagePct) / 100);
      if (kind === "mint") {
        const ixs = mintBasketTx({
          user: publicKey,
          basket: basket.pubkey,
          basketMint: basket.mint,
          feeEscrow: basket.feeEscrow,
          assets: basket.assets,
          amount: amt,
          maxAmountsIn: bound,
        });
        onDone(await send(ixs));
      } else {
        const ixs = redeemBasketTx({
          user: publicKey,
          basket: basket.pubkey,
          basketMint: basket.mint,
          feeEscrow: basket.feeEscrow,
          assets: basket.assets,
          amount: amt,
          minAmountsOut: bound,
        });
        onDone(await send(ixs));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-muted">
        {kind === "mint" ? "Mint basket tokens" : "Redeem basket tokens"}
      </h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Amount (basket tokens)">
          <TextInput value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field
          label="Slippage tolerance (%)"
          hint="Applied on top of a live quote of each vault's current balance."
        >
          <TextInput value={slippagePct} onChange={(e) => setSlippagePct(e.target.value)} />
        </Field>
        <Button type="button" variant="secondary" disabled={previewing} onClick={onPreview}>
          {previewing ? "Quoting…" : kind === "mint" ? "Preview required deposits" : "Preview payout"}
        </Button>
        {preview && (
          <div className="space-y-1 rounded-lg border border-border p-3 text-xs">
            {basket.assets.map((a, i) => (
              <div key={a.toBase58()} className="flex justify-between">
                <span className="font-mono">{a.toBase58().slice(0, 8)}…</span>
                <span>{formatBaseUnits(preview.quoted[i], preview.decimals[i])}</span>
              </div>
            ))}
          </div>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : kind === "mint" ? "Mint" : "Redeem"}
        </Button>
      </form>
    </Card>
  );
}

function ClaimCard({
  label,
  recipient,
  basket,
  payoutOwner,
  pending,
  send,
  onDone,
}: {
  label: string;
  recipient: FeeRecipient;
  basket: BasketWithKey;
  payoutOwner: BasketWithKey["manager"];
  pending: boolean;
  send: SendFn;
  onDone: (sig: string | null) => void;
}) {
  const { publicKey } = useWallet();
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-muted">{label}</h2>
      <Button
        disabled={pending || !publicKey}
        onClick={async () =>
          publicKey &&
          onDone(
            await send(
              claimFeesTx({
                claimer: publicKey,
                basket: basket.pubkey,
                basketMint: basket.mint,
                feeEscrow: basket.feeEscrow,
                assets: basket.assets,
                payoutOwner,
                recipient,
              }),
            ),
          )
        }
      >
        {pending ? "Sending…" : label}
      </Button>
    </Card>
  );
}

/**
 * Listing a basket token on a DEX.
 *
 * The token is already a mint; a basket/SOL pool is what makes it buyable in
 * the aggregator-fed UIs (pump.fun, fomo, DexScreener). Seeding it *at NAV* is
 * the whole trick — a constant-product pool opens at the ratio of its two
 * deposits, so depositing equal USD value of basket token and SOL opens it at
 * NAV, and the in-kind mint/redeem above keeps it there by arbitrage.
 *
 * The sizing math (`pool.ts`) runs live here so a manager sees exactly what
 * they'd deposit. Execution is mainnet-only — pools and these UIs don't index
 * devnet — so the button is disabled until the Raydium wiring lands at launch.
 */
function SeedPoolCard({
  basket,
  nav,
  solPriceUsd,
  isManager,
  isMainnet,
}: {
  basket: BasketWithKey;
  nav: BasketNav | null;
  solPriceUsd: number | null;
  isManager: boolean;
  isMainnet: boolean;
}) {
  const [solAmount, setSolAmount] = useState("5");
  const links = venueLinks(basket.mint.toBase58());

  const amt = Number(solAmount);
  const canSize =
    nav !== null && solPriceUsd !== null && nav.navPerToken > 0 && nav.unpriced.length === 0;
  let seed: PoolSeed | null = null;
  let seedError: string | null = null;
  if (nav && solPriceUsd && canSize && amt > 0) {
    try {
      seed = seedFromSol(amt, nav.navPerToken, solPriceUsd);
    } catch (e) {
      seedError = e instanceof Error ? e.message : String(e);
    }
  }

  const usd = (n: number) => (n < 0.01 ? n.toPrecision(3) : n.toFixed(4));

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-muted">List on a DEX</h2>
      <p className="text-sm text-muted">
        A basket/SOL pool makes this token buyable anywhere Solana tokens trade — pump.fun, fomo
        and DexScreener all read the same pools. Arbitrage against the in-kind mint/redeem above
        keeps the pool price near NAV.
      </p>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {(
          [
            ["Jupiter", links.jupiter],
            ["DexScreener", links.dexscreener],
            ["Birdeye", links.birdeye],
            ["pump.fun", links.pumpfun],
          ] as const
        ).map(([label, href]) => (
          <a key={label} className="underline" href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        ))}
      </div>
      {!isMainnet && (
        <p className="mt-2 text-xs text-muted">
          These resolve once the token is seeded on mainnet; on devnet there&apos;s no pool and the
          aggregators don&apos;t index it.
        </p>
      )}

      {isManager && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <Field label="Seed size (SOL on the SOL side)" hint="Matched with basket tokens of equal value at NAV.">
            <TextInput value={solAmount} onChange={(e) => setSolAmount(e.target.value)} />
          </Field>
          {seed && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat
                label="Deposit · basket tokens"
                value={formatTokens(seed.basketTokenAmount, BASKET_DECIMALS, 4)}
              />
              <Stat label="Deposit · SOL" value={formatTokens(seed.solLamports, 9, 4)} />
              <Stat label="Opens at" value={`$${usd(seed.priceUsdPerToken)}`} sub="= NAV per token" />
            </div>
          )}
          {seedError && <Banner kind="error">{seedError}</Banner>}
          {!canSize && (
            <Banner kind="info">
              Sizing needs a live NAV and SOL price. That isn&apos;t available on devnet, or for a
              basket with any unpriced asset.
            </Banner>
          )}
          <Button variant="secondary" disabled>
            {isMainnet ? "Seed pool — Raydium wiring pending" : "Seed pool — mainnet only"}
          </Button>
          <p className="text-xs text-muted">
            Seeding runs on mainnet-beta via a Raydium CPMM pool; the amounts above come straight
            from the on-chain NAV. The create-pool transaction is wired at launch.
          </p>
        </div>
      )}
    </Card>
  );
}

