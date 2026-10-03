/**
 * High-level helpers: fetch + decode program state, and assemble complete,
 * ready-to-sign transactions for each user action. Each `*Tx` function
 * returns a plain array of instructions (not a signed Transaction) so the
 * caller can add compute-budget bumps, a priority fee, etc. before sending.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Basket, Config, CoinConfig, decodeBasket, decodeConfig, decodeCoinConfig } from "./accounts";
import { ACCOUNT_DISCRIMINATORS } from "./discriminators";
import * as ix from "./instructions";
import {
  basketMintPda,
  basketPda,
  burnVaultAta,
  coinConfigPda,
  coinMintPda,
  configPda,
  feeEscrowAta,
} from "./pda";
import { PROGRAM_ID } from "./constants";

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function fetchConfig(connection: Connection): Promise<Config | null> {
  const info = await connection.getAccountInfo(configPda()[0]);
  return info ? decodeConfig(info.data) : null;
}

export async function fetchCoinConfig(connection: Connection): Promise<CoinConfig | null> {
  const info = await connection.getAccountInfo(coinConfigPda()[0]);
  return info ? decodeCoinConfig(info.data) : null;
}

export interface BasketWithKey extends Basket {
  pubkey: PublicKey;
}

/** Every basket the program has ever created, newest first. */
export async function listBaskets(connection: Connection): Promise<BasketWithKey[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58(ACCOUNT_DISCRIMINATORS.Basket) } }],
  });
  const baskets = accounts.map((a) => ({ pubkey: a.pubkey, ...decodeBasket(a.account.data) }));
  baskets.sort((a, b) => Number(b.id - a.id));
  return baskets;
}

export async function fetchBasketById(
  connection: Connection,
  id: bigint | number,
): Promise<BasketWithKey | null> {
  const [pubkey] = basketPda(id);
  const info = await connection.getAccountInfo(pubkey);
  return info ? { pubkey, ...decodeBasket(info.data) } : null;
}

/** Each asset's current vault balance, in the basket's asset order. */
export async function fetchVaultBalances(
  connection: Connection,
  basket: PublicKey,
  assets: PublicKey[],
): Promise<bigint[]> {
  const vaults = assets.map((m) => getAssociatedTokenAddressSync(m, basket, true));
  const accounts = await Promise.all(vaults.map((v) => getAccount(connection, v)));
  return accounts.map((a) => a.amount);
}

function bs58(bytes: readonly number[]): string {
  // base58-encode a short byte array for the memcmp filter; avoids pulling
  // in a base58 dependency just for this.
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // leading zero bytes -> leading '1's
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros++;
    else break;
  }
  return (
    ALPHABET[0].repeat(leadingZeros) +
    digits
      .reverse()
      .map((d) => ALPHABET[d])
      .join("")
  );
}

// ---------------------------------------------------------------------------
// asset legs: resolving each underlying's vault + the caller's own ATA
// ---------------------------------------------------------------------------

/**
 * For each asset mint, derives the basket's vault and the party's ATA, and
 * (if `ensureAta`) prepends an idempotent create instruction for the party's
 * ATA so the caller doesn't need to create it themselves first.
 */
function resolveLegs(
  basket: PublicKey,
  assets: PublicKey[],
  partyOwner: PublicKey,
  payer: PublicKey,
  ensureAta: boolean,
): { pre: ReturnType<typeof createAssociatedTokenAccountIdempotentInstruction>[]; vaults: PublicKey[]; partyAccounts: PublicKey[] } {
  const vaults = assets.map((m) => getAssociatedTokenAddressSync(m, basket, true));
  const partyAccounts = assets.map((m) => getAssociatedTokenAddressSync(m, partyOwner));
  const pre = ensureAta
    ? assets.map((m, i) =>
        createAssociatedTokenAccountIdempotentInstruction(payer, partyAccounts[i], partyOwner, m),
      )
    : [];
  return { pre, vaults, partyAccounts };
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

export function initializeConfigTx(args: {
  authority: PublicKey;
  treasury: PublicKey;
  creationFeeLamports: bigint | number;
  protocolShareBps: number;
}) {
  return [
    ix.initializeConfig({
      authority: args.authority,
      config: configPda()[0],
      treasury: args.treasury,
      creationFeeLamports: args.creationFeeLamports,
      protocolShareBps: args.protocolShareBps,
    }),
  ];
}

export function updateProtocolTermsTx(args: {
  authority: PublicKey;
  treasury: PublicKey;
  creationFeeLamports: bigint | number;
  protocolShareBps: number;
}) {
  return [
    ix.updateProtocolTerms({
      authority: args.authority,
      config: configPda()[0],
      treasury: args.treasury,
      creationFeeLamports: args.creationFeeLamports,
      protocolShareBps: args.protocolShareBps,
    }),
  ];
}

export function initializeCoinTx(args: {
  authority: PublicKey;
  genesisOwner: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creationFeeCoin: bigint | number;
  creationBurnBps: number;
  devTreasury: PublicKey;
}) {
  const [coinConfig] = coinConfigPda();
  const [coinMint] = coinMintPda();
  return [
    ix.initializeCoin({
      authority: args.authority,
      config: configPda()[0],
      coinConfig,
      coinMint,
      genesisOwner: args.genesisOwner,
      genesisAccount: getAssociatedTokenAddressSync(coinMint, args.genesisOwner),
      burnVault: burnVaultAta(coinConfig, coinMint),
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
      creationFeeCoin: args.creationFeeCoin,
      creationBurnBps: args.creationBurnBps,
      devTreasury: args.devTreasury,
    }),
  ];
}

export function updateCoinTermsTx(args: {
  authority: PublicKey;
  devTreasury: PublicKey;
  creationFeeCoin: bigint | number;
  creationBurnBps: number;
}) {
  return [
    ix.updateCoinTerms({
      authority: args.authority,
      config: configPda()[0],
      coinConfig: coinConfigPda()[0],
      devTreasury: args.devTreasury,
      creationFeeCoin: args.creationFeeCoin,
      creationBurnBps: args.creationBurnBps,
    }),
  ];
}

export function crankBurnTx(args: { cranker: PublicKey }) {
  const [coinConfig] = coinConfigPda();
  const [coinMint] = coinMintPda();
  return [
    ix.crankBurn({
      cranker: args.cranker,
      coinConfig,
      coinMint,
      burnVault: burnVaultAta(coinConfig, coinMint),
    }),
  ];
}

/** `basketCount` is the live `config.basketCount` — the new basket's id. */
export function createBasketTx(args: {
  manager: PublicKey;
  treasury: PublicKey;
  devTreasury: PublicKey;
  basketCount: bigint;
  assets: PublicKey[];
  name: string;
  symbol: string;
  uri: string;
  mintFeeBps: number;
  redeemFeeBps: number;
  streamingFeeBps: number;
}) {
  const [coinConfig] = coinConfigPda();
  const [coinMint] = coinMintPda();
  const [basket] = basketPda(args.basketCount);
  const [basketMint] = basketMintPda(basket);
  const feeEscrow = feeEscrowAta(basket, basketMint);
  const managerCoinAccount = getAssociatedTokenAddressSync(coinMint, args.manager);
  const devCoinAccount = getAssociatedTokenAddressSync(coinMint, args.devTreasury);
  const vaults = args.assets.map((m) => getAssociatedTokenAddressSync(m, basket, true));

  // create_basket requires both $EETF accounts to already exist — it
  // doesn't create either itself. Idempotent-create covers the manager's
  // (who's paying) and, in case nobody's set it up yet, the dev treasury's.
  const pre = [
    createAssociatedTokenAccountIdempotentInstruction(args.manager, managerCoinAccount, args.manager, coinMint),
    createAssociatedTokenAccountIdempotentInstruction(args.manager, devCoinAccount, args.devTreasury, coinMint),
  ];

  const main = ix.createBasket({
    manager: args.manager,
    config: configPda()[0],
    treasury: args.treasury,
    basket,
    basketMint,
    feeEscrow,
    coinConfig,
    coinMint,
    managerCoinAccount,
    devCoinAccount,
    name: args.name,
    symbol: args.symbol,
    uri: args.uri,
    mintFeeBps: args.mintFeeBps,
    redeemFeeBps: args.redeemFeeBps,
    streamingFeeBps: args.streamingFeeBps,
    remaining: ix.createRemaining(args.assets, vaults),
  });
  return { instructions: [...pre, main], basket, basketMint };
}

export function seedBasketTx(args: {
  manager: PublicKey;
  basket: PublicKey;
  basketMint: PublicKey;
  assets: PublicKey[];
  initialSupply: bigint | number;
  amounts: (bigint | number)[];
}) {
  const managerBasketAccount = getAssociatedTokenAddressSync(args.basketMint, args.manager);
  const { pre, vaults, partyAccounts } = resolveLegs(
    args.basket,
    args.assets,
    args.manager,
    args.manager,
    true,
  );
  const createManagerBasketAta = createAssociatedTokenAccountIdempotentInstruction(
    args.manager,
    managerBasketAccount,
    args.manager,
    args.basketMint,
  );
  const main = ix.seedBasket({
    manager: args.manager,
    basket: args.basket,
    basketMint: args.basketMint,
    managerBasketAccount,
    initialSupply: args.initialSupply,
    amounts: args.amounts,
    remaining: ix.legsRemaining(args.assets, vaults, partyAccounts),
  });
  return [...pre, createManagerBasketAta, main];
}

export function mintBasketTx(args: {
  user: PublicKey;
  basket: PublicKey;
  basketMint: PublicKey;
  feeEscrow: PublicKey;
  assets: PublicKey[];
  amount: bigint | number;
  maxAmountsIn: (bigint | number)[];
}) {
  const userBasketAccount = getAssociatedTokenAddressSync(args.basketMint, args.user);
  const { pre, vaults, partyAccounts } = resolveLegs(args.basket, args.assets, args.user, args.user, true);
  const createUserBasketAta = createAssociatedTokenAccountIdempotentInstruction(
    args.user,
    userBasketAccount,
    args.user,
    args.basketMint,
  );
  const main = ix.mintBasket({
    user: args.user,
    basket: args.basket,
    basketMint: args.basketMint,
    feeEscrow: args.feeEscrow,
    userBasketAccount,
    amount: args.amount,
    maxAmountsIn: args.maxAmountsIn,
    remaining: ix.legsRemaining(args.assets, vaults, partyAccounts),
  });
  return [...pre, createUserBasketAta, main];
}

export function redeemBasketTx(args: {
  user: PublicKey;
  basket: PublicKey;
  basketMint: PublicKey;
  feeEscrow: PublicKey;
  assets: PublicKey[];
  amount: bigint | number;
  minAmountsOut: (bigint | number)[];
}) {
  const userBasketAccount = getAssociatedTokenAddressSync(args.basketMint, args.user);
  // The user's asset ATAs should already exist (they're receiving into
  // them), but idempotent-create is a no-op if so and saves a failed tx if not.
  const { pre, vaults, partyAccounts } = resolveLegs(args.basket, args.assets, args.user, args.user, true);
  const main = ix.redeemBasket({
    user: args.user,
    basket: args.basket,
    basketMint: args.basketMint,
    feeEscrow: args.feeEscrow,
    userBasketAccount,
    amount: args.amount,
    minAmountsOut: args.minAmountsOut,
    remaining: ix.legsRemaining(args.assets, vaults, partyAccounts),
  });
  return [...pre, main];
}

export function claimFeesTx(args: {
  claimer: PublicKey;
  basket: PublicKey;
  basketMint: PublicKey;
  feeEscrow: PublicKey;
  assets: PublicKey[];
  payoutOwner: PublicKey;
  recipient: ix.FeeRecipient;
}) {
  const payoutBasketAccount = getAssociatedTokenAddressSync(args.basketMint, args.payoutOwner);
  const { pre, vaults, partyAccounts } = resolveLegs(
    args.basket,
    args.assets,
    args.payoutOwner,
    args.claimer,
    true,
  );
  const createPayoutBasketAta = createAssociatedTokenAccountIdempotentInstruction(
    args.claimer,
    payoutBasketAccount,
    args.payoutOwner,
    args.basketMint,
  );
  const main = ix.claimFees({
    claimer: args.claimer,
    config: configPda()[0],
    basket: args.basket,
    basketMint: args.basketMint,
    feeEscrow: args.feeEscrow,
    payoutBasketAccount,
    recipient: args.recipient,
    remaining: ix.legsRemaining(args.assets, vaults, partyAccounts),
  });
  return [...pre, createPayoutBasketAta, main];
}

export function lowerFeesTx(args: {
  manager: PublicKey;
  basket: PublicKey;
  basketMint: PublicKey;
  feeEscrow: PublicKey;
  mintFeeBps: number;
  redeemFeeBps: number;
  streamingFeeBps: number;
}) {
  return [
    ix.lowerFees({
      manager: args.manager,
      basket: args.basket,
      basketMint: args.basketMint,
      feeEscrow: args.feeEscrow,
      mintFeeBps: args.mintFeeBps,
      redeemFeeBps: args.redeemFeeBps,
      streamingFeeBps: args.streamingFeeBps,
    }),
  ];
}

export function accrueFeesTx(args: { basket: PublicKey; basketMint: PublicKey; feeEscrow: PublicKey }) {
  return [ix.accrueFees(args)];
}

export { PROGRAM_ID };
