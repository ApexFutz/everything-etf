"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Card, Field, Pill, TextInput } from "@/components/ui";
import { TokenPicker } from "@/components/TokenPicker";
import { WeightAllocator } from "@/components/WeightAllocator";
import { createBasketTx, fetchCoinConfig, fetchConfig, seedBasketTx } from "@/lib/etf/client";
import { estimateCreateCost, CreateCostEstimate } from "@/lib/etf/costs";
import { allocateBudget, normalize, validateAllocation } from "@/lib/etf/weights";
import { planZapIn, ZapPlan } from "@/lib/etf/zap";
import { buildZapLaunch, sendZapLaunch } from "@/lib/etf/zapLaunch";
import { describeError } from "@/lib/etf/errors";
import {
  CREATION_FEE_USD_TARGET,
  fetchUsdPrice,
  fetchUsdPrices,
  usdValueOfCoin,
  WRAPPED_SOL_MINT,
} from "@/lib/etf/pricing";
import { createAndFundTestMints, createStandInMints } from "@/lib/etf/devHelpers";
import { recordStandIns, resolveForPricing } from "@/lib/etf/demo";
import {
  BASKET_DECIMALS,
  COIN_DECIMALS,
  MAX_ASSETS,
  MIN_ASSETS,
} from "@/lib/etf/constants";
import { CoinConfig, Config } from "@/lib/etf/accounts";
import { checkEligibility, clusterOf, fetchWalletTokens, TokenOption } from "@/lib/etf/tokens";
import { DEFAULT_RPC_URL } from "@/lib/etf/constants";
import { explorerTxUrl, formatBps, formatTokens, parseToBaseUnits, shortAddress } from "@/lib/format";
import { useSendTx } from "@/hooks/useSendTx";

/**
 * Basket tokens the first deposit creates. At seed time there's no prior NAV,
 * so this number only sets the denomination — asking the user would be asking a
 * question with no meaningful answer. The seeder ends up holding all of it.
 */
const INITIAL_SUPPLY_TOKENS = 1_000_000n;

/** Practice mode only makes sense where the real tokens are absent. */
const IS_DEVNET = clusterOf(DEFAULT_RPC_URL) === "devnet";

type Asset = {
  address: PublicKey;
  decimals: number;
  symbol: string;
  /**
   * Set while a real token has been picked on devnet but its stand-in hasn't
   * been created yet. `address` is the mainnet mint until then, which cannot
   * be transacted against here — hence the gate before launch.
   */
  pendingStandIn?: { mainnet: PublicKey; name: string };
};

export default function NewBasketPage() {
  const { connection } = useConnection();
  const { publicKey, signAllTransactions } = useWallet();
  const router = useRouter();
  const { send, pending, error, setError } = useSendTx();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  /**
   * Starting composition. Equal is the default because it's a reasonable
   * opening position, not because the program requires it — seed_basket takes
   * whatever amounts it's handed.
   */
  const [weights, setWeights] = useState<number[]>([]);
  const [budgetUsd, setBudgetUsd] = useState("500");
  /** Live USD per selected asset, keyed by mint. */
  const [assetPrices, setAssetPrices] = useState<Record<string, number>>({});
  const [pricesLoaded, setPricesLoaded] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  /**
   * Buy the underlying as part of launching, instead of requiring the manager
   * to already hold all of it. Jupiter has no devnet, so this is mainnet-only;
   * on devnet practice mode mints the stand-ins straight to the wallet, which
   * removes the same obstacle a different way.
   */
  const [buyForMe, setBuyForMe] = useState(!IS_DEVNET);
  const [slippagePct, setSlippagePct] = useState("1");
  const [zapPlan, setZapPlan] = useState<ZapPlan | null>(null);
  const [zapQuoting, setZapQuoting] = useState(false);
  const [zapProgress, setZapProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [creatingStandIns, setCreatingStandIns] = useState(false);
  const [tokenOptions, setTokenOptions] = useState<TokenOption[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [selectedTokens, setSelectedTokens] = useState<TokenOption[]>([]);

  const [config, setConfig] = useState<Config | null>(null);
  const [coinConfig, setCoinConfig] = useState<CoinConfig | null>(null);
  const [cost, setCost] = useState<CreateCostEstimate | null>(null);
  /** Live USD per $EETF and per SOL, for showing what the fees actually cost. */
  const [prices, setPrices] = useState<{ coin: number | null; sol: number | null }>({
    coin: null,
    sol: null,
  });

  /**
   * Gates the launch button. Nothing here should be a surprise after the fact,
   * so the permanent consequences are spelled out with this basket's own
   * numbers and have to be acknowledged before anything is spent.
   *
   * Stored as the fingerprint of the terms that were on screen when the box was
   * ticked, rather than a bare boolean: changing the fees or the assets
   * afterwards means the acknowledgement was for different terms, so it lapses
   * and has to be given again. Derived on read, which avoids an effect that
   * would have to race the inputs.
   */
  const [ackFor, setAckFor] = useState<string | null>(null);

  const [minting, setMinting] = useState(false);
  const [step, setStep] = useState<null | "creating" | "buying">(null);
  const [done, setDone] = useState<{ id: bigint; signature: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cfg, coin] = await Promise.all([fetchConfig(connection), fetchCoinConfig(connection)]);
      if (cancelled) return;
      setConfig(cfg);
      setCoinConfig(coin);
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  // Only the wallet's own holdings live here — those are the ones that can
  // actually be seeded. Searching the wider token universe is the picker's job.
  const loadTokens = useCallback(async () => {
    if (!publicKey) return [];
    setTokensLoading(true);
    try {
      const options = await fetchWalletTokens(connection, publicKey);
      setTokenOptions(options);
      return options;
    } finally {
      setTokensLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    if (!publicKey) return;
    let cancelled = false;
    (async () => {
      const options = await fetchWalletTokens(connection, publicKey);
      if (!cancelled) setTokenOptions(options);
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey]);

  /**
   * Every pick is checked against the chain before it lands in the basket:
   * it has to exist here, be a token mint, and have no freeze authority —
   * which the program rejects outright. Better to say so now than to let the
   * launch transaction revert at the end.
   */
  async function addAsset(token: TokenOption) {
    setAssetError(null);
    const key = token.mint.toBase58();
    if (assets.some((a) => a.address.toBase58() === key)) return;

    const result = await checkEligibility(connection, token.mint);
    if ("error" in result) {
      // In demo mode a token that simply isn't on this cluster is fine — a
      // stand-in gets created for it. Every other rejection still stands,
      // because the program would reject it on mainnet too.
      if (!(demoMode && IS_DEVNET && result.missing)) {
        setAssetError(`${token.symbol || key.slice(0, 8)}: ${result.error}`);
        return;
      }
      setAssets((prev) => [
        ...prev,
        {
          address: token.mint,
          decimals: token.decimals,
          symbol: token.symbol,
          pendingStandIn: { mainnet: token.mint, name: token.name },
        },
      ]);
      setAmounts((prev) => ({ ...prev, [key]: prev[key] ?? "1000" }));
      setSelectedTokens((prev) => [...prev, token]);
      setWeights(withAssetAdded);
      return;
    }
    const { decimals } = result;
    setAssets((prev) => [...prev, { address: token.mint, decimals, symbol: token.symbol }]);
    setAmounts((prev) => ({ ...prev, [key]: prev[key] ?? "1000" }));
    setSelectedTokens((prev) => [...prev, { ...token, decimals }]);
    setWeights(withAssetAdded);
  }

  /**
   * Weights are positional, so adding or removing a token has to reshape them
   * rather than leave a stale array. A new token joins at the current average
   * and the rest are renormalised, which keeps a deliberate split intact
   * instead of resetting everything to equal on every edit.
   */
  function withAssetAdded(prev: number[]): number[] {
    if (prev.length === 0) return [1];
    const avg = 1 / (prev.length + 1);
    return normalize([...prev.map((w) => w * (1 - avg)), avg]);
  }

  function removeAsset(mint: PublicKey) {
    const key = mint.toBase58();
    const idx = assets.findIndex((a) => a.address.toBase58() === key);
    setAssets((prev) => prev.filter((a) => a.address.toBase58() !== key));
    setSelectedTokens((prev) => prev.filter((t) => t.mint.toBase58() !== key));
    setWeights((prev) => (idx === -1 ? prev : normalize(prev.filter((_, i) => i !== idx))));
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = assets.length === 0 ? null : await estimateCreateCost(connection, assets.length);
      if (!cancelled) setCost(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, assets.length]);

  // Dollar values are a nicety, so a failed or missing price just hides them —
  // $EETF has no market until it trades, and `fetchUsdPrice` returns null then.
  useEffect(() => {
    let cancelled = false;
    if (!coinConfig) return;
    (async () => {
      const [coin, sol] = await Promise.all([
        fetchUsdPrice(coinConfig.mint.toBase58()),
        fetchUsdPrice(WRAPPED_SOL_MINT),
      ]);
      if (!cancelled) setPrices({ coin, sol });
    })();
    return () => {
      cancelled = true;
    };
  }, [coinConfig]);

  // Prices for whatever is currently selected. Devnet test mints have none,
  // which is the case the manual fallback below exists for.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // No early return: an empty list still goes through the await, so this
      // never sets state synchronously inside the effect body.
      // A stand-in has no market of its own; it's priced as the real token it
      // represents. Anything that isn't a stand-in passes through unchanged.
      const lookups = assets.map(
        (a) => a.pendingStandIn?.mainnet.toBase58() ?? resolveForPricing([a.address])[0],
      );
      const byLookup = await fetchUsdPrices(lookups);
      const prices: Record<string, number> = {};
      assets.forEach((a, i) => {
        const p = byLookup[lookups[i]];
        if (p !== undefined) prices[a.address.toBase58()] = p;
      });
      if (!cancelled) {
        setAssetPrices(prices);
        setPricesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assets]);

  const allocatorAssets = assets.map((a) => ({
    key: a.address.toBase58(),
    symbol: a.symbol,
    decimals: a.decimals,
    priceUsd: assetPrices[a.address.toBase58()] ?? null,
  }));
  const { allocations, unpriced } = allocateBudget(
    Number(budgetUsd) || 0,
    allocatorAssets.map((a, i) => ({
      weight: weights[i] ?? 1 / Math.max(assets.length, 1),
      priceUsd: a.priceUsd,
      decimals: a.decimals,
    })),
  );
  /**
   * Budget mode needs a price for every token. Devnet test mints have none, so
   * rather than block the only cluster this runs on, fall back to entering raw
   * amounts — which is what seed_basket takes either way.
   */
  const canUseBudget = pricesLoaded && assets.length > 0 && unpriced.length === 0;
  /** Primitive digest of the deposits, so effects don't see a new array each render. */
  const allocationKey = allocations.map((a) => a?.amount.toString() ?? "-").join(",");
  const allocationError = canUseBudget ? validateAllocation(allocations, unpriced) : null;

  const countOk = assets.length >= MIN_ASSETS && assets.length <= MAX_ASSETS;
  const zapEnabled = buyForMe && !IS_DEVNET && canUseBudget;

  /**
   * Quotes what the initial buy would cost in SOL. Debounced because dragging
   * a slider would otherwise fire a Jupiter round trip per pixel, and aborted
   * on change so a slow quote can't land after a newer one.
   */
  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(async () => {
      // Checked inside the timeout, not in the effect body, so clearing the
      // stale plan never happens synchronously during the effect.
      if (!zapEnabled || !countOk) {
        setZapPlan(null);
        return;
      }
      setZapQuoting(true);
      try {
        const next = await planZapIn({
          inputMint: WRAPPED_SOL_MINT,
          assets: assets.map((a) => a.address),
          // Seeding is the first deposit, so the "vault balances" the deposit
          // maths works against are simply the amounts being deposited.
          vaultBalances: allocations.map((x) => x?.amount ?? 0n),
          supply: INITIAL_SUPPLY_TOKENS * 10n ** BigInt(BASKET_DECIMALS),
          amountOut: INITIAL_SUPPLY_TOKENS * 10n ** BigInt(BASKET_DECIMALS),
          slippageBps: Math.round(Number(slippagePct) * 100) || 100,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setZapPlan(next);
      } catch {
        if (!controller.signal.aborted) setZapPlan(null);
      } finally {
        if (!controller.signal.aborted) setZapQuoting(false);
      }
    }, 600);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
    // `allocationKey` is a primitive digest of `allocations`; depending on the
    // array itself would re-quote every render, since its identity changes
    // each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zapEnabled, countOk, allocationKey, slippagePct, assets]);

  const amountsOk =
    countOk &&
    (canUseBudget
      ? allocationError === null && allocations.every((x) => x !== null && x.amount > 0n)
      : assets.every((a) => Number(amounts[a.address.toBase58()] ?? "0") > 0));
  const solCost =
    (config?.creationFeeLamports ?? 0n) + (cost ? cost.rentLamports + cost.networkFeeLamports : 0n);
  const usd = (lamports: bigint) =>
    prices.sol === null ? null : (Number(lamports) / 1e9) * prices.sol;
  const coinFeeUsd =
    coinConfig && prices.coin !== null ? usdValueOfCoin(coinConfig.creationFeeCoin, prices.coin) : null;
  const money = (v: number) => `$${v < 1 ? v.toFixed(2) : v.toFixed(v < 100 ? 2 : 0)}`;

  // Everything material the disclosure states. Name and symbol are left out on
  // purpose: the fact that they're frozen doesn't change when they're edited,
  // and invalidating on every keystroke would train people to tick past it.
  const termsKey = JSON.stringify([
    config?.protocolShareBps,
    coinConfig?.creationFeeCoin.toString(),
    coinConfig?.creationBurnBps,
    solCost.toString(),
    assets.map((a) => a.address.toBase58()).sort(),
    // Changing the split changes what the basket IS, so a prior
    // acknowledgement was for a different basket.
    canUseBudget ? weights.map((w) => w.toFixed(4)) : null,
    canUseBudget ? budgetUsd : null,
  ]);
  const acknowledged = ackFor === termsKey;

  const pendingStandIns = assets.filter((a) => a.pendingStandIn);

  const canSubmit = Boolean(
    publicKey &&
      name &&
      symbol &&
      amountsOk &&
      config &&
      coinConfig &&
      acknowledged &&
      pendingStandIns.length === 0,
  );


  /**
   * Creates a devnet mint for each real token picked, in one transaction, and
   * swaps the placeholder entries for the mints that now exist. The mapping is
   * persisted so a basket page opened later can still price these.
   */
  async function createStandIns() {
    if (!publicKey) return setError("connect a wallet first");
    setCreatingStandIns(true);
    setError(null);
    try {
      const specs = pendingStandIns.map((a) => ({
        symbol: a.symbol,
        name: a.pendingStandIn!.name,
        decimals: a.decimals,
      }));
      const { instructions, mints } = await createStandInMints(
        connection,
        publicKey,
        publicKey,
        specs,
      );
      const sig = await send(instructions, mints);
      if (!sig) return;

      recordStandIns(
        pendingStandIns.map((a, i) => ({
          standIn: mints[i].publicKey.toBase58(),
          mainnet: a.pendingStandIn!.mainnet.toBase58(),
          symbol: a.symbol,
          name: a.pendingStandIn!.name,
          decimals: a.decimals,
        })),
      );

      const replacement = new Map(
        pendingStandIns.map((a, i) => [a.address.toBase58(), mints[i].publicKey]),
      );
      setAssets((prev) =>
        prev.map((a) => {
          const next = replacement.get(a.address.toBase58());
          return next ? { ...a, address: next, pendingStandIn: undefined } : a;
        }),
      );
      setSelectedTokens((prev) =>
        prev.map((t) => {
          const next = replacement.get(t.mint.toBase58());
          return next ? { ...t, mint: next } : t;
        }),
      );
      await loadTokens();
    } finally {
      setCreatingStandIns(false);
    }
  }

  async function makeTestAssets() {
    if (!publicKey) return setError("connect a wallet first");
    setMinting(true);
    setError(null);
    try {
      const { instructions, mints } = await createAndFundTestMints(connection, publicKey, publicKey, 3);
      const sig = await send(instructions, mints);
      if (sig) {
        // They're in the wallet now, so they show up in the picker — and
        // preselect them, since minting them is a clear signal of intent.
        const options = await loadTokens();
        const minted = new Set(mints.map((m) => m.publicKey.toBase58()));
        for (const option of options.filter((o) => minted.has(o.mint.toBase58()))) {
          await addAsset(option);
        }
      }
    } finally {
      setMinting(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey || !config || !coinConfig) return setError("connect a wallet first");
    setError(null);
    setDone(null);

    try {
      const basketCount = config.basketCount;

      // Two transactions on purpose: create_basket allocates a vault per asset,
      // so bundling the seed into the same transaction risks blowing the
      // account/size limits once a basket has more than a few tokens.
      setStep("creating");
      const { instructions, basket, basketMint } = createBasketTx({
        manager: publicKey,
        treasury: config.treasury,
        devTreasury: coinConfig.devTreasury,
        basketCount,
        assets: assets.map((a) => a.address),
        name,
        symbol,
        uri: "",
        // All three caps are zero in the program: a basket charges nothing, and
        // the launch fee is the only fee in the protocol.
        mintFeeBps: 0,
        redeemFeeBps: 0,
        streamingFeeBps: 0,
      });
      const seedIxs = seedBasketTx({
        manager: publicKey,
        basket,
        basketMint,
        assets: assets.map((a) => a.address),
        initialSupply: INITIAL_SUPPLY_TOKENS * 10n ** BigInt(BASKET_DECIMALS),
        amounts: assets.map((a, i) =>
          canUseBudget
            ? allocations[i]!.amount
            : parseToBaseUnits(amounts[a.address.toBase58()] ?? "0", a.decimals),
        ),
      });

      // --- buy-as-you-launch ------------------------------------------------
      if (zapEnabled && zapPlan) {
        if (!signAllTransactions) {
          setStep(null);
          return setError("This wallet can't sign a batch, so the tokens have to be bought first.");
        }
        const steps = await buildZapLaunch({
          connection,
          user: publicKey,
          plan: zapPlan,
          symbols: assets.map((a) => a.symbol),
          createIxs: new Transaction().add(...instructions),
          seedIxs: new Transaction().add(...seedIxs),
        });

        // One prompt for the whole launch rather than one per leg.
        const signed = await signAllTransactions(steps.map((st) => st.transaction));
        const result = await sendZapLaunch(connection, signed, steps, (p) =>
          setZapProgress({ done: p.signature ? p.index + 1 : p.index, total: p.total, label: p.step.label }),
        );
        setZapProgress(null);
        setStep(null);

        if ("failedAt" in result) {
          const failed = steps[result.failedAt];
          const landed = result.signatures.length;
          return setError(
            `Stopped at "${failed.label}" (step ${result.failedAt + 1} of ${steps.length}). ` +
              (failed.kind === "swap"
                ? `${landed} step${landed === 1 ? "" : "s"} already went through, so you now hold part of the basket's tokens — nothing was created and no $EETF was burned. Try again, or raise the slippage.`
                : `The tokens were bought${failed.kind === "seed" ? " and the basket was created — seed it from its page" : ""}.`) +
              ` ${describeError(result.error)}`,
          );
        }
        return setDone({ id: basketCount, signature: result.signatures[result.signatures.length - 1] });
      }

      // --- manager already holds the tokens ---------------------------------
      const createSig = await send(instructions);
      if (!createSig) return setStep(null);

      setStep("buying");
      const seedSig = await send(seedIxs);
      setStep(null);
      if (seedSig) setDone({ id: basketCount, signature: seedSig });
    } catch (e) {
      setStep(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Launch a basket</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Pick {MIN_ASSETS}–{MAX_ASSETS} tokens, make the first deposit, and you hold 100% of the new
          basket token. Anyone can then mint more by depositing the same tokens, or redeem for their
          share of what it holds.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-5">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                placeholder="Frog Basket"
                required
              />
            </Field>
            <Field label="Symbol">
              <TextInput
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                maxLength={10}
                placeholder="FROG"
                required
              />
            </Field>
          </div>
        </Card>

        <Card className="space-y-3">
          <Field
            label="Tokens in the basket"
            hint={`Search by ticker or name. ${MIN_ASSETS}–${MAX_ASSETS} tokens; you set the split next.`}
          >
            <TokenPicker
              walletTokens={tokenOptions}
              selected={selectedTokens}
              cluster={clusterOf(DEFAULT_RPC_URL)}
              loading={tokensLoading}
              onAdd={addAsset}
              onRemove={removeAsset}
              max={MAX_ASSETS}
              demoMode={IS_DEVNET && demoMode}
            />
          </Field>
          {IS_DEVNET && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm">
              <input
                type="checkbox"
                checked={demoMode}
                onChange={(e) => setDemoMode(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span>
                <strong className="font-medium">Practice with real tokens</strong>
                <span className="block text-xs text-muted">
                  Pick any token the search finds and a devnet stand-in is created for it, with the
                  same symbol, decimals and live price. Everything after this — the split, the
                  costs, the launch — is the real flow, on devnet.
                </span>
              </span>
            </label>
          )}

          {pendingStandIns.length > 0 && (
            <Banner kind="info">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {pendingStandIns.length} token{pendingStandIns.length === 1 ? "" : "s"} need
                  {pendingStandIns.length === 1 ? "s" : ""} a devnet stand-in before you can launch:{" "}
                  <strong>{pendingStandIns.map((a) => a.symbol).join(", ")}</strong>
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={createStandIns}
                  disabled={creatingStandIns || pending || !publicKey}
                >
                  {creatingStandIns
                    ? "Creating…"
                    : `Create ${pendingStandIns.length} stand-in${pendingStandIns.length === 1 ? "" : "s"}`}
                </Button>
              </div>
            </Banner>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" onClick={makeTestAssets} disabled={minting || pending}>
              {minting ? "Minting…" : "Mint 3 test tokens to my wallet"}
            </Button>
            {assets.length > 0 && (
              <Pill tone={countOk ? "accent" : "warn"}>
                {assets.length} token{assets.length === 1 ? "" : "s"}
                {countOk ? "" : ` — need ${MIN_ASSETS}–${MAX_ASSETS}`}
              </Pill>
            )}
          </div>
          {assetError && <Banner kind="error">{assetError}</Banner>}
        </Card>

        {countOk && (
          <Card className="space-y-4">
            <div>
              <h2 className="font-semibold">Initial buy</h2>
              <p className="mt-1 text-sm text-muted">
                What goes into the basket on day one, and in what proportions. You choose the
                split — equal is just the starting point.
              </p>
            </div>

            {canUseBudget ? (
              <>
                <WeightAllocator
                  assets={allocatorAssets}
                  weights={weights}
                  budgetUsd={budgetUsd}
                  allocations={allocations}
                  onWeightsChange={setWeights}
                  onBudgetChange={setBudgetUsd}
                />
                {allocationError && <Banner kind="warn">{allocationError}</Banner>}
              </>
            ) : (
              <div className="space-y-3">
                {pricesLoaded && assets.length > 0 && (
                  <Banner kind="info">
                    {unpriced.length} of these tokens {unpriced.length === 1 ? "has" : "have"} no
                    price, so the budget split can&apos;t size them — enter the amounts directly
                    instead. Normal on devnet, where test tokens have no market.
                  </Banner>
                )}
                {assets.map((a) => {
                  const key = a.address.toBase58();
                  return (
                    <div key={key} className="flex items-center gap-3">
                      <div className="w-28 shrink-0">
                        <div className="text-sm font-medium">{a.symbol}</div>
                        <code className="text-xs text-muted">{shortAddress(key, 4)}</code>
                      </div>
                      <TextInput
                        value={amounts[key] ?? ""}
                        onChange={(e) => setAmounts((p) => ({ ...p, [key]: e.target.value }))}
                        inputMode="decimal"
                      />
                    </div>
                  );
                })}
              </div>
            )}
            {!IS_DEVNET && canUseBudget && (
              <div className="space-y-3 rounded-lg border border-border bg-surface-2 px-4 py-3">
                <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={buyForMe}
                    onChange={(e) => setBuyForMe(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span>
                    <strong className="font-medium">Buy the tokens for me</strong>
                    <span className="block text-xs text-muted">
                      Pays in SOL and swaps into each token at the split above, then creates and
                      seeds the basket — all signed in one go. Leave this off if you already hold
                      everything.
                    </span>
                  </span>
                </label>

                {buyForMe && (
                  <>
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="w-32">
                        <Field label="Slippage tolerance (%)" hint="per swap">
                          <TextInput
                            value={slippagePct}
                            onChange={(e) => setSlippagePct(e.target.value)}
                            inputMode="decimal"
                          />
                        </Field>
                      </div>
                      {zapQuoting && <span className="pb-2 text-xs text-muted">Quoting…</span>}
                    </div>

                    {zapPlan && zapPlan.unroutable.length === 0 && (
                      <dl className="space-y-1 text-sm">
                        <div className="flex justify-between">
                          <dt className="text-muted">Cost of the tokens</dt>
                          <dd className="tabular-nums">
                            {formatTokens(zapPlan.totalIn, 9, 5)} SOL
                            {usd(zapPlan.totalIn) !== null && (
                              <span className="text-muted"> ≈ {money(usd(zapPlan.totalIn)!)}</span>
                            )}
                          </dd>
                        </div>
                        <div className="flex justify-between text-xs text-muted">
                          <dt>Worst case at {slippagePct}% slippage</dt>
                          <dd className="tabular-nums">
                            {formatTokens(zapPlan.worstTotalIn, 9, 5)} SOL
                          </dd>
                        </div>
                        <div className="flex justify-between text-xs text-muted">
                          <dt>Largest price impact</dt>
                          <dd className="tabular-nums">
                            {(zapPlan.worstPriceImpact * 100).toFixed(2)}%
                          </dd>
                        </div>
                      </dl>
                    )}

                    {zapPlan && zapPlan.unroutable.length > 0 && (
                      <Banner kind="warn">
                        No swap route for {zapPlan.unroutable.length} token
                        {zapPlan.unroutable.length === 1 ? "" : "s"}. Remove{" "}
                        {zapPlan.unroutable.length === 1 ? "it" : "them"}, or buy{" "}
                        {zapPlan.unroutable.length === 1 ? "it" : "them"} yourself and turn this off.
                      </Banner>
                    )}

                    <p className="text-xs text-muted">
                      {(zapPlan?.legs.filter((l) => l.quote).length ?? assets.length) + 2} transactions,
                      one signature: a swap per token, then create, then seed. If a swap fails you
                      keep whatever was bought and nothing is created.
                    </p>
                  </>
                )}
              </div>
            )}

            <div className="rounded-lg bg-accent-soft px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-wide text-accent">You receive</div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-accent">
                {formatTokens(INITIAL_SUPPLY_TOKENS * 10n ** BigInt(BASKET_DECIMALS), BASKET_DECIMALS)}{" "}
                {symbol || "tokens"}
              </div>
              <div className="mt-0.5 text-xs text-accent">
                100% of the basket — nobody else holds any until someone mints.
              </div>
            </div>
          </Card>
        )}

        {countOk && config && coinConfig && (
          <Card className="space-y-4">
            <h2 className="font-semibold">Total cost</h2>

            <dl className="space-y-2 text-sm">
              <CostRow label="Your deposit">
                <div className="text-right">
                  {assets.map((a, i) => (
                    <div key={a.address.toBase58()} className="tabular-nums">
                      {canUseBudget && allocations[i]
                        ? formatTokens(allocations[i]!.amount, a.decimals)
                        : amounts[a.address.toBase58()] || "0"}{" "}
                      <span className="text-muted">{a.symbol}</span>
                      {canUseBudget && allocations[i] && (
                        <span className="text-muted">
                          {" "}
                          · {(allocations[i]!.effectiveWeight * 100).toFixed(1)}%
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </CostRow>

              <CostRow label="Launch fee">
                <span className="tabular-nums">
                  {formatTokens(coinConfig.creationFeeCoin, COIN_DECIMALS)} EETF
                  {coinFeeUsd !== null && (
                    <span className="text-muted"> ≈ {money(coinFeeUsd)}</span>
                  )}
                </span>
              </CostRow>
              <div className="pl-4 text-xs text-burn">
                {formatBps(coinConfig.creationBurnBps)} of that is burned forever
              </div>
              <div className="pl-4 text-xs text-muted">
                Targets {money(CREATION_FEE_USD_TARGET)} a launch, re-quoted in EETF as the price
                moves.
              </div>

              {config.creationFeeLamports > 0n && (
                <CostRow label="Protocol fee">
                  <span className="tabular-nums">{formatTokens(config.creationFeeLamports, 9, 4)} SOL</span>
                </CostRow>
              )}

              {cost && (
                <CostRow label="Account rent + network fees">
                  <span className="tabular-nums">
                    ~{formatTokens(cost.rentLamports + cost.networkFeeLamports, 9, 4)} SOL
                  </span>
                </CostRow>
              )}

              <div className="border-t border-border pt-3">
                <CostRow label={<span className="font-semibold text-foreground">Total</span>}>
                  <div className="text-right font-semibold tabular-nums">
                    <div>
                      ~{formatTokens(solCost, 9, 4)} SOL
                      {usd(solCost) !== null && (
                        <span className="font-normal text-muted"> ≈ {money(usd(solCost)!)}</span>
                      )}
                    </div>
                    <div>
                      {formatTokens(coinConfig.creationFeeCoin, COIN_DECIMALS)} EETF
                      {coinFeeUsd !== null && (
                        <span className="font-normal text-muted"> ≈ {money(coinFeeUsd)}</span>
                      )}
                    </div>
                    <div className="font-normal text-muted">+ your deposit above</div>
                  </div>
                </CostRow>
              </div>
            </dl>

            <div className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm">
              <strong className="font-medium">This basket charges no fees.</strong>{" "}
              <span className="text-muted">
                Nothing to mint, nothing to redeem, nothing per year — and no authority can turn
                any of them on later, because all three caps are zero in the program itself. Your
                return is the basket going up: you hold 100% of its starting supply, the same as
                any other holder.{" "}
                <Link
                  href="/terms"
                  target="_blank"
                  className="text-accent underline decoration-dotted underline-offset-2"
                >
                  How this works
                </Link>
              </span>
            </div>
          </Card>
        )}

        {countOk && config && coinConfig && !done && (
          <Card className="space-y-4">
            <div>
              <h2 className="font-semibold">Before you launch</h2>
              <p className="mt-1 text-sm text-muted">
                All of this is permanent. Read it now rather than discovering it afterwards —{" "}
                <Link
                  href="/terms"
                  target="_blank"
                  className="text-accent underline decoration-dotted underline-offset-2"
                >
                  the full terms and fee arithmetic
                </Link>{" "}
                explain how every number is calculated.
              </p>
            </div>

            <ul className="space-y-2.5 text-sm">
              {[
                [
                  "There are no ongoing fees, for anyone",
                  <>
                    {symbol || "This basket"} charges nothing to mint, nothing to redeem and nothing
                    per year, and nobody can switch that on later. You earn if the basket
                    appreciates — you&apos;ll hold 100% of its starting supply — not from fees.
                  </>,
                ],
                [
                  "These coins are the coins, forever",
                  <>
                    All {assets.length} of them, in the split you set above. Nothing can be added,
                    removed or swapped, and the basket never rebalances — so those weights drift
                    with price from the first trade onward.
                  </>,
                ],
                [
                  "The name and symbol are frozen",
                  <>
                    &ldquo;{name || "Your basket"}&rdquo; ({symbol || "SYMBOL"}) is written as
                    immutable metadata and can&apos;t be edited.
                  </>,
                ],
                [
                  "You are paying now, in two transactions",
                  <>
                    {formatTokens(coinConfig.creationFeeCoin, COIN_DECIMALS)} EETF
                    {coinFeeUsd !== null && <> (≈{money(coinFeeUsd)})</>}, of which{" "}
                    {formatBps(coinConfig.creationBurnBps)} is burned forever, plus ~
                    {formatTokens(solCost, 9, 4)} SOL
                    {usd(solCost) !== null && <> (≈{money(usd(solCost)!)})</>} — and your deposit
                    above. Most of the SOL is refundable account rent, not a fee.
                  </>,
                ],
                [
                  "Nobody is managing this and it can lose everything",
                  <>
                    There is no strategy and no active management. Pre-audit software; basket tokens
                    built on memecoins can lose most or all of their value.
                  </>,
                ],
              ].map(([title, body], i) => (
                <li key={i} className="flex gap-3">
                  <span
                    aria-hidden
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  />
                  <span>
                    <strong className="font-medium">{title}.</strong>{" "}
                    <span className="text-muted">{body}</span>
                  </span>
                </li>
              ))}
            </ul>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAckFor(e.target.checked ? termsKey : null)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span>
                I&apos;ve read the above and the{" "}
                <Link
                  href="/terms"
                  target="_blank"
                  className="text-accent underline decoration-dotted underline-offset-2"
                >
                  terms
                </Link>
                , and I understand these choices are permanent.
              </span>
            </label>
          </Card>
        )}

        {zapProgress && (
          <Banner kind="info">
            Step {zapProgress.done + 1} of {zapProgress.total} — {zapProgress.label}. Keep this tab
            open until it finishes.
          </Banner>
        )}

        {error && <Banner kind="error">{error}</Banner>}

        {done && (
          <Banner kind="success">
            <strong>{symbol} is live.</strong>{" "}
            <button type="button" className="underline" onClick={() => router.push(`/baskets/${done.id}`)}>
              Open basket #{done.id.toString()}
            </button>{" "}
            ·{" "}
            <a className="underline" href={explorerTxUrl(done.signature)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          </Banner>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!canSubmit || pending || step !== null}>
            {step === "creating"
              ? "1 of 2 — creating basket…"
              : step === "buying"
                ? "2 of 2 — making your initial buy…"
                : !publicKey
                  ? "Connect a wallet"
                  : !acknowledged && countOk && amountsOk && name && symbol
                    ? "Confirm you've read the terms"
                    : zapEnabled && buyForMe
                      ? "Buy tokens & launch"
                      : "Launch & buy"}
          </Button>
          {step !== null && <span className="text-xs text-muted">Two transactions — approve both.</span>}
        </div>
      </form>
    </div>
  );
}

function CostRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
