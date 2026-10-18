#!/usr/bin/env -S npx tsx
/**
 * Changes protocol terms on a live deployment: the SOL creation fee, the
 * protocol share, and the treasury.
 *
 * `update_protocol_terms` overwrites all three fields in one go, so passing a
 * partial update would silently reset the others. This reads the current Config
 * first and only replaces what you actually name on the command line, then
 * prints a before/after diff and refuses to send if nothing changed.
 *
 * Only affects baskets created *after* the call — existing baskets keep the
 * protocol share they were created with, by design.
 *
 * Usage (from app/):
 *   npx tsx scripts/update-protocol-terms-devnet.mts \
 *     --program-id <pubkey> --admin ../keys/devnet-admin.json \
 *     [--creation-fee-sol 0.1] [--protocol-share-bps 1000] [--treasury <pubkey>] \
 *     [--dry-run] [--url <rpc>]
 */
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required --${name}`);
  }
  return process.argv[i + 1];
}
const given = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const programId = arg("program-id");
  const url = arg("url", "https://api.devnet.solana.com");
  process.env.NEXT_PUBLIC_ETF_PROGRAM_ID = programId;

  const { fetchConfig, updateProtocolTermsTx } = await import("../src/lib/etf/client.js");
  const { formatBps } = await import("../src/lib/format.js");

  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(arg("admin"), "utf-8"))),
  );
  const connection = new Connection(url, "confirmed");

  const config = await fetchConfig(connection);
  if (!config) throw new Error("protocol not initialized — run initialize-devnet.mts first");

  // Anything not named on the command line is carried over unchanged.
  const treasury = given("treasury") ? new PublicKey(arg("treasury")) : config.treasury;
  const creationFeeLamports = given("creation-fee-sol")
    ? BigInt(Math.round(Number(arg("creation-fee-sol")) * 1e9))
    : config.creationFeeLamports;
  const protocolShareBps = given("protocol-share-bps")
    ? Number(arg("protocol-share-bps"))
    : config.protocolShareBps;

  const rows: [string, string, string][] = [
    ["treasury", config.treasury.toBase58(), treasury.toBase58()],
    [
      "creation fee",
      `${Number(config.creationFeeLamports) / 1e9} SOL`,
      `${Number(creationFeeLamports) / 1e9} SOL`,
    ],
    ["protocol share", formatBps(config.protocolShareBps), formatBps(protocolShareBps)],
  ];
  console.log(`  ${"field".padEnd(16)}${"current".padEnd(46)}new`);
  console.log("-".repeat(104));
  for (const [field, before, after] of rows) {
    const mark = before === after ? "   " : " * ";
    console.log(`${mark}${field.padEnd(16)}${before.padEnd(46)}${after}`);
  }

  if (rows.every(([, before, after]) => before === after)) {
    console.log("\nnothing would change — not sending.");
    return;
  }
  if (process.argv.includes("--dry-run")) {
    console.log("\n--dry-run: not sending.");
    return;
  }
  if (config.authority.toBase58() !== admin.publicKey.toBase58()) {
    throw new Error(
      `--admin is ${admin.publicKey.toBase58()} but Config.authority is ${config.authority.toBase58()}`,
    );
  }

  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ...updateProtocolTermsTx({
        authority: admin.publicKey,
        treasury,
        creationFeeLamports,
        protocolShareBps,
      }),
    ),
    [admin],
  );
  console.log(`\nupdated: ${sig}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
