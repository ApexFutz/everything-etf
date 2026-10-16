#!/usr/bin/env -S npx tsx
/**
 * Moves the protocol treasury and $EETF dev treasury off the deploying admin
 * wallet, onto their own dedicated keypairs — without touching any other
 * term. Run once, after scripts/initialize-devnet.mts.
 *
 * Usage (from app/):
 *   npx tsx scripts/split-admin-roles-devnet.mts \
 *     --program-id <pubkey> \
 *     --authority ../keys/devnet-admin.json \
 *     --new-treasury ../keys/devnet-treasury.json \
 *     --new-dev-treasury ../keys/devnet-dev-treasury.json \
 *     [--url https://api.devnet.solana.com]
 *
 * What this can't do: rotate `Config.authority` (the protocol authority
 * itself) or the $EETF genesis owner — the program has no instruction for
 * either (see issue tracking "Add a way to rotate Config.authority"). The
 * program's upgrade authority is a separate thing, reassignable with the
 * ordinary `solana program set-upgrade-authority` (not this script).
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
  const url = arg("url", "https://api.devnet.solana.com");
  if (!/^https?:\/\//.test(url)) throw new Error(`--url must be a full http(s) RPC URL, got "${url}"`);

  process.env.NEXT_PUBLIC_ETF_PROGRAM_ID = programId;
  const { fetchConfig, fetchCoinConfig, updateProtocolTermsTx, updateCoinTermsTx } = await import(
    "../src/lib/etf/client.js"
  );

  const authority = loadKeypair(arg("authority"));
  const newTreasury = loadKeypair(arg("new-treasury")).publicKey;
  const newDevTreasury = loadKeypair(arg("new-dev-treasury")).publicKey;
  const connection = new Connection(url, "confirmed");

  const config = await fetchConfig(connection);
  const coinConfig = await fetchCoinConfig(connection);
  if (!config || !coinConfig) throw new Error("run initialize-devnet.mts first");

  console.log(`treasury:     ${config.treasury.toBase58()} -> ${newTreasury.toBase58()}`);
  const ix1 = updateProtocolTermsTx({
    authority: authority.publicKey,
    treasury: newTreasury,
    creationFeeLamports: config.creationFeeLamports,
    protocolShareBps: config.protocolShareBps,
  });
  console.log(`update_protocol_terms: ${await sendAndConfirmTransaction(connection, new Transaction().add(...ix1), [authority])}`);

  console.log(`dev treasury: ${coinConfig.devTreasury.toBase58()} -> ${newDevTreasury.toBase58()}`);
  const ix2 = updateCoinTermsTx({
    authority: authority.publicKey,
    devTreasury: newDevTreasury,
    creationFeeCoin: coinConfig.creationFeeCoin,
    creationBurnBps: coinConfig.creationBurnBps,
  });
  console.log(`update_coin_terms: ${await sendAndConfirmTransaction(connection, new Transaction().add(...ix2), [authority])}`);

  console.log("\nDone. Config.authority and the $EETF genesis owner are unchanged — the");
  console.log("program has no instruction to rotate either (see the header comment).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
