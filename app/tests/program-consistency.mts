#!/usr/bin/env -S npx tsx
/**
 * Regression test for the thing app/README.md's "Why there's no Anchor TS
 * client here" section flags as a risk: app/src/lib/etf/* hand-builds every
 * instruction and account decoder by mirroring the Rust program, with
 * nothing to catch the two drifting apart. This test closes that gap by
 * loading the *actual compiled program* (target/deploy/everything_etf.so)
 * into litesvm — the same binary tests-e2e's Rust tests exercise — and
 * sending it transactions built by our hand-written TS layer, the same
 * layer the web app uses. If an instruction's account list/order or a
 * decoder's field layout ever drifts from the Rust source, the real program
 * rejects the transaction or this test's decoded values stop matching what
 * was sent, and this fails.
 *
 * litesvm's npm package only ships prebuilt binaries for macOS and Linux
 * (see optionalDependencies in its package.json) — there's no Windows
 * build, so this can only run on Linux/macOS (CI; not this project's local
 * Windows dev machine).
 *
 * litesvm's JS API is built on @solana/kit, not @solana/web3.js (our stack
 * everywhere else) — different types for addresses, instructions, and
 * transaction signing. The conversions live entirely in this file; nothing
 * about the app itself needs to know @solana/kit exists.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { address, type Address } from "@solana/addresses";
import { AccountRole } from "@solana/instructions";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  setTransactionMessageFeePayer,
} from "@solana/transaction-messages";
import { compileTransaction } from "@solana/transactions";
import { createKeyPairFromBytes } from "@solana/keys";
import { signTransaction } from "@solana/transactions";
import { lamports } from "@solana/rpc-types";
import { pipe } from "@solana/functional";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROGRAM_SO = path.join(here, "..", "..", "target", "deploy", "everything_etf.so");
const METADATA_FIXTURE = path.join(here, "..", "..", "tests-e2e", "fixtures", "mpl_token_metadata.so");

// The program has to be loaded at exactly the address baked into it by
// declare_id!: Anchor's generated entrypoint compares the invoking program
// id against that constant and bails with DeclaredProgramIdMismatch (4100)
// otherwise. Parsed from the Rust source rather than hardcoded so this
// keeps working if the deployment address ever changes again.
const LIB_RS = path.join(here, "..", "..", "programs", "everything-etf", "src", "lib.rs");
const declaredId = readFileSync(LIB_RS, "utf-8").match(/declare_id!\("([^"]+)"\)/)?.[1];
if (!declaredId) throw new Error(`could not parse declare_id! out of ${LIB_RS}`);
const PROGRAM_ID = new PublicKey(declaredId);
process.env.NEXT_PUBLIC_ETF_PROGRAM_ID = PROGRAM_ID.toBase58();

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

// Imported dynamically, after the env var above is set — constants.ts
// reads NEXT_PUBLIC_ETF_PROGRAM_ID at module-load time.
const { initializeConfigTx, initializeCoinTx, updateAuthorityTx, fetchConfig, fetchCoinConfig } =
  await import("../src/lib/etf/client.js");

// ---------------------------------------------------------------------------
// @solana/web3.js <-> @solana/kit conversions, scoped to this test
// ---------------------------------------------------------------------------

function toAddress(pk: PublicKey): Address {
  return address(pk.toBase58());
}

function roleFor(isSigner: boolean, isWritable: boolean): AccountRole {
  if (isSigner && isWritable) return AccountRole.WRITABLE_SIGNER;
  if (isSigner) return AccountRole.READONLY_SIGNER;
  if (isWritable) return AccountRole.WRITABLE;
  return AccountRole.READONLY;
}

function toKitInstruction(ix: TransactionInstruction) {
  return {
    programAddress: toAddress(ix.programId),
    accounts: ix.keys.map((k) => ({ address: toAddress(k.pubkey), role: roleFor(k.isSigner, k.isWritable) })),
    data: new Uint8Array(ix.data),
  };
}

/** Builds, signs (with every one of `signers`), and sends a transaction; throws on failure. */
async function send(svm: LiteSVM, instructions: TransactionInstruction[], signers: Keypair[]) {
  // Chained via pipe rather than reassigning a `let` — each of these
  // functions returns a message type one step more complete than the last
  // (fee payer set, then instructions added, then a lifetime attached), and
  // a plain `let`'s inferred type doesn't widen across reassignment the way
  // this needs; pipe is kit's own documented way around that.
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(toAddress(signers[0].publicKey), m),
    (m) => appendTransactionMessageInstructions(instructions.map(toKitInstruction), m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
  );
  const compiled = compileTransaction(message);
  const keyPairs = await Promise.all(signers.map((kp) => createKeyPairFromBytes(kp.secretKey)));
  const signed = await signTransaction(keyPairs, compiled);
  const result = svm.sendTransaction(signed);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(`transaction failed: ${result.toString()}`);
  }
  return result;
}

/** Fetches and `Buffer`-wraps an account's data (our decoders expect `Buffer`, not `Uint8Array`). */
function getAccountData(svm: LiteSVM, pk: PublicKey): Buffer {
  const acc = svm.getAccount(toAddress(pk));
  if (!acc.exists) throw new Error(`account not found: ${pk.toBase58()}`);
  return Buffer.from(acc.data);
}

/**
 * `initialize_config` requires the caller to be the program's upgrade
 * authority. litesvm's `addProgramFromFile` creates the programdata account
 * with no upgrade authority set, so this patches it in directly — exactly
 * mirroring tests-e2e's own `set_upgrade_authority` helper in Rust, byte for
 * byte (loader-v3 ProgramData is bincode: u32 variant tag, u64 slot,
 * Option<Pubkey> — the Option's tag is the first byte after those 12).
 */
function setUpgradeAuthority(svm: LiteSVM, programId: PublicKey, authority: PublicKey) {
  const [programDataPk] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID);
  const programDataAddr = toAddress(programDataPk);
  const acc = svm.getAccount(programDataAddr);
  if (!acc.exists) throw new Error("programdata account not found");
  const data = Buffer.from(acc.data);
  data[12] = 1; // Option::Some
  authority.toBuffer().copy(data, 13);
  svm.setAccount({
    address: programDataAddr,
    data: new Uint8Array(data),
    executable: acc.executable,
    lamports: acc.lamports,
    programAddress: acc.programAddress,
    space: acc.space,
  });
}

// ---------------------------------------------------------------------------
// the actual check
// ---------------------------------------------------------------------------

async function main() {
  const svm = new LiteSVM();
  svm.addProgramFromFile(toAddress(PROGRAM_ID), PROGRAM_SO);
  svm.addProgramFromFile(toAddress(METADATA_PROGRAM_ID), METADATA_FIXTURE);

  const authority = Keypair.generate();
  svm.airdrop(toAddress(authority.publicKey), lamports(10_000_000_000n));
  setUpgradeAuthority(svm, PROGRAM_ID, authority.publicKey);

  // --- initialize_config -------------------------------------------------
  const treasury = authority.publicKey;
  const creationFeeLamports = 250_000_000n;
  const protocolShareBps = 1000;
  await send(
    svm,
    initializeConfigTx({ authority: authority.publicKey, treasury, creationFeeLamports, protocolShareBps }),
    [authority],
  );

  const { configPda } = await import("../src/lib/etf/pda.js");
  const { decodeConfig } = await import("../src/lib/etf/accounts.js");
  const config = decodeConfig(getAccountData(svm, configPda()[0]));
  assert.equal(config.authority.toBase58(), authority.publicKey.toBase58(), "Config.authority");
  assert.equal(config.treasury.toBase58(), treasury.toBase58(), "Config.treasury");
  assert.equal(config.creationFeeLamports, creationFeeLamports, "Config.creationFeeLamports");
  assert.equal(config.protocolShareBps, protocolShareBps, "Config.protocolShareBps");
  assert.equal(config.basketCount, 0n, "Config.basketCount");
  console.log("OK  initialize_config: Config decodes back exactly as sent");

  // --- initialize_coin -----------------------------------------------------
  const creationFeeCoin = 100_000n * 1_000_000_000n; // 100,000 EETF, 9 decimals
  const creationBurnBps = 7000;
  await send(
    svm,
    initializeCoinTx({
      authority: authority.publicKey,
      genesisOwner: authority.publicKey,
      name: "Everything ETF",
      symbol: "EETF",
      uri: "https://example.com/eetf.json",
      creationFeeCoin,
      creationBurnBps,
      devTreasury: authority.publicKey,
    }),
    [authority],
  );

  const { coinConfigPda, coinMintPda } = await import("../src/lib/etf/pda.js");
  const { decodeCoinConfig } = await import("../src/lib/etf/accounts.js");
  const coinConfig = decodeCoinConfig(getAccountData(svm, coinConfigPda()[0]));
  assert.equal(coinConfig.creationFeeCoin, creationFeeCoin, "CoinConfig.creationFeeCoin");
  assert.equal(coinConfig.creationBurnBps, creationBurnBps, "CoinConfig.creationBurnBps");
  assert.equal(coinConfig.devTreasury.toBase58(), authority.publicKey.toBase58(), "CoinConfig.devTreasury");
  assert.equal(coinConfig.totalBurned, 0n, "CoinConfig.totalBurned");
  console.log("OK  initialize_coin: CoinConfig decodes back exactly as sent");

  // Mint authority must be gone — the one promise $EETF makes.
  const mintData = getAccountData(svm, coinMintPda()[0]);
  const mintAuthorityOption = mintData.readUInt32LE(0); // spl-token Mint: COption<Pubkey> tag first
  assert.equal(mintAuthorityOption, 0, "$EETF mint authority must be revoked (COption::None)");
  console.log("OK  initialize_coin: $EETF mint authority revoked");

  // --- update_authority ----------------------------------------------------
  // Two signers in one instruction, which no other instruction here has —
  // worth covering precisely because it's the shape most likely to be built
  // wrong on the TS side.
  const nextAuthority = Keypair.generate();
  svm.airdrop(toAddress(nextAuthority.publicKey), lamports(1_000_000_000n));
  await send(
    svm,
    updateAuthorityTx({ authority: authority.publicKey, newAuthority: nextAuthority.publicKey }),
    [authority, nextAuthority],
  );
  const rotated = decodeConfig(getAccountData(svm, configPda()[0]));
  assert.equal(rotated.authority.toBase58(), nextAuthority.publicKey.toBase58(), "rotated authority");
  console.log("OK  update_authority: both-signer instruction lands and Config.authority moves");

  // Sanity check that fetchConfig/fetchCoinConfig (the functions the app
  // actually calls) agree, via a tiny connection-shaped shim over litesvm.
  const shimConnection = {
    getAccountInfo: async (pk: PublicKey) => {
      const acc = svm.getAccount(toAddress(pk));
      return acc.exists ? { data: Buffer.from(acc.data) } : null;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  assert.equal((await fetchConfig(shimConnection))?.treasury.toBase58(), treasury.toBase58());
  assert.equal((await fetchCoinConfig(shimConnection))?.creationBurnBps, creationBurnBps);
  console.log("OK  client.ts's fetchConfig/fetchCoinConfig agree with the direct decode");

  // --- Metaplex metadata ---------------------------------------------------
  // The token picker reads names/symbols off metadata accounts, and the dev
  // helper writes them with a hand-rolled CreateMetadataAccountV3 encoding
  // (no Metaplex JS SDK here). Both sides are checked against the real
  // Metaplex program rather than trusted.
  const { decodeMetadata, metadataPda, createMetadataV3Instruction } = await import(
    "../src/lib/etf/metadata.js"
  );

  // Decoder: against metadata the *program* wrote for $EETF via its own CPI.
  const coinMeta = decodeMetadata(getAccountData(svm, metadataPda(coinMintPda()[0])));
  assert.equal(coinMeta?.name, "Everything ETF", "decoded $EETF metadata name");
  assert.equal(coinMeta?.symbol, "EETF", "decoded $EETF metadata symbol");
  console.log("OK  metadata decoder reads what the program's own CPI wrote");

  // Encoder: our instruction, sent to the real Metaplex program, read back.
  const { MINT_SIZE, TOKEN_PROGRAM_ID, createInitializeMint2Instruction } = await import(
    "@solana/spl-token"
  );
  const { SystemProgram } = await import("@solana/web3.js");
  const testMint = Keypair.generate();
  await send(
    svm,
    [
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: testMint.publicKey,
        space: MINT_SIZE,
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(testMint.publicKey, 9, authority.publicKey, null),
      createMetadataV3Instruction({
        mint: testMint.publicKey,
        mintAuthority: authority.publicKey,
        payer: authority.publicKey,
        updateAuthority: authority.publicKey,
        name: "Test Frog",
        symbol: "TFROG",
        uri: "",
      }),
    ],
    [authority, testMint],
  );
  const written = decodeMetadata(getAccountData(svm, metadataPda(testMint.publicKey)));
  assert.equal(written?.name, "Test Frog", "round-tripped metadata name");
  assert.equal(written?.symbol, "TFROG", "round-tripped metadata symbol");
  console.log("OK  hand-built CreateMetadataAccountV3 round-trips through Metaplex");

  console.log("\nAll program-consistency checks passed.");
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
