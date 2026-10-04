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
  lowerFeesTx,
  mintBasketTx,
  redeemBasketTx,
  seedBasketTx,
} from "@/lib/etf/client";
import { quoteMintDeposits, quoteRedeemPayouts } from "@/lib/etf/quote";
import { FeeRecipient } from "@/lib/etf/instructions";
import { Config } from "@/lib/etf/accounts";
import { BASKET_DECIMALS } from "@/lib/etf/constants";
import { formatBaseUnits, formatBps, parseToBaseUnits, explorerTxUrl } from "@/lib/format";
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

  async function after(sig: string | null) {
    if (sig) await refresh();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">Basket #{basket.id.toString()}</h1>
        <p className="text-sm text-muted">
          Manager <AddressLink address={basket.manager.toBase58()} /> · mint{" "}
          <AddressLink address={basket.mint.toBase58()} />
        </p>
      </div>

      <Card>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Supply" value={formatBaseUnits(supply, BASKET_DECIMALS)} />
          <Stat label="Mint fee" value={formatBps(basket.mintFeeBps)} />
          <Stat label="Redeem fee" value={formatBps(basket.redeemFeeBps)} />
          <Stat label="Streaming fee" value={`${formatBps(basket.streamingFeeBps)}/yr`} />
          <Stat
            label="Manager fees accrued"
            value={formatBaseUnits(basket.managerFeesAccrued, BASKET_DECIMALS)}
          />
          <Stat
            label="Protocol fees accrued"
            value={formatBaseUnits(basket.protocolFeesAccrued, BASKET_DECIMALS)}
          />
          <Stat label="Protocol share" value={formatBps(basket.protocolShareBps)} />
          <Stat label="Assets" value={basket.assets.length} />
        </div>
        <div className="mt-4 space-y-1 text-sm">
          {basket.assets.map((a, i) => (
            <div key={a.toBase58()} className="flex justify-between">
              <AddressLink address={a.toBase58()} chars={6} />
              <span className="text-muted">{assetDecimals[i]} decimals</span>
            </div>
          ))}
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

      {isManager && (
        <LowerFeesForm basket={basket} pending={pending} send={send} onDone={after} setError={setError} />
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

function LowerFeesForm({
  basket,
  pending,
  send,
  onDone,
  setError,
}: {
  basket: BasketWithKey;
  pending: boolean;
  send: SendFn;
  onDone: (sig: string | null) => void;
  setError: (e: string | null) => void;
}) {
  const [mintFeeBps, setMintFeeBps] = useState(String(basket.mintFeeBps));
  const [redeemFeeBps, setRedeemFeeBps] = useState(String(basket.redeemFeeBps));
  const [streamingFeeBps, setStreamingFeeBps] = useState(String(basket.streamingFeeBps));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const ixs = lowerFeesTx({
        manager: basket.manager,
        basket: basket.pubkey,
        basketMint: basket.mint,
        feeEscrow: basket.feeEscrow,
        mintFeeBps: Number(mintFeeBps),
        redeemFeeBps: Number(redeemFeeBps),
        streamingFeeBps: Number(streamingFeeBps),
      });
      onDone(await send(ixs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-muted">
        Lower fees (never raise)
      </h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Mint fee (bps)">
            <TextInput value={mintFeeBps} onChange={(e) => setMintFeeBps(e.target.value)} />
          </Field>
          <Field label="Redeem fee (bps)">
            <TextInput value={redeemFeeBps} onChange={(e) => setRedeemFeeBps(e.target.value)} />
          </Field>
          <Field label="Streaming fee (bps)">
            <TextInput value={streamingFeeBps} onChange={(e) => setStreamingFeeBps(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Update fees"}
        </Button>
      </form>
    </Card>
  );
}
