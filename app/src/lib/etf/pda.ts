/**
 * PDA / ATA derivation, mirroring the seeds in programs/everything-etf/src/
 * constants.rs and the `#[account(seeds = ...)]` constraints on each
 * instruction's accounts.
 */
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  BASKET_MINT_SEED,
  BASKET_SEED,
  COIN_MINT_SEED,
  COIN_SEED,
  CONFIG_SEED,
  PROGRAM_ID,
} from "./constants";

export function configPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
}

export function coinConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([COIN_SEED], PROGRAM_ID);
}

export function coinMintPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([COIN_MINT_SEED], PROGRAM_ID);
}

/** `basket_count` at creation time becomes the basket's permanent id. */
export function basketPda(id: bigint | number): [PublicKey, number] {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(id), 0);
  return PublicKey.findProgramAddressSync([BASKET_SEED, idBuf], PROGRAM_ID);
}

export function basketMintPda(basket: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BASKET_MINT_SEED, basket.toBuffer()],
    PROGRAM_ID,
  );
}

export function metadataPda(mint: PublicKey, metadataProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), metadataProgramId.toBuffer(), mint.toBuffer()],
    metadataProgramId,
  )[0];
}

/** The basket's fee escrow is just its own basket-token ATA. */
export function feeEscrowAta(basket: PublicKey, basketMint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(basketMint, basket, true);
}

/** The $EETF burn vault is the coin-config PDA's own $EETF ATA. */
export function burnVaultAta(coinConfig: PublicKey, coinMint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(coinMint, coinConfig, true);
}
