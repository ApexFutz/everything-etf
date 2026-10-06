"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Card, Field, Pill, TextInput } from "@/components/ui";
import { TokenPicker } from "@/components/TokenPicker";
import { createBasketTx, fetchCoinConfig, fetchConfig, seedBasketTx } from "@/lib/etf/client";
import { estimateCreateCost, CreateCostEstimate } from "@/lib/etf/costs";
import {
  CREATION_FEE_USD_TARGET,
  fetchUsdPrice,
  usdValueOfCoin,
  WRAPPED_SOL_MINT,
} from "@/lib/etf/pricing";
import { createAndFundTestMints } from "@/lib/etf/devHelpers";
import {
  BASKET_DECIMALS,
  COIN_DECIMALS,
  MAX_ASSETS,
  MAX_MINT_FEE_BPS,
  MAX_STREAMING_FEE_BPS,
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

type Asset = { address: PublicKey; decimals: number; symbol: string };

export default function NewBasketPage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const router = useRouter();
  const { send, pending, error, setError } = useSendTx();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
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

  const [showFees, setShowFees] = useState(false);
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
  const [mintFeePct, setMintFeePct] = useState("0.25");
  const [streamingFeePct, setStreamingFeePct] = useState("0.5");

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
      setAssetError(`${token.symbol || key.slice(0, 8)}: ${result.error}`);
      return;
    }
    const { decimals } = result;
    setAssets((prev) => [...prev, { address: token.mint, decimals, symbol: token.symbol }]);
    setAmounts((prev) => ({ ...prev, [key]: prev[key] ?? "1000" }));
    setSelectedTokens((prev) => [...prev, { ...token, decimals }]);
  }

  function removeAsset(mint: PublicKey) {
    const key = mint.toBase58();
    setAssets((prev) => prev.filter((a) => a.address.toBase58() !== key));
    setSelectedTokens((prev) => prev.filter((t) => t.mint.toBase58() !== key));
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

  const countOk = assets.length >= MIN_ASSETS && assets.length <= MAX_ASSETS;
  const amountsOk = countOk && assets.every((a) => Number(amounts[a.address.toBase58()] ?? "0") > 0);
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
    mintFeePct,
    streamingFeePct,
    config?.protocolShareBps,
    coinConfig?.creationFeeCoin.toString(),
    coinConfig?.creationBurnBps,
    solCost.toString(),
    assets.map((a) => a.address.toBase58()).sort(),
  ]);
  const acknowledged = ackFor === termsKey;

  const canSubmit = Boolean(
    publicKey && name && symbol && amountsOk && config && coinConfig && acknowledged,
  );

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
      const pct = (v: string) => Math.round(Number(v) * 100); // percent -> bps
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
        mintFeeBps: pct(mintFeePct),
        // Always zero — redemption is free, and the program caps it at zero.
        redeemFeeBps: 0,
        streamingFeeBps: pct(streamingFeePct),
      });
      const createSig = await send(instructions);
      if (!createSig) return setStep(null);

      setStep("buying");
      const seedSig = await send(
        seedBasketTx({
          manager: publicKey,
          basket,
          basketMint,
          assets: assets.map((a) => a.address),
          initialSupply: INITIAL_SUPPLY_TOKENS * 10n ** BigInt(BASKET_DECIMALS),
          amounts: assets.map((a) =>
            parseToBaseUnits(amounts[a.address.toBase58()] ?? "0", a.decimals),
          ),
        }),
      );
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
            hint={`Search by ticker or name. ${MIN_ASSETS}–${MAX_ASSETS} tokens, each an equal 1/N share.`}
          >
            <TokenPicker
              walletTokens={tokenOptions}
              selected={selectedTokens}
              cluster={clusterOf(DEFAULT_RPC_URL)}
              loading={tokensLoading}
              onAdd={addAsset}
              onRemove={removeAsset}
              max={MAX_ASSETS}
            />
          </Field>
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
                How much of each token you&apos;re putting in — this is what backs the basket on day
                one. Equal weight means these should be worth roughly the same as each other.
              </p>
            </div>
            <div className="space-y-2">
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
                  {assets.map((a) => (
                    <div key={a.address.toBase58()} className="tabular-nums">
                      {amounts[a.address.toBase58()] || "0"}{" "}
                      <span className="text-muted">{a.symbol}</span>
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  Fees you&apos;ll charge: <strong className="tabular-nums">{mintFeePct}%</strong> to
                  mint · <strong className="tabular-nums">{streamingFeePct}%</strong> a year ·
                  nothing to redeem
                </span>
                <button
                  type="button"
                  onClick={() => setShowFees((v) => !v)}
                  className="text-xs text-accent underline decoration-dotted underline-offset-2"
                >
                  {showFees ? "Hide" : "Change"}
                </button>
              </div>

              {showFees && (
                <div className="mt-4 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="To mint %" hint={`max ${formatBps(MAX_MINT_FEE_BPS)}`}>
                      <TextInput
                        value={mintFeePct}
                        onChange={(e) => setMintFeePct(e.target.value)}
                        inputMode="decimal"
                      />
                    </Field>
                    <Field label="Per year %" hint={`max ${formatBps(MAX_STREAMING_FEE_BPS)}`}>
                      <TextInput
                        value={streamingFeePct}
                        onChange={(e) => setStreamingFeePct(e.target.value)}
                        inputMode="decimal"
                      />
                    </Field>
                  </div>
                  <Banner kind="warn">
                    You can lower these later but never raise them — what you set now is a permanent
                    ceiling. The mint fee is paid by people buying in; the yearly fee is charged to
                    everyone holding, by slowly minting new basket tokens to you. You keep{" "}
                    {formatBps(10_000 - config.protocolShareBps)} of both and the protocol takes{" "}
                    {formatBps(config.protocolShareBps)}.
                  </Banner>
                  <p className="text-xs text-muted">
                    Redeeming is always free and can&apos;t be changed. Buying and selling at the
                    basket&apos;s true value is what keeps its price tracking the coins inside it, so
                    the protocol doesn&apos;t let anyone tax the way out.
                  </p>
                </div>
              )}
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
                  "Your fees can only go down",
                  <>
                    You are setting <strong>{mintFeePct}%</strong> to mint and{" "}
                    <strong>{streamingFeePct}%</strong> a year. You can lower these later but never
                    raise them, so this is the most {symbol || "this basket"} will ever charge.
                    Redeeming stays free and can&apos;t be switched on.
                  </>,
                ],
                [
                  "The protocol takes its share, locked in now",
                  <>
                    <strong>{formatBps(config.protocolShareBps)}</strong> of every fee goes to the
                    protocol and you keep {formatBps(10_000 - config.protocolShareBps)}. This basket
                    keeps that split for life — later protocol changes never touch it.
                  </>,
                ],
                [
                  "These coins are the coins, forever",
                  <>
                    All {assets.length} of them, at equal weight. Nothing can be added, removed or
                    swapped, and the basket never rebalances — weights drift with price from here.
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
