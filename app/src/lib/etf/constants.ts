/**
 * Everything ETF: protocol constants mirrored from the Rust program
 * (programs/everything-etf/src/constants.rs). Keep these two files in sync —
 * nothing here is derived automatically from the Rust source.
 */
import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/** Basis-point denominator (100% = 10_000 bps). */
export const BPS = 10_000n;

export const MIN_ASSETS = 2;
export const MAX_ASSETS = 10;

// Mirror of constants.rs — the consistency test fails if these drift.
// All zero: a basket charges nothing. The launch fee is the only fee.
export const MAX_MINT_FEE_BPS = 0;
export const MAX_REDEEM_FEE_BPS = 0;
export const MAX_STREAMING_FEE_BPS = 0;
export const MAX_PROTOCOL_SHARE_BPS = 3_000; // 30%

export const BASKET_DECIMALS = 9;
export const COIN_DECIMALS = 9;

export const COIN_TOTAL_SUPPLY = 1_000_000_000n * 1_000_000_000n; // 1e9 EETF, 9 decimals

export const MIN_CREATION_BURN_BPS = 5_000; // 50%
export const MAX_CREATION_FEE_COIN = 10_000_000n * 1_000_000_000n; // 1% of genesis supply

export const MAX_NAME_LEN = 32;
export const MAX_SYMBOL_LEN = 10;
export const MAX_URI_LEN = 200;

// -- PDA seeds --------------------------------------------------------------
export const CONFIG_SEED = Buffer.from("config");
export const BASKET_SEED = Buffer.from("basket");
export const BASKET_MINT_SEED = Buffer.from("basket_mint");
export const COIN_SEED = Buffer.from("coin");
export const COIN_MINT_SEED = Buffer.from("coin_mint");

// Re-exported for convenience so callers only need to import from here.
export { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID };

export const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

/**
 * The deployed program ID. Set NEXT_PUBLIC_ETF_PROGRAM_ID once the program is
 * deployed (see scripts/deploy-devnet.sh at the repo root); until then this
 * placeholder matches declare_id!() in the Rust source but isn't live
 * anywhere, and every transaction will fail with "program account not found".
 */
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_ETF_PROGRAM_ID ??
    "HVxbNmXpRw6RGZaQ4N9hZedeB8mN2DuWaDhRbqEL3YBv",
);

export const DEFAULT_RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
