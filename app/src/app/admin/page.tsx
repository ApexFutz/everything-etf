"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import {
  crankBurnTx,
  fetchCoinConfig,
  fetchConfig,
  fetchUpgradeAuthority,
  initializeCoinTx,
  initializeConfigTx,
  updateCoinTermsTx,
  updateProtocolTermsTx,
} from "@/lib/etf/client";
import { Config, CoinConfig } from "@/lib/etf/accounts";
import { COIN_DECIMALS, MAX_PROTOCOL_SHARE_BPS, MIN_CREATION_BURN_BPS } from "@/lib/etf/constants";
import { formatBaseUnits, parseToBaseUnits, explorerTxUrl } from "@/lib/format";
import { AddressLink, Banner, Button, Card, Field, TextInput } from "@/components/ui";
import { useSendTx } from "@/hooks/useSendTx";

export default function AdminPage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { send, pending, error, signature, setError } = useSendTx();

  const [config, setConfig] = useState<Config | null>(null);
  const [coinConfig, setCoinConfig] = useState<CoinConfig | null>(null);
  const [burnVaultBalance, setBurnVaultBalance] = useState<bigint | null>(null);
  const [upgradeAuthority, setUpgradeAuthority] = useState<PublicKey | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    const [cfg, coin, upgrade] = await Promise.all([
      fetchConfig(connection),
      fetchCoinConfig(connection),
      fetchUpgradeAuthority(connection),
    ]);
    setConfig(cfg);
    setCoinConfig(coin);
    setUpgradeAuthority(upgrade);
    if (coin) {
      const info = await connection.getAccountInfo(coin.burnVault);
      // Raw SPL token account layout: amount is a u64 at byte offset 64.
      setBurnVaultBalance(info ? info.data.readBigUInt64LE(64) : 0n);
    }
  }, [connection]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount; refresh() is also reused as a manual post-tx reload.
    refresh();
  }, [refresh]);

  async function after(sig: string | null) {
    if (sig) await refresh();
  }

  const isAuthority = (config && publicKey?.equals(config.authority)) ?? false;

  return (
    <div className="mx-auto max-w-xl space-y-6 px-6 py-10">
      <h1 className="text-xl font-semibold">Admin</h1>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-muted">
          Program upgrade authority
        </h2>
        <p className="text-sm">
          {upgradeAuthority === undefined ? (
            <span className="text-muted">No program deployed at this address.</span>
          ) : upgradeAuthority === null ? (
            <span>
              <strong>Immutable</strong> — the upgrade authority has been revoked, so the deployed
              rules can never be changed.
            </span>
          ) : (
            <AddressLink address={upgradeAuthority.toBase58()} chars={8} />
          )}
        </p>
        {upgradeAuthority && (
          <p className="mt-2 text-xs text-muted">
            Whoever holds this key can replace the program, and with it every rule below — fee caps
            included. Check it before trusting any basket on this deployment.
          </p>
        )}
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

      {!config ? (
        <InitializeConfigForm pending={pending} send={send} onDone={after} setError={setError} />
      ) : (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-muted">Config</h2>
          <dl className="space-y-1 text-sm">
            <Row k="Authority" v={<AddressLink address={config.authority.toBase58()} />} />
            <Row k="Treasury" v={<AddressLink address={config.treasury.toBase58()} />} />
            <Row k="Creation fee" v={`${formatBaseUnits(config.creationFeeLamports, 9)} SOL`} />
            <Row k="Protocol share" v={`${config.protocolShareBps} bps`} />
            <Row k="Baskets created" v={config.basketCount.toString()} />
          </dl>
        </Card>
      )}

      {config && isAuthority && (
        <UpdateProtocolTermsForm config={config} pending={pending} send={send} onDone={after} setError={setError} />
      )}

      {config && !coinConfig && isAuthority && (
        <InitializeCoinForm authority={config.authority} pending={pending} send={send} onDone={after} setError={setError} />
      )}
      {config && !coinConfig && !isAuthority && (
        <Banner kind="info">$EETF hasn&apos;t been initialized yet. Connect as the protocol authority to do it.</Banner>
      )}

      {coinConfig && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-muted">$EETF</h2>
          <dl className="space-y-1 text-sm">
            <Row k="Mint" v={<AddressLink address={coinConfig.mint.toBase58()} />} />
            <Row k="Dev treasury" v={<AddressLink address={coinConfig.devTreasury.toBase58()} />} />
            <Row
              k="Creation fee"
              v={`${formatBaseUnits(coinConfig.creationFeeCoin, COIN_DECIMALS)} EETF`}
            />
            <Row k="Burn share" v={`${coinConfig.creationBurnBps} bps`} />
            <Row k="Lifetime burned" v={formatBaseUnits(coinConfig.totalBurned, COIN_DECIMALS)} />
            <Row
              k="Burn vault balance"
              v={burnVaultBalance !== null ? formatBaseUnits(burnVaultBalance, COIN_DECIMALS) : "…"}
            />
          </dl>
          <div className="mt-4">
            <Button
              variant="secondary"
              disabled={pending || !publicKey || !burnVaultBalance}
              onClick={async () => publicKey && after(await send(crankBurnTx({ cranker: publicKey })))}
            >
              Crank burn (permissionless)
            </Button>
          </div>
        </Card>
      )}

      {coinConfig && isAuthority && (
        <UpdateCoinTermsForm coinConfig={coinConfig} pending={pending} send={send} onDone={after} setError={setError} />
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

type SendFn = ReturnType<typeof useSendTx>["send"];
type Common = {
  pending: boolean;
  send: SendFn;
  onDone: (sig: string | null) => void;
  setError: (e: string | null) => void;
};

function InitializeConfigForm({ pending, send, onDone, setError }: Common) {
  const { publicKey } = useWallet();
  const [treasury, setTreasury] = useState("");
  const [creationFeeSol, setCreationFeeSol] = useState("0.25");
  const [protocolShareBps, setProtocolShareBps] = useState("1000");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) return setError("connect a wallet first");
    try {
      const treasuryPk = new PublicKey(treasury || publicKey);
      const ixs = initializeConfigTx({
        authority: publicKey,
        treasury: treasuryPk,
        creationFeeLamports: parseToBaseUnits(creationFeeSol, 9),
        protocolShareBps: Number(protocolShareBps),
      });
      onDone(await send(ixs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-muted">
        initialize_config <span className="font-normal">(one-time — program upgrade authority only)</span>
      </h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Treasury" hint="Defaults to your connected wallet if left blank.">
          <TextInput value={treasury} onChange={(e) => setTreasury(e.target.value)} placeholder={publicKey?.toBase58()} />
        </Field>
        <Field label="Creation fee (SOL)">
          <TextInput value={creationFeeSol} onChange={(e) => setCreationFeeSol(e.target.value)} />
        </Field>
        <Field label="Protocol fee share (bps)" hint={`max ${MAX_PROTOCOL_SHARE_BPS}`}>
          <TextInput
            value={protocolShareBps}
            onChange={(e) => setProtocolShareBps(e.target.value)}
            max={MAX_PROTOCOL_SHARE_BPS}
          />
        </Field>
        <Button type="submit" disabled={pending || !publicKey}>
          {pending ? "Sending…" : "Initialize config"}
        </Button>
      </form>
    </Card>
  );
}

function InitializeCoinForm({ authority, pending, send, onDone, setError }: Common & { authority: PublicKey }) {
  const { publicKey } = useWallet();
  const [name, setName] = useState("Everything ETF");
  const [symbol, setSymbol] = useState("EETF");
  const [uri, setUri] = useState("https://example.com/eetf.json");
  const [genesisOwner, setGenesisOwner] = useState("");
  const [devTreasury, setDevTreasury] = useState("");
  const [creationFeeCoin, setCreationFeeCoin] = useState("100000");
  const [creationBurnBps, setCreationBurnBps] = useState("7000");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) return setError("connect a wallet first");
    try {
      const ixs = initializeCoinTx({
        authority,
        genesisOwner: new PublicKey(genesisOwner || publicKey),
        name,
        symbol,
        uri,
        creationFeeCoin: parseToBaseUnits(creationFeeCoin, COIN_DECIMALS),
        creationBurnBps: Number(creationBurnBps),
        devTreasury: new PublicKey(devTreasury || publicKey),
      });
      onDone(await send(ixs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-muted">
        initialize_coin <span className="font-normal">(one-time — mints the entire fixed supply)</span>
      </h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
          </Field>
          <Field label="Symbol">
            <TextInput value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={10} />
          </Field>
        </div>
        <Field label="Metadata URI">
          <TextInput value={uri} onChange={(e) => setUri(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Genesis owner" hint="Receives 100% of supply at genesis. Defaults to your wallet.">
          <TextInput value={genesisOwner} onChange={(e) => setGenesisOwner(e.target.value)} placeholder={publicKey?.toBase58()} />
        </Field>
        <Field label="Dev treasury" hint="Receives the dev share of every basket's creation fee. Defaults to your wallet.">
          <TextInput value={devTreasury} onChange={(e) => setDevTreasury(e.target.value)} placeholder={publicKey?.toBase58()} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Creation fee (EETF)">
            <TextInput value={creationFeeCoin} onChange={(e) => setCreationFeeCoin(e.target.value)} />
          </Field>
          <Field label="Burn share (bps)" hint={`min ${MIN_CREATION_BURN_BPS}`}>
            <TextInput value={creationBurnBps} onChange={(e) => setCreationBurnBps(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" disabled={pending || !publicKey}>
          {pending ? "Sending…" : "Initialize $EETF"}
        </Button>
      </form>
    </Card>
  );
}

function UpdateProtocolTermsForm({ config, pending, send, onDone, setError }: Common & { config: Config }) {
  const { publicKey } = useWallet();
  const [treasury, setTreasury] = useState(config.treasury.toBase58());
  const [creationFeeSol, setCreationFeeSol] = useState(formatBaseUnits(config.creationFeeLamports, 9));
  const [protocolShareBps, setProtocolShareBps] = useState(String(config.protocolShareBps));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) return setError("connect a wallet first");
    try {
      const ixs = updateProtocolTermsTx({
        authority: publicKey,
        treasury: new PublicKey(treasury),
        creationFeeLamports: parseToBaseUnits(creationFeeSol, 9),
        protocolShareBps: Number(protocolShareBps),
      });
      onDone(await send(ixs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-muted">
        update_protocol_terms <span className="font-normal">(future baskets only)</span>
      </h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Treasury">
          <TextInput value={treasury} onChange={(e) => setTreasury(e.target.value)} />
        </Field>
        <Field label="Creation fee (SOL)">
          <TextInput value={creationFeeSol} onChange={(e) => setCreationFeeSol(e.target.value)} />
        </Field>
        <Field label="Protocol fee share (bps)" hint={`max ${MAX_PROTOCOL_SHARE_BPS}`}>
          <TextInput value={protocolShareBps} onChange={(e) => setProtocolShareBps(e.target.value)} />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Update"}
        </Button>
      </form>
    </Card>
  );
}

function UpdateCoinTermsForm({ coinConfig, pending, send, onDone, setError }: Common & { coinConfig: CoinConfig }) {
  const { publicKey } = useWallet();
  const [devTreasury, setDevTreasury] = useState(coinConfig.devTreasury.toBase58());
  const [creationFeeCoin, setCreationFeeCoin] = useState(formatBaseUnits(coinConfig.creationFeeCoin, COIN_DECIMALS));
  const [creationBurnBps, setCreationBurnBps] = useState(String(coinConfig.creationBurnBps));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) return setError("connect a wallet first");
    try {
      const ixs = updateCoinTermsTx({
        authority: publicKey,
        devTreasury: new PublicKey(devTreasury),
        creationFeeCoin: parseToBaseUnits(creationFeeCoin, COIN_DECIMALS),
        creationBurnBps: Number(creationBurnBps),
      });
      onDone(await send(ixs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-muted">
        update_coin_terms <span className="font-normal">(bounded by on-chain hard caps)</span>
      </h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Dev treasury">
          <TextInput value={devTreasury} onChange={(e) => setDevTreasury(e.target.value)} />
        </Field>
        <Field label="Creation fee (EETF)">
          <TextInput value={creationFeeCoin} onChange={(e) => setCreationFeeCoin(e.target.value)} />
        </Field>
        <Field label="Burn share (bps)" hint={`min ${MIN_CREATION_BURN_BPS}`}>
          <TextInput value={creationBurnBps} onChange={(e) => setCreationBurnBps(e.target.value)} />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Update"}
        </Button>
      </form>
    </Card>
  );
}
