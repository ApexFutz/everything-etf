#!/usr/bin/env -S npx tsx
/**
 * Launches a real basket on devnet, end to end, using the same TS client the
 * web app uses: mints a few test tokens, creates the basket, seeds it, then
 * mints and redeems against it.
 *
 * Point of this is twofold — it gives the UI something real to display, and
 * it exercises createBasketTx/seedBasketTx/mintBasketTx/redeemBasketTx
 * against the deployed program rather than only against litesvm.
 *
 * Usage (from app/):
 *   npx tsx scripts/demo-basket-devnet.mts \
 *     --program-id <pubkey> --manager ../keys/devnet-admin.json \
 *     [--name "Frog Basket"] [--symbol FROG] [--url <rpc>]
 */
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required --${name}`);
  }
  return process.argv[i + 1];
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf-8"))));
}

async function main() {
  const programId = arg("program-id");
  const url = arg("url", "https://api.devnet.solana.com");
  const name = arg("name", "Frog Basket");
  const symbol = arg("symbol", "FROG");
  process.env.NEXT_PUBLIC_ETF_PROGRAM_ID = programId;

  const {
    createBasketTx,
    seedBasketTx,
    mintBasketTx,
    redeemBasketTx,
    fetchConfig,
    fetchCoinConfig,
    fetchBasketById,
    fetchVaultBalances,
  } = await import("../src/lib/etf/client.js");
  const { createAndFundTestMints } = await import("../src/lib/etf/devHelpers.js");
  const { BASKET_DECIMALS } = await import("../src/lib/etf/constants.js");
  const { formatTokens } = await import("../src/lib/format.js");
  const { quoteMintDeposits } = await import("../src/lib/etf/quote.js");

  const manager = loadKeypair(arg("manager"));
  const connection = new Connection(url, "confirmed");

  const send = async (ixs: TransactionInstruction[], signers: Keypair[] = []) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [manager, ...signers]);

  const config = await fetchConfig(connection);
  const coinConfig = await fetchCoinConfig(connection);
  if (!config || !coinConfig) throw new Error("protocol not initialized — run initialize-devnet.mts");

  console.log(`manager: ${manager.publicKey.toBase58()}`);
  console.log(`basket will be #${config.basketCount}\n`);

  // 1. Three test tokens to build the basket out of.
  console.log("1/5  minting test tokens…");
  const { instructions: mintIxs, mints } = await createAndFundTestMints(
    connection,
    manager.publicKey,
    manager.publicKey,
    3,
  );
  console.log(`     ${await send(mintIxs, mints)}`);
  const assets = mints.map((m) => m.publicKey);
  assets.forEach((a) => console.log(`     ${a.toBase58()}`));

  // 2. Create the basket.
  console.log("\n2/5  create_basket…");
  const basketCount = config.basketCount;
  const { instructions, basket, basketMint } = createBasketTx({
    manager: manager.publicKey,
    treasury: config.treasury,
    devTreasury: coinConfig.devTreasury,
    basketCount,
    assets,
    name,
    symbol,
    uri: "",
    // All three caps are zero in the program: baskets charge nothing.
    mintFeeBps: 0,
    redeemFeeBps: 0,
    streamingFeeBps: 0,
  });
  console.log(`     ${await send(instructions)}`);
  console.log(`     basket ${basket.toBase58()}`);
  console.log(`     mint   ${basketMint.toBase58()}`);

  // 3. Seed it — the manager's "initial buy".
  console.log("\n3/5  seed_basket (initial buy)…");
  const unit = 10n ** 9n; // test mints are 9 decimals
  console.log(
    `     ${await send(
      seedBasketTx({
        manager: manager.publicKey,
        basket,
        basketMint,
        assets,
        initialSupply: 1_000_000n * 10n ** BigInt(BASKET_DECIMALS),
        amounts: assets.map(() => 1_000n * unit),
      }),
    )}`,
  );

  // 4. Mint more at NAV, quoting deposits the way the UI does.
  console.log("\n4/5  mint_basket (buy 1,000 more)…");
  const amount = 1_000n * 10n ** BigInt(BASKET_DECIMALS);
  const vaults = await fetchVaultBalances(connection, basket, assets);
  const supply = 1_000_000n * 10n ** BigInt(BASKET_DECIMALS);
  const { quoted, maxAmountsIn } = quoteMintDeposits(vaults, amount, supply, 0.01);
  console.log(`     quoted deposit per asset: ${quoted.map((q) => formatTokens(q, 9)).join(", ")}`);
  console.log(
    `     ${await send(
      mintBasketTx({
        user: manager.publicKey,
        basket,
        basketMint,
        feeEscrow: (await fetchBasketById(connection, basketCount))!.feeEscrow,
        assets,
        amount,
        maxAmountsIn,
      }),
    )}`,
  );

  // 5. Redeem half of it back.
  console.log("\n5/5  redeem_basket (sell 500 back)…");
  console.log(
    `     ${await send(
      redeemBasketTx({
        user: manager.publicKey,
        basket,
        basketMint,
        feeEscrow: (await fetchBasketById(connection, basketCount))!.feeEscrow,
        assets,
        amount: 500n * 10n ** BigInt(BASKET_DECIMALS),
        minAmountsOut: assets.map(() => 0n),
      }),
    )}`,
  );

  const final = await fetchBasketById(connection, basketCount);
  const finalVaults = await fetchVaultBalances(connection, basket, assets);
  console.log(`\nBasket #${basketCount} live:`);
  console.log(`  vaults:        ${finalVaults.map((v) => formatTokens(v, 9)).join(", ")}`);
  console.log(`  manager fees:  ${formatTokens(final!.managerFeesAccrued, BASKET_DECIMALS)}`);
  console.log(`  protocol fees: ${formatTokens(final!.protocolFeesAccrued, BASKET_DECIMALS)}`);
  console.log(`\n  http://localhost:3000/baskets/${basketCount}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
