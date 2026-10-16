#!/usr/bin/env -S npx tsx
/**
 * One-time admin setup: initialize_config, then initialize_coin ($EETF
 * genesis). Run once, right after scripts/deploy-devnet.sh at the repo root.
 *
 * Usage (from app/):
 *   npx tsx scripts/initialize-devnet.mts \
 *     --program-id <pubkey> \
 *     --admin ../keys/devnet-admin.json \
 *     [--url https://api.devnet.solana.com] \
 *     [--creation-fee-sol 0.1] [--protocol-share-bps 1000] \
 *     [--coin-creation-fee 100000] [--coin-burn-bps 7000]
 *
 * The coin fee targets ~$15 per launch; 300,000 EETF is $15 at a $50k
 * fully-diluted valuation. Once $EETF has a price, scripts/repeg-coin-fee-devnet.mts
 * re-quotes it instead of this default.
 *
 * The admin keypair is used as: program upgrade authority (required by
 * initialize_config), protocol treasury, $EETF genesis owner, and $EETF dev
 * treasury — fine for a devnet demo; split these for a real deployment.
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required --${name}`);
  }
  return process.argv[i + 1];
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const programId = arg("program-id");
  const adminPath = arg("admin");
  // A full RPC URL is required here (unlike solana CLI's --url, this script
  // doesn't accept cluster monikers like "devnet").
  const url = arg("url", "https://api.devnet.solana.com");
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`--url must be a full http(s) RPC URL, got "${url}"`);
  }
  const creationFeeSol = arg("creation-fee-sol", "0.1");
  const protocolShareBps = arg("protocol-share-bps", "1000");
  const coinCreationFee = arg("coin-creation-fee", "100000");
  const coinBurnBps = arg("coin-burn-bps", "7000");

  // Set before importing the client modules: PROGRAM_ID is read from this
  // env var at module-load time.
  process.env.NEXT_PUBLIC_ETF_PROGRAM_ID = programId;
  const { initializeCoinTx, initializeConfigTx, fetchConfig, fetchCoinConfig } = await import(
    "../src/lib/etf/client.js"
  );
  const { parseToBaseUnits } = await import("../src/lib/format.js");
  const { COIN_DECIMALS } = await import("../src/lib/etf/constants.js");

  const admin = loadKeypair(adminPath);
  const connection = new Connection(url, "confirmed");

  console.log(`program:    ${programId}`);
  console.log(`admin:      ${admin.publicKey.toBase58()}`);
  console.log(`cluster:    ${url}`);

  const existingConfig = await fetchConfig(connection);
  if (existingConfig) {
    console.log("Config already initialized, skipping initialize_config:");
    console.log(existingConfig);
  } else {
    console.log("\nSending initialize_config...");
    const ixs = initializeConfigTx({
      authority: admin.publicKey,
      treasury: admin.publicKey,
      creationFeeLamports: parseToBaseUnits(creationFeeSol, 9),
      protocolShareBps: Number(protocolShareBps),
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [admin]);
    console.log(`initialize_config: ${sig}`);
  }

  const existingCoin = await fetchCoinConfig(connection);
  if (existingCoin) {
    console.log("CoinConfig already initialized, skipping initialize_coin:");
    console.log(existingCoin);
  } else {
    console.log("\nSending initialize_coin (mints the entire fixed $EETF supply)...");
    const ixs = initializeCoinTx({
      authority: admin.publicKey,
      genesisOwner: admin.publicKey,
      name: "Everything ETF",
      symbol: "EETF",
      uri: "https://example.com/eetf.json",
      creationFeeCoin: parseToBaseUnits(coinCreationFee, COIN_DECIMALS),
      creationBurnBps: Number(coinBurnBps),
      devTreasury: admin.publicKey,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [admin]);
    console.log(`initialize_coin: ${sig}`);
  }

  console.log("\nDone. Set these in app/.env.local:");
  console.log(`NEXT_PUBLIC_ETF_PROGRAM_ID=${programId}`);
  console.log(`NEXT_PUBLIC_RPC_URL=${url}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
