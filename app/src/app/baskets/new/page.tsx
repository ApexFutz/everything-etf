"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Banner, Button, Card, Field, TextArea, TextInput } from "@/components/ui";
import { createBasketTx, fetchCoinConfig, fetchConfig } from "@/lib/etf/client";
import { createAndFundTestMints } from "@/lib/etf/devHelpers";
import { MAX_ASSETS, MAX_MINT_FEE_BPS, MAX_REDEEM_FEE_BPS, MAX_STREAMING_FEE_BPS, MIN_ASSETS } from "@/lib/etf/constants";
import { useSendTx } from "@/hooks/useSendTx";
import { PublicKey } from "@solana/web3.js";
import { explorerTxUrl } from "@/lib/format";

export default function NewBasketPage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const router = useRouter();
  const { send, pending, error, signature, setError } = useSendTx();

  const [name, setName] = useState("Equal Weight Three");
  const [symbol, setSymbol] = useState("EW3");
  const [uri, setUri] = useState("https://example.com/basket.json");
  const [mintFeeBps, setMintFeeBps] = useState("50");
  const [redeemFeeBps, setRedeemFeeBps] = useState("50");
  const [streamingFeeBps, setStreamingFeeBps] = useState("200");
  const [assetsText, setAssetsText] = useState("");
  const [minting, setMinting] = useState(false);
  const [createdBasketId, setCreatedBasketId] = useState<bigint | null>(null);

  const assetLines = assetsText
    .split(/\s|,/)
    .map((s) => s.trim())
    .filter(Boolean);

  async function makeTestAssets() {
    if (!publicKey) return setError("connect a wallet first");
    setMinting(true);
    setError(null);
    try {
      const { instructions, mints } = await createAndFundTestMints(connection, publicKey, publicKey, 3);
      const sig = await send(instructions, mints);
      if (sig) {
        setAssetsText(mints.map((m) => m.publicKey.toBase58()).join("\n"));
      }
    } finally {
      setMinting(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) return setError("connect a wallet first");
    setError(null);
    setCreatedBasketId(null);
    try {
      let assets: PublicKey[];
      try {
        assets = assetLines.map((a) => new PublicKey(a));
      } catch {
        return setError("one of the asset addresses isn't a valid pubkey");
      }
      if (assets.length < MIN_ASSETS || assets.length > MAX_ASSETS) {
        return setError(`a basket needs between ${MIN_ASSETS} and ${MAX_ASSETS} assets (got ${assets.length})`);
      }

      const [config, coinConfig] = await Promise.all([fetchConfig(connection), fetchCoinConfig(connection)]);
      if (!config || !coinConfig) {
        return setError("protocol isn't initialized on this cluster yet — see Admin");
      }

      const { instructions } = createBasketTx({
        manager: publicKey,
        treasury: config.treasury,
        devTreasury: coinConfig.devTreasury,
        basketCount: config.basketCount,
        assets,
        name,
        symbol,
        uri,
        mintFeeBps: Number(mintFeeBps),
        redeemFeeBps: Number(redeemFeeBps),
        streamingFeeBps: Number(streamingFeeBps),
      });
      const sig = await send(instructions);
      if (sig) setCreatedBasketId(config.basketCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 px-6 py-10">
      <h1 className="text-xl font-semibold">Create a basket</h1>
      <p className="text-sm text-muted">
        Burns the $EETF creation fee from your wallet, then launches an equal-weight basket over
        the assets you list below (2–{MAX_ASSETS}).
      </p>

      <Card>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required />
            </Field>
            <Field label="Symbol">
              <TextInput value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={10} required />
            </Field>
          </div>
          <Field label="Metadata URI" hint="Points at this basket's off-chain JSON (name/image/holdings page).">
            <TextInput value={uri} onChange={(e) => setUri(e.target.value)} maxLength={200} required />
          </Field>

          <div className="grid grid-cols-3 gap-4">
            <Field label="Mint fee (bps)" hint={`max ${MAX_MINT_FEE_BPS}`}>
              <TextInput
                type="number"
                min={0}
                max={MAX_MINT_FEE_BPS}
                value={mintFeeBps}
                onChange={(e) => setMintFeeBps(e.target.value)}
              />
            </Field>
            <Field label="Redeem fee (bps)" hint={`max ${MAX_REDEEM_FEE_BPS}`}>
              <TextInput
                type="number"
                min={0}
                max={MAX_REDEEM_FEE_BPS}
                value={redeemFeeBps}
                onChange={(e) => setRedeemFeeBps(e.target.value)}
              />
            </Field>
            <Field label="Streaming fee (bps/yr)" hint={`max ${MAX_STREAMING_FEE_BPS}`}>
              <TextInput
                type="number"
                min={0}
                max={MAX_STREAMING_FEE_BPS}
                value={streamingFeeBps}
                onChange={(e) => setStreamingFeeBps(e.target.value)}
              />
            </Field>
          </div>

          <Field
            label={`Asset mints (${assetLines.length})`}
            hint="One SPL/Token-2022 mint address per line (or comma-separated). No freeze authority allowed."
          >
            <TextArea
              value={assetsText}
              onChange={(e) => setAssetsText(e.target.value)}
              rows={5}
              placeholder="So11111111111111111111111111111111111111112&#10;..."
            />
          </Field>
          <Button type="button" variant="secondary" onClick={makeTestAssets} disabled={minting || pending}>
            {minting ? "Minting test tokens…" : "Dev helper: mint 3 fresh test tokens to my wallet"}
          </Button>

          {error && <Banner kind="error">{error}</Banner>}
          {signature && createdBasketId === null && (
            <Banner kind="success">
              Sent.{" "}
              <a className="underline" href={explorerTxUrl(signature)} target="_blank" rel="noreferrer">
                View transaction
              </a>
            </Banner>
          )}
          {createdBasketId !== null && (
            <Banner kind="success">
              Basket #{createdBasketId.toString()} created.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => router.push(`/baskets/${createdBasketId}`)}
              >
                Go seed it
              </button>
            </Banner>
          )}

          <Button type="submit" disabled={pending || !publicKey}>
            {pending ? "Sending…" : "Create basket"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
