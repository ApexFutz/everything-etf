/**
 * Instruction builders for the Everything ETF program.
 *
 * Each function mirrors one `#[derive(Accounts)]` struct in
 * programs/everything-etf/src/instructions/*.rs — same field order, same
 * mutability — plus that instruction's handler's argument list, encoded the
 * way `#[program]` + `AnchorSerialize` encode it: an 8-byte sighash
 * discriminator followed by the Borsh-encoded args, in declaration order.
 *
 * There's no Anchor CLI available in this project's toolchain to generate a
 * real IDL (and therefore no `@coral-xyz/anchor` `Program` client) from, so
 * this hand-written layer takes its place. It's intentionally literal: every
 * builder below should be read side-by-side with its Rust counterpart.
 */
import {
  AccountMeta,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { Writer } from "./codec";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  METADATA_PROGRAM_ID,
  PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants";
import { INSTRUCTION_DISCRIMINATORS as DISC } from "./discriminators";
import { metadataPda } from "./pda";

export const FeeRecipient = { Manager: 0, Protocol: 1 } as const;
export type FeeRecipient = (typeof FeeRecipient)[keyof typeof FeeRecipient];

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey, isSigner, isWritable };
}
const w = (p: PublicKey) => meta(p, false, true); // writable, non-signer
const r = (p: PublicKey) => meta(p, false, false); // readonly, non-signer
const signerW = (p: PublicKey) => meta(p, true, true);
const signerR = (p: PublicKey) => meta(p, true, false);

/** `[asset_mint, vault]` per asset, as `create_basket` expects. */
export function createRemaining(assets: PublicKey[], vaults: PublicKey[]): AccountMeta[] {
  const out: AccountMeta[] = [];
  for (let i = 0; i < assets.length; i++) {
    out.push(w(assets[i]), w(vaults[i]));
  }
  return out;
}

/** `[asset_mint, vault, party_account]` per asset, for seed/mint/redeem/claim. */
export function legsRemaining(
  assets: PublicKey[],
  vaults: PublicKey[],
  partyAccounts: PublicKey[],
): AccountMeta[] {
  const out: AccountMeta[] = [];
  for (let i = 0; i < assets.length; i++) {
    out.push(w(assets[i]), w(vaults[i]), w(partyAccounts[i]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// initialize_config / update_protocol_terms
// ---------------------------------------------------------------------------

export function initializeConfig(args: {
  authority: PublicKey;
  config: PublicKey;
  treasury: PublicKey;
  creationFeeLamports: bigint | number;
  protocolShareBps: number;
}): TransactionInstruction {
  const [programData] = PublicKey.findProgramAddressSync(
    [PROGRAM_ID.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID,
  );
  const data = new Writer()
    .bytes(DISC.initialize_config)
    .pubkey(args.treasury)
    .u64(args.creationFeeLamports)
    .u16(args.protocolShareBps)
    .finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      signerW(args.authority),
      w(args.config),
      r(PROGRAM_ID),
      r(programData),
      r(SystemProgram.programId),
    ],
    data,
  });
}

export function updateProtocolTerms(args: {
  authority: PublicKey;
  config: PublicKey;
  treasury: PublicKey;
  creationFeeLamports: bigint | number;
  protocolShareBps: number;
}): TransactionInstruction {
  const data = new Writer()
    .bytes(DISC.update_protocol_terms)
    .pubkey(args.treasury)
    .u64(args.creationFeeLamports)
    .u16(args.protocolShareBps)
    .finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [signerR(args.authority), w(args.config)],
    data,
  });
}

// ---------------------------------------------------------------------------
// initialize_coin / update_coin_terms
// ---------------------------------------------------------------------------

export function initializeCoin(args: {
  authority: PublicKey;
  config: PublicKey;
  coinConfig: PublicKey;
  coinMint: PublicKey;
  genesisOwner: PublicKey;
  genesisAccount: PublicKey;
  burnVault: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creationFeeCoin: bigint | number;
  creationBurnBps: number;
  devTreasury: PublicKey;
}): TransactionInstruction {
  const data = new Writer()
    .bytes(DISC.initialize_coin)
    .string(args.name)
    .string(args.symbol)
    .string(args.uri)
    .u64(args.creationFeeCoin)
    .u16(args.creationBurnBps)
    .pubkey(args.devTreasury)
    .finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      signerW(args.authority),
      r(args.config),
      w(args.coinConfig),
      w(args.coinMint),
      r(args.genesisOwner),
      w(args.genesisAccount),
      w(args.burnVault),
      w(metadataPda(args.coinMint, METADATA_PROGRAM_ID)),
      r(METADATA_PROGRAM_ID),
      r(TOKEN_PROGRAM_ID),
      r(ASSOCIATED_TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
      r(SYSVAR_RENT_PUBKEY),
    ],
    data,
  });
}

export function updateCoinTerms(args: {
  authority: PublicKey;
  config: PublicKey;
  coinConfig: PublicKey;
  devTreasury: PublicKey;
  creationFeeCoin: bigint | number;
  creationBurnBps: number;
}): TransactionInstruction {
  const data = new Writer()
    .bytes(DISC.update_coin_terms)
    .pubkey(args.devTreasury)
    .u64(args.creationFeeCoin)
    .u16(args.creationBurnBps)
    .finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [signerR(args.authority), r(args.config), w(args.coinConfig)],
    data,
  });
}

export function crankBurn(args: {
  cranker: PublicKey;
  coinConfig: PublicKey;
  coinMint: PublicKey;
  burnVault: PublicKey;
}): TransactionInstruction {
  const data = new Writer().bytes(DISC.crank_burn).finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      signerR(args.cranker),
      w(args.coinConfig),
      w(args.coinMint),
      w(args.burnVault),
      r(TOKEN_PROGRAM_ID),
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// create_basket
// ---------------------------------------------------------------------------

export function createBasket(args: {
  manager: PublicKey;
  config: PublicKey;
  treasury: PublicKey;
  basket: PublicKey;
  basketMint: PublicKey;
  feeEscrow: PublicKey;
  coinConfig: PublicKey;
  coinMint: PublicKey;
  managerCoinAccount: PublicKey;
  devCoinAccount: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  mintFeeBps: number;
  redeemFeeBps: number;
  streamingFeeBps: number;
  remaining: AccountMeta[];
}): TransactionInstruction {
  const data = new Writer()
    .bytes(DISC.create_basket)
    .string(args.name)
    .string(args.symbol)
    .string(args.uri)
    .u16(args.mintFeeBps)
    .u16(args.redeemFeeBps)
    .u16(args.streamingFeeBps)
    .finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      signerW(args.manager),
      w(args.config),
      w(args.treasury),
      w(args.basket),
      w(args.basketMint),
      w(args.feeEscrow),
      w(args.coinConfig),
      w(args.coinMint),
      w(args.managerCoinAccount),
      w(args.devCoinAccount),
      w(metadataPda(args.basketMint, METADATA_PROGRAM_ID)),
      r(METADATA_PROGRAM_ID),
      r(TOKEN_PROGRAM_ID),
      r(TOKEN_2022_PROGRAM_ID),
      r(ASSOCIATED_TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
      r(SYSVAR_RENT_PUBKEY),
      ...args.remaining,
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// seed_basket / mint_basket / redeem_basket
// ---------------------------------------------------------------------------

export function seedBasket(args: {
  manager: PublicKey;
  basket: PublicKey;
  basketMint: PublicKey;
  managerBasketAccount: PublicKey;
  initialSupply: bigint | number;
  amounts: (bigint | number)[];
  remaining: AccountMeta[];
}): TransactionInstruction {
  const data = new Writer()
    .bytes(DISC.seed_basket)
    .u64(args.initialSupply)
    .vecU64(args.amounts)
    .finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      signerW(args.manager),
      w(args.basket),
      w(args.basketMint),
      w(args.managerBasketAccount),
      r(TOKEN_PROGRAM_ID),
      r(TOKEN_2022_PROGRAM_ID),
      ...args.remaining,
    ],
    data,
  });
}

export function mintBasket(args: {
  user: PublicKey;
  basket: PublicKey;
  basketMint: PublicKey;
  feeEscrow: PublicKey;
  userBasketAccount: PublicKey;
  amount: bigint | number;
  maxAmountsIn: (bigint | number)[];
  remaining: AccountMeta[];
}): TransactionInstruction {
  const data = new Writer()
    .bytes(DISC.mint_basket)
    .u64(args.amount)
    .vecU64(args.maxAmountsIn)
    .finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      signerW(args.user),
      w(args.basket),
      w(args.basketMint),
      w(args.feeEscrow),
      w(args.userBasketAccount),
      r(TOKEN_PROGRAM_ID),
      r(TOKEN_2022_PROGRAM_ID),
      ...args.remaining,
    ],
    data,
  });
}

export function redeemBasket(args: {
  user: PublicKey;
  basket: PublicKey;
  basketMint: PublicKey;
  feeEscrow: PublicKey;
  userBasketAccount: PublicKey;
  amount: bigint | number;
  minAmountsOut: (bigint | number)[];
  remaining: AccountMeta[];
}): TransactionInstruction {
  const data = new Writer()
    .bytes(DISC.redeem_basket)
    .u64(args.amount)
    .vecU64(args.minAmountsOut)
    .finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      signerW(args.user),
      w(args.basket),
      w(args.basketMint),
      w(args.feeEscrow),
      w(args.userBasketAccount),
      r(TOKEN_PROGRAM_ID),
      r(TOKEN_2022_PROGRAM_ID),
      ...args.remaining,
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// accrue_fees / claim_fees / lower_fees
// ---------------------------------------------------------------------------

/** Permissionless: no signer is named in the accounts list itself (the
 * transaction's fee payer still has to sign, just isn't one of these). */
export function accrueFees(args: {
  basket: PublicKey;
  basketMint: PublicKey;
  feeEscrow: PublicKey;
}): TransactionInstruction {
  const data = new Writer().bytes(DISC.accrue_fees).finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [w(args.basket), w(args.basketMint), w(args.feeEscrow), r(TOKEN_PROGRAM_ID)],
    data,
  });
}

export function claimFees(args: {
  claimer: PublicKey;
  config: PublicKey;
  basket: PublicKey;
  basketMint: PublicKey;
  feeEscrow: PublicKey;
  payoutBasketAccount: PublicKey;
  recipient: FeeRecipient;
  remaining: AccountMeta[];
}): TransactionInstruction {
  const data = new Writer().bytes(DISC.claim_fees).u8(args.recipient).finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      signerR(args.claimer),
      r(args.config),
      w(args.basket),
      w(args.basketMint),
      w(args.feeEscrow),
      w(args.payoutBasketAccount),
      r(TOKEN_PROGRAM_ID),
      r(TOKEN_2022_PROGRAM_ID),
      ...args.remaining,
    ],
    data,
  });
}

export function lowerFees(args: {
  manager: PublicKey;
  basket: PublicKey;
  basketMint: PublicKey;
  feeEscrow: PublicKey;
  mintFeeBps: number;
  redeemFeeBps: number;
  streamingFeeBps: number;
}): TransactionInstruction {
  const data = new Writer()
    .bytes(DISC.lower_fees)
    .u16(args.mintFeeBps)
    .u16(args.redeemFeeBps)
    .u16(args.streamingFeeBps)
    .finish();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [signerR(args.manager), w(args.basket), w(args.basketMint), w(args.feeEscrow), r(TOKEN_PROGRAM_ID)],
    data,
  });
}
