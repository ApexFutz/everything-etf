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
