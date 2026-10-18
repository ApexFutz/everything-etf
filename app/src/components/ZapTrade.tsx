"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Card, Field, TextInput } from "@/components/ui";
import { BasketWithKey, fetchVaultBalances, mintBasketTx, redeemBasketTx } from "@/lib/etf/client";
import { BASKET_DECIMALS } from "@/lib/etf/constants";
import { BasketNav } from "@/lib/etf/nav";
import { WRAPPED_SOL_MINT } from "@/lib/etf/pricing";
import { quoteMintDeposits, quoteRedeemPayouts } from "@/lib/etf/quote";
import { planZapIn, planZapOut, ZapPlan } from "@/lib/etf/zap";
import { buildZapBuy, buildZapSell, haircut, sendZapLaunch, ZapStep } from "@/lib/etf/zapLaunch";
import { describeError } from "@/lib/etf/errors";
import { explorerTxUrl, formatTokens, parseToBaseUnits } from "@/lib/format";

/**
 * Buying and selling a basket with SOL.
 *
 * Minting is in-kind, so without this you can only buy a basket by already
 * holding every token in it, in the ratio the vaults happen to be in — which
 * is a thing arbitrageurs do and nobody else. Here you spend SOL, the swaps
 * land you exactly the deposits the mint needs, and the mint runs in the same
 * signed batch.
 *
 * The ratios are whatever the basket is in right now. Nothing rebalances, so a
 * basket drifts from whatever split it launched with, and buying in means
 * buying that drifted composition — which is why the weights are shown above
 * this form rather than the ones it started with.
 */
export function ZapTrade({
  basket,
  nav,
  solPriceUsd,
  supply,
  symbols,
  onDone,
}: {
  basket: BasketWithKey;
  nav: BasketNav | null;
  /** Live SOL price, to turn a SOL budget into a basket-token amount at NAV. */
  solPriceUsd: number | null;
  supply: bigint;
  symbols: string[];
  onDone: () => void;
}) {
  const { connection } = useConnection();
  const { publicKey, signAllTransactions } = useWallet();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("0.5");
  const [slippagePct, setSlippagePct] = useState("1");
  const [plan, setPlan] = useState<ZapPlan | null>(null);
  const [sellOut, setSellOut] = useState<{ totalOut: bigint; worstTotalOut: bigint } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const slippageBps = Math.round(Number(slippagePct) * 100) || 100;

  /** Basket tokens the entered SOL buys, estimated from NAV. */
  const estimatedTokens = useCallback((): bigint => {
    if (!nav || nav.navPerToken <= 0 || !solPriceUsd) return 0n;
    const usd = Number(amount) * solPriceUsd;
    return BigInt(Math.floor((usd / nav.navPerToken) * 10 ** BASKET_DECIMALS));
  }, [amount, nav, solPriceUsd]);

  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(async () => {
      const amt = Number(amount);
      if (!(amt > 0) || supply === 0n) {
        setPlan(null);
        setSellOut(null);
        return;
      }
      setQuoting(true);
      try {
        const vaults = await fetchVaultBalances(connection, basket.pubkey, basket.assets);

        if (side === "buy") {
          const tokens = estimatedTokens();
          if (tokens <= 0n) {
            setPlan(null);
            return;
          }
          const next = await planZapIn({
            inputMint: WRAPPED_SOL_MINT,
            assets: basket.assets,
            vaultBalances: vaults,
            supply,
            amountOut: tokens,
            slippageBps,
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setPlan(next);
        } else {
          const tokens = parseToBaseUnits(amount, BASKET_DECIMALS);
          const { quoted } = quoteRedeemPayouts(vaults, tokens, supply, basket.redeemFeeBps, 0);
          const next = await planZapOut({
            outputMint: WRAPPED_SOL_MINT,
            assets: basket.assets,
            // Haircut: the swaps spend what the redeem pays out, and asking for
            // more than arrives fails the leg outright.
            payouts: quoted.map(haircut),
            slippageBps,
            signal: controller.signal,
          });
          if (!controller.signal.aborted) {
            setPlan({ ...next, amountOut: tokens, totalIn: 0n, worstTotalIn: 0n, worstPriceImpact: 0 });
            setSellOut({ totalOut: next.totalOut, worstTotalOut: next.worstTotalOut });
          }
        }
      } catch {
        if (!controller.signal.aborted) setPlan(null);
      } finally {
        if (!controller.signal.aborted) setQuoting(false);
      }
    }, 600);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, amount, slippageBps, connection, basket.pubkey, supply]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) return setError("connect a wallet first");
    if (!signAllTransactions) return setError("this wallet can't sign a batch of transactions");
    if (!plan) return setError("no quote yet");

    setError(null);
    setSignature(null);
    setBusy(true);
    try {
      const vaults = await fetchVaultBalances(connection, basket.pubkey, basket.assets);
      let steps: ZapStep[];

      if (side === "buy") {
        const tokens = plan.amountOut;
        const { maxAmountsIn } = quoteMintDeposits(vaults, tokens, supply, Number(slippagePct) / 100);
        steps = await buildZapBuy({
          connection,
          user: publicKey,
          plan,
          symbols,
          mintIxs: new Transaction().add(
            ...mintBasketTx({
              user: publicKey,
              basket: basket.pubkey,
              basketMint: basket.mint,
              feeEscrow: basket.feeEscrow,
              assets: basket.assets,
              amount: tokens,
              maxAmountsIn,
            }),
          ),
        });
      } else {
        const tokens = parseToBaseUnits(amount, BASKET_DECIMALS);
        const { minAmountsOut } = quoteRedeemPayouts(
          vaults,
          tokens,
          supply,
          basket.redeemFeeBps,
          Number(slippagePct) / 100,
        );
        steps = await buildZapSell({
          connection,
          user: publicKey,
          redeemIxs: new Transaction().add(
            ...redeemBasketTx({
              user: publicKey,
              basket: basket.pubkey,
              basketMint: basket.mint,
              feeEscrow: basket.feeEscrow,
              assets: basket.assets,
              amount: tokens,
              minAmountsOut,
            }),
          ),
          plan,
          symbols,
        });
      }

      const signed = await signAllTransactions(steps.map((s) => s.transaction));
      const result = await sendZapLaunch(connection, signed, steps, (p) =>
        setProgress({ done: p.signature ? p.index + 1 : p.index, total: p.total, label: p.step.label }),
      );
      setProgress(null);

      if ("failedAt" in result) {
        const failed = steps[result.failedAt];
        const landed = result.signatures.length;
        setError(
          `Stopped at "${failed.label}" (step ${result.failedAt + 1} of ${steps.length}). ` +
            (side === "buy"
              ? `${landed} step${landed === 1 ? "" : "s"} went through, so you hold part of the basket's tokens — nothing was minted. Try again or raise the slippage.`
              : `The basket tokens were redeemed, so you hold the underlying — only some of the swaps back to SOL ran.`) +
            ` ${describeError(result.error)}`,
        );
        return;
      }
      setSignature(result.signatures[result.signatures.length - 1]);
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const legCount = plan?.legs.filter((l) => l.quote).length ?? basket.assets.length;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted">
          {side === "buy" ? "Buy with SOL" : "Sell for SOL"}
        </h2>
        <div className="flex rounded-lg border border-border p-0.5 text-xs">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSide(s);
                setAmount(s === "buy" ? "0.5" : "1");
                setPlan(null);
              }}
              className={`rounded-md px-2.5 py-1 capitalize transition-colors ${
                side === s ? "bg-surface-2 font-medium" : "text-muted"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={side === "buy" ? "Spend (SOL)" : "Sell (basket tokens)"}>
            <TextInput value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Slippage tolerance (%)" hint="per swap">
            <TextInput
              value={slippagePct}
              onChange={(e) => setSlippagePct(e.target.value)}
              inputMode="decimal"
            />
          </Field>
        </div>

        {quoting && <p className="text-xs text-muted">Quoting…</p>}

        {plan && !quoting && plan.unroutable.length === 0 && (
          <dl className="space-y-1 text-sm">
            {side === "buy" ? (
              <>
                <div className="flex justify-between">
                  <dt className="text-muted">You receive</dt>
                  <dd className="tabular-nums">
                    ~{formatTokens(plan.amountOut, BASKET_DECIMALS, 4)} tokens
                  </dd>
                </div>
                <div className="flex justify-between text-xs text-muted">
                  <dt>Cost at quote</dt>
                  <dd className="tabular-nums">{formatTokens(plan.totalIn, 9, 5)} SOL</dd>
                </div>
                <div className="flex justify-between text-xs text-muted">
                  <dt>Worst case at {slippagePct}%</dt>
                  <dd className="tabular-nums">{formatTokens(plan.worstTotalIn, 9, 5)} SOL</dd>
                </div>
              </>
            ) : (
              sellOut && (
                <>
                  <div className="flex justify-between">
                    <dt className="text-muted">You receive</dt>
                    <dd className="tabular-nums">~{formatTokens(sellOut.totalOut, 9, 5)} SOL</dd>
                  </div>
                  <div className="flex justify-between text-xs text-muted">
                    <dt>Worst case at {slippagePct}%</dt>
                    <dd className="tabular-nums">
                      {formatTokens(sellOut.worstTotalOut, 9, 5)} SOL
                    </dd>
                  </div>
                </>
              )
            )}
          </dl>
        )}

        {/* Nothing quoted and not still quoting: say why rather than showing an
            empty card. On devnet this is permanent — Jupiter has no devnet, so
            there are neither prices to size the trade nor routes to execute it. */}
        {!plan && !quoting && Number(amount) > 0 && (
          <p className="text-xs text-muted">
            {nav && nav.totalUsd > 0
              ? "Couldn't get a quote for that amount — try a different size."
              : "No price for this basket's tokens, so a SOL trade can't be sized. On devnet that's expected: Jupiter is mainnet-only. Use the in-kind forms below."}
          </p>
        )}

        {plan && plan.unroutable.length > 0 && (
          <Banner kind="warn">
            No route for {plan.unroutable.length} of this basket&apos;s tokens, so it can&apos;t be
            traded for SOL in one go. The in-kind form below still works.
          </Banner>
        )}

        {progress && (
          <Banner kind="info">
            Step {progress.done + 1} of {progress.total} — {progress.label}. Keep this tab open.
          </Banner>
        )}
        {error && <Banner kind="error">{error}</Banner>}
        {signature && (
          <Banner kind="success">
            Done.{" "}
            <a className="underline" href={explorerTxUrl(signature)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          </Banner>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!publicKey || !plan || quoting || busy}>
            {busy ? "Working…" : !publicKey ? "Connect a wallet" : side === "buy" ? "Buy" : "Sell"}
          </Button>
          <span className="text-xs text-muted">
            {legCount + 1} transactions, one signature
          </span>
        </div>
      </form>

      <p className="mt-3 text-xs text-muted">
        Buys at the basket&apos;s current ratios, whatever they have drifted to — the weights above
        are what you get, not the ones it launched with.
      </p>
    </Card>
  );
}
