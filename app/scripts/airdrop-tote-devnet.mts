#!/usr/bin/env -S npx tsx
/**
 * Hands a tester devnet $TOTE so they can pay a basket's creation fee.
 *
 * $TOTE is a fixed supply: the whole 1B was minted once in initialize_coin and
 * the mint authority was revoked, so there is nothing to mint — this *transfers*
 * from the genesis holder (the admin wallet by default) to any address you
 * paste. A fresh devnet wallet holds no $TOTE, and the launch fee is burned
 * from the manager's wallet, so without this a tester can't create a basket.
 *
 * It also tops the recipient's devnet SOL up to a target (default 0.5), so they
 * can pay the rent for the stand-in mints, the basket and its vaults and finish
 * the whole flow without airdropping anything themselves. SOL comes from the
 * free cluster faucet first; if that's rate-limited it falls back to the
 * source wallet's SOL.
 *
 * Usage (from app/):
 *   npx tsx scripts/airdrop-tote-devnet.mts \
 *     --to <recipient-pubkey> \
 *     [--amount 1500000]                     # whole TOTE; default = 5 launches
 *     [--sol 0.5]                            # top SOL up to this; --no-sol to skip
 *     [--source ../keys/devnet-admin.json]   # who holds the $TOTE
 *     [--program-id 9mT7xrj7xWiTPkH8pMQ8yzz8d8Fs9TacqyYQ61yPUzyq]
 *     [--url https://api.devnet.solana.com] \
 *     [--dry-run]
 *
 * The default TOTE amount scales to the live on-chain fee: five launches'
 * worth, so it stays sensible whatever the fee is re-pegged to.
 */
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TokenAccountNotFoundError,
} from "@solana/spl-token";

/** The initialized devnet deployment, so --program-id is optional. */
const DEFAULT_PROGRAM_ID = "9mT7xrj7xWiTPkH8pMQ8yzz8d8Fs9TacqyYQ61yPUzyq";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required --${name}`);
  }
  return process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const toRaw = arg("to");
  let recipient: PublicKey;
  try {
    recipient = new PublicKey(toRaw);
  } catch {
    throw new Error(`--to is not a valid pubkey: "${toRaw}"`);
  }

  const programId = arg("program-id", DEFAULT_PROGRAM_ID);
  const sourcePath = arg("source", "../keys/devnet-admin.json");
  const url = arg("url", "https://api.devnet.solana.com");
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`--url must be a full http(s) RPC URL, got "${url}"`);
  }
  const dryRun = flag("dry-run");
  const solTarget = flag("no-sol") ? 0 : Number(arg("sol", "0.5"));
  if (Number.isNaN(solTarget) || solTarget < 0) {
    throw new Error(`--sol must be a non-negative number, got "${arg("sol", "")}"`);
  }

  // PROGRAM_ID is read from this env var when the client module loads.
  process.env.NEXT_PUBLIC_ETF_PROGRAM_ID = programId;
  const { fetchCoinConfig } = await import("../src/lib/etf/client.js");
  const { parseToBaseUnits, formatTokens } = await import("../src/lib/format.js");

  const source = loadKeypair(sourcePath);
  const connection = new Connection(url, "confirmed");
  const cluster = url.includes("devnet") ? "?cluster=devnet" : "";

  const coinConfig = await fetchCoinConfig(connection);
  if (!coinConfig) {
    throw new Error("CoinConfig not found — is $TOTE initialized on this cluster/program?");
  }
  const mint = coinConfig.mint;
  const { decimals } = await getMint(connection, mint);

  // Default to five launches' worth, so the amount tracks the live fee.
  const amount = flag("amount")
    ? parseToBaseUnits(arg("amount"), decimals)
    : coinConfig.creationFeeCoin * 5n;
  if (amount <= 0n) throw new Error("--amount must be greater than zero");

  const fee = coinConfig.creationFeeCoin;
  const launches = fee > 0n ? amount / fee : 0n;

  console.log(`program:   ${programId}`);
  console.log(`cluster:   ${url}`);
  console.log(`$TOTE mint:${" "}${mint.toBase58()}`);
  console.log(`source:    ${source.publicKey.toBase58()}`);
  console.log(`recipient: ${recipient.toBase58()}`);
  console.log(
    `amount:    ${formatTokens(amount, decimals)} TOTE  (fee ${formatTokens(fee, decimals)} → ~${launches} launch${launches === 1n ? "" : "es"})`,
  );

  if (recipient.equals(source.publicKey)) {
    throw new Error("recipient is the source wallet — nothing to do");
  }

  const sourceAta = getAssociatedTokenAddressSync(mint, source.publicKey);
  let sourceBalance: bigint;
  try {
    sourceBalance = (await getAccount(connection, sourceAta)).amount;
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) {
      throw new Error(
        `source ${source.publicKey.toBase58()} holds no $TOTE account — is this the genesis/admin wallet?`,
      );
    }
    throw e;
  }
  if (sourceBalance < amount) {
    throw new Error(
      `source holds ${formatTokens(sourceBalance, decimals)} TOTE, short of the ${formatTokens(amount, decimals)} requested`,
    );
  }

  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);
  const instructions = [];
  let needsAta = false;
  try {
    await getAccount(connection, recipientAta);
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) {
      needsAta = true;
      // Source pays the rent to open the recipient's token account.
      instructions.push(
        createAssociatedTokenAccountInstruction(source.publicKey, recipientAta, recipient, mint),
      );
    } else {
      throw e;
    }
  }
  instructions.push(
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      recipientAta,
      source.publicKey,
      amount,
      decimals,
    ),
  );

  // --- SOL top-up ---------------------------------------------------------
  const fmtSol = (lamports: bigint) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
  const targetLamports = BigInt(Math.round(solTarget * LAMPORTS_PER_SOL));
  const haveSol = BigInt(await connection.getBalance(recipient));
  const solNeed = targetLamports > haveSol ? targetLamports - haveSol : 0n;

  console.log(
    `\nPlan: ${needsAta ? "create the recipient's $TOTE account, then transfer" : "transfer"} (${instructions.length} instruction${instructions.length === 1 ? "" : "s"}).`,
  );
  if (solTarget === 0) {
    console.log("SOL:  skipped (--no-sol).");
  } else if (solNeed === 0n) {
    console.log(`SOL:  recipient already has ${fmtSol(haveSol)} (target ${solTarget}).`);
  } else {
    console.log(`SOL:  top up ${fmtSol(solNeed)} → ${solTarget} (faucet, else source).`);
  }
  if (dryRun) {
    console.log("--dry-run: nothing sent.");
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...instructions), [
    source,
  ]);
  const newBalance = (await getAccount(connection, recipientAta)).amount;
  console.log(`\nSent: ${sig}`);
  console.log(`https://explorer.solana.com/tx/${sig}${cluster}`);
  console.log(`recipient now holds ${formatTokens(newBalance, decimals)} TOTE.`);

  if (solNeed > 0n) {
    // Free cluster faucet first — it doesn't touch the source wallet's SOL.
    // Devnet rate-limits it, so fall back to a plain transfer from the source.
    try {
      const airdropSig = await connection.requestAirdrop(recipient, Number(solNeed));
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: airdropSig, ...bh }, "confirmed");
      console.log(`SOL via faucet: ${airdropSig}`);
    } catch {
      const transferSig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: source.publicKey,
            toPubkey: recipient,
            lamports: Number(solNeed),
          }),
        ),
        [source],
      );
      console.log(`SOL via source (faucet was rate-limited): ${transferSig}`);
    }
    console.log(`recipient now holds ${fmtSol(BigInt(await connection.getBalance(recipient)))} SOL.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
