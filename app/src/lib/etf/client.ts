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

export interface BasketPage {
  baskets: BasketWithKey[];
  /** Pass as `before` to fetch the next (older) page; null once exhausted. */
  nextBefore: bigint | null;
}

/**
 * One page of baskets, newest first, `pageSize` at a time. Rather than one
 * `getProgramAccounts` scanning every Basket account on the program (which
 * won't scale — large/slow responses, and most RPC providers cap or heavily
 * rate-limit that call), basket ids are sequential (0..config.basketCount),
 * so this derives each page's PDAs directly and fetches them in one batched
 * `getMultipleAccountsInfo` call.
 *
 * Pass `before` (from a previous page's `nextBefore`) to continue older;
 * omit it to start from the newest basket.
 */
export async function listBasketsPage(
  connection: Connection,
  opts: { before?: bigint; pageSize?: number } = {},
): Promise<BasketPage> {
  const pageSize = opts.pageSize ?? 10;
  const config = await fetchConfig(connection);
  if (!config || config.basketCount === 0n) {
    return { baskets: [], nextBefore: null };
  }

  const highestId = opts.before !== undefined ? opts.before - 1n : config.basketCount - 1n;
  if (highestId < 0n) {
    return { baskets: [], nextBefore: null };
  }

  const ids: bigint[] = [];
  for (let id = highestId; id >= 0n && ids.length < pageSize; id--) {
    ids.push(id);
  }

  const pubkeys = ids.map((id) => basketPda(id)[0]);
  const infos = await connection.getMultipleAccountsInfo(pubkeys);
  const baskets = infos
    .map((info, i) => (info ? { pubkey: pubkeys[i], ...decodeBasket(info.data) } : null))
    .filter((b): b is BasketWithKey => b !== null);

  const lastFetchedId = ids[ids.length - 1];
  const nextBefore = lastFetchedId > 0n ? lastFetchedId : null;
  return { baskets, nextBefore };
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
