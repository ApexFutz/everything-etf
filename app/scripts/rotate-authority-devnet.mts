#!/usr/bin/env -S npx tsx
/**
 * Rotates the protocol authority (`Config.authority`) to a new key.
 *
 * Both the current and the incoming authority sign, which is what the program
 * requires — an address that can't sign can't be installed, so a typo can't
 * permanently lock the protocol out of its own admin role.
 *
 * Usage (from app/):
 *   npx tsx scripts/rotate-authority-devnet.mts \
 *     --program-id <pubkey> \
 *     --authority ../keys/devnet-admin.json \
 *     --new-authority ../keys/devnet-new-authority.json \
 *     [--url https://api.devnet.solana.com]
 *
 * Both arguments are keypair *files* because both have to sign. For a real
 * deployment the incoming authority would be a multisig, and that half of the
 * signature would come from the multisig's own tooling (e.g. Squads) rather
 * than a local file — the instruction is the same either way.
 *
 * This is deliberately not in the web UI: a single connected wallet can't
 * produce both signatures.
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
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf-8"))));
}

async function main() {
  const programId = arg("program-id");
  const url = arg("url", "https://api.devnet.solana.com");
  if (!/^https?:\/\//.test(url)) throw new Error(`--url must be a full http(s) RPC URL, got "${url}"`);

  process.env.NEXT_PUBLIC_ETF_PROGRAM_ID = programId;
  const { fetchConfig, updateAuthorityTx } = await import("../src/lib/etf/client.js");

  const authority = loadKeypair(arg("authority"));
  const newAuthority = loadKeypair(arg("new-authority"));
  const connection = new Connection(url, "confirmed");

  const before = await fetchConfig(connection);
  if (!before) throw new Error("no Config account — run initialize-devnet.mts first");
  if (!before.authority.equals(authority.publicKey)) {
    throw new Error(
      `--authority ${authority.publicKey.toBase58()} is not the current authority ` +
        `(${before.authority.toBase58()})`,
    );
  }

  console.log(`authority: ${before.authority.toBase58()} -> ${newAuthority.publicKey.toBase58()}`);
  const ixs = updateAuthorityTx({
    authority: authority.publicKey,
    newAuthority: newAuthority.publicKey,
  });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [
    authority,
    newAuthority,
  ]);
  console.log(`update_authority: ${sig}`);

  const after = await fetchConfig(connection);
  console.log(`confirmed on-chain: ${after?.authority.toBase58()}`);
  if (!after?.authority.equals(newAuthority.publicKey)) {
    throw new Error("rotation did not take effect");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
