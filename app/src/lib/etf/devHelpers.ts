/**
 * Convenience helpers that have nothing to do with the Everything ETF
 * program itself — they create plain SPL mints and fund them — so a demo
 * user doesn't need their own pre-existing devnet tokens to try creating a
 * basket. Not part of the protocol; just test fixtures.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createMetadataV3Instruction } from "./metadata";

/** Tickers handed to generated test mints, so they're searchable by name. */
const TEST_TOKENS = [
  { symbol: "TFROG", name: "Test Frog" },
  { symbol: "TDOG", name: "Test Dog" },
  { symbol: "TCAT", name: "Test Cat" },
  { symbol: "TPEPE", name: "Test Pepe" },
  { symbol: "TMOON", name: "Test Moon" },
];

export interface StandInSpec {
  symbol: string;
  name: string;
  decimals: number;
  /** Whole tokens to mint to the recipient. */
  supply?: number;
}

/**
 * Devnet stand-ins for real tokens: same symbol, name and decimals, so the
 * launch form behaves exactly as it would on mainnet while every transaction
 * stays on devnet.
 *
 * Deliberately generous with the supply — the point is to remove "go find some
 * tokens" from the path, not to simulate scarcity.
 */
export async function createStandInMints(
  connection: Connection,
  payer: PublicKey,
  recipient: PublicKey,
  specs: StandInSpec[],
): Promise<{ instructions: TransactionInstruction[]; mints: Keypair[] }> {
  const rent = await getMinimumBalanceForRentExemptMint(connection);
  const instructions: TransactionInstruction[] = [];
  const mints: Keypair[] = [];

  for (const spec of specs) {
    const mint = Keypair.generate();
    mints.push(mint);
    const ata = getAssociatedTokenAddressSync(mint.publicKey, recipient);
    const supply = BigInt(spec.supply ?? 1_000_000_000) * 10n ** BigInt(spec.decimals);
    instructions.push(
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mint.publicKey,
        space: MINT_SIZE,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      // No freeze authority: the program rejects freezable asset mints, and a
      // stand-in that couldn't be put in a basket would defeat the point.
      createInitializeMint2Instruction(mint.publicKey, spec.decimals, payer, null),
      createAssociatedTokenAccountIdempotentInstruction(payer, ata, recipient, mint.publicKey),
      createMintToInstruction(mint.publicKey, ata, payer, supply),
      createMetadataV3Instruction({
        mint: mint.publicKey,
        mintAuthority: payer,
        payer,
        updateAuthority: payer,
        // Metaplex caps these; a long memecoin name would fail the CPI.
        name: spec.name.slice(0, 32),
        symbol: spec.symbol.slice(0, 10),
        uri: "",
      }),
    );
  }
  return { instructions, mints };
}

/**
 * Instructions (plus the fresh mint keypairs that must co-sign) to create
 * `count` brand-new SPL mints with no freeze authority, mint 1,000,000 whole
 * tokens of each straight to `recipient`, and give each one Metaplex metadata
 * so it shows up in the token picker by ticker rather than as a bare address.
 */
export async function createAndFundTestMints(
  connection: Connection,
  payer: PublicKey,
  recipient: PublicKey,
  count: number,
  decimals = 9,
): Promise<{ instructions: TransactionInstruction[]; mints: Keypair[] }> {
  const rent = await getMinimumBalanceForRentExemptMint(connection);
  const instructions: TransactionInstruction[] = [];
  const mints: Keypair[] = [];

  for (let i = 0; i < count; i++) {
    const mint = Keypair.generate();
    mints.push(mint);
    const ata = getAssociatedTokenAddressSync(mint.publicKey, recipient);
    instructions.push(
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mint.publicKey,
        space: MINT_SIZE,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      // No freeze authority: the program rejects freezable asset mints.
      createInitializeMint2Instruction(mint.publicKey, decimals, payer, null),
      createAssociatedTokenAccountIdempotentInstruction(payer, ata, recipient, mint.publicKey),
      createMintToInstruction(mint.publicKey, ata, payer, 1_000_000n * 10n ** BigInt(decimals)),
      // `payer` is the mint authority set just above, which is who
      // CreateMetadataAccountV3 requires to sign.
      createMetadataV3Instruction({
        mint: mint.publicKey,
        mintAuthority: payer,
        payer,
        updateAuthority: payer,
        name: TEST_TOKENS[i % TEST_TOKENS.length].name,
        symbol: TEST_TOKENS[i % TEST_TOKENS.length].symbol,
        uri: "",
      }),
    );
  }
  return { instructions, mints };
}
