/**
 * Decoders for this program's `#[account]` structs, mirroring
 * programs/everything-etf/src/state.rs field-for-field. Each account's first
 * 8 bytes are its Anchor discriminator (see discriminators.ts); the rest is
 * `AnchorSerialize`'d in declaration order.
 */
import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_DISCRIMINATORS } from "./discriminators";
import { hasDiscriminator, Reader } from "./codec";

export interface Config {
  authority: PublicKey;
  treasury: PublicKey;
  creationFeeLamports: bigint;
  protocolShareBps: number;
  basketCount: bigint;
  bump: number;
}

export function decodeConfig(data: Buffer): Config {
  if (!hasDiscriminator(data, [...ACCOUNT_DISCRIMINATORS.Config])) {
    throw new Error("not a Config account (discriminator mismatch)");
  }
  const r = new Reader(data.subarray(8));
  return {
    authority: r.pubkey(),
    treasury: r.pubkey(),
    creationFeeLamports: r.u64(),
    protocolShareBps: r.u16(),
    basketCount: r.u64(),
    bump: r.u8(),
  };
}

export interface Basket {
  id: bigint;
  manager: PublicKey;
  mint: PublicKey;
  feeEscrow: PublicKey;
  assets: PublicKey[];
  mintFeeBps: number;
  redeemFeeBps: number;
  streamingFeeBps: number;
  protocolShareBps: number;
  managerFeesAccrued: bigint;
  protocolFeesAccrued: bigint;
  lastFeeAccrual: bigint;
  createdAt: bigint;
  bump: number;
  mintBump: number;
}

export function decodeBasket(data: Buffer): Basket {
  if (!hasDiscriminator(data, [...ACCOUNT_DISCRIMINATORS.Basket])) {
    throw new Error("not a Basket account (discriminator mismatch)");
  }
  const r = new Reader(data.subarray(8));
  return {
    id: r.u64(),
    manager: r.pubkey(),
    mint: r.pubkey(),
    feeEscrow: r.pubkey(),
    assets: r.vecPubkey(),
    mintFeeBps: r.u16(),
    redeemFeeBps: r.u16(),
    streamingFeeBps: r.u16(),
    protocolShareBps: r.u16(),
    managerFeesAccrued: r.u64(),
    protocolFeesAccrued: r.u64(),
    lastFeeAccrual: r.i64(),
    createdAt: r.i64(),
    bump: r.u8(),
    mintBump: r.u8(),
  };
}

export interface CoinConfig {
  mint: PublicKey;
  devTreasury: PublicKey;
  burnVault: PublicKey;
  creationFeeCoin: bigint;
  creationBurnBps: number;
  totalBurned: bigint;
  totalDevFees: bigint;
  basketsFunded: bigint;
  bump: number;
  mintBump: number;
}

export function decodeCoinConfig(data: Buffer): CoinConfig {
  if (!hasDiscriminator(data, [...ACCOUNT_DISCRIMINATORS.CoinConfig])) {
    throw new Error("not a CoinConfig account (discriminator mismatch)");
  }
  const r = new Reader(data.subarray(8));
  return {
    mint: r.pubkey(),
    devTreasury: r.pubkey(),
    burnVault: r.pubkey(),
    creationFeeCoin: r.u64(),
    creationBurnBps: r.u16(),
    totalBurned: r.u64(),
    totalDevFees: r.u64(),
    basketsFunded: r.u64(),
    bump: r.u8(),
    mintBump: r.u8(),
  };
}
