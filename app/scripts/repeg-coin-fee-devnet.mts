#!/usr/bin/env -S npx tsx
/**
 * Re-pegs the $EETF basket-creation fee to its dollar target (~$15).
 *
 * The program stores the fee as a fixed number of $EETF base units, so the
 * dollar cost of launching a basket moves with the $EETF price unless somebody
 * re-quotes it. This is that somebody: it reads the live price, works out what
 * $15 of $EETF is, and sends `update_coin_terms` if the on-chain amount has
 * drifted past the tolerance. Run it on a schedule.
 *
 * $EETF has no market until it trades, so before launch there is no price to
 * read and `--eetf-price` must be given explicitly. Note what the target
 * implies: at a $50k fully-diluted valuation (1B supply, $0.00005/coin) $15 is
 * 300,000 EETF; at $5M FDV it's 3,000 EETF. The fee amount is a function of
 * the valuation, which is exactly why it can't be a constant.
 *
 * Usage (from app/):
 *   npx tsx scripts/repeg-coin-fee-devnet.mts \
 *     --program-id <pubkey> --admin ../keys/devnet-admin.json \
 *     [--eetf-price 0.00005] [--target-usd 15] [--dry-run] [--url <rpc>]
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required --${name}`);
  }
  return process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const programId = arg("program-id");
  const url = arg("url", "https://api.devnet.solana.com");
  const dryRun = flag("dry-run");
  process.env.NEXT_PUBLIC_ETF_PROGRAM_ID = programId;

  const { fetchCoinConfig, updateCoinTermsTx } = await import("../src/lib/etf/client.js");
  const { COIN_DECIMALS } = await import("../src/lib/etf/constants.js");
  const { formatTokens } = await import("../src/lib/format.js");
  const {
    CREATION_FEE_USD_TARGET,
    REPEG_TOLERANCE,
    coinAmountForUsd,
    fetchUsdPrice,
    impliedPriceForTarget,
    usdValueOfCoin,
  } = await import("../src/lib/etf/pricing.js");

  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(arg("admin"), "utf-8"))),
  );
  const connection = new Connection(url, "confirmed");
  const targetUsd = Number(arg("target-usd", String(CREATION_FEE_USD_TARGET)));

  const coinConfig = await fetchCoinConfig(connection);
  if (!coinConfig) throw new Error("coin not initialized — run initialize-devnet.mts first");

  // An explicit --eetf-price wins, so the peg can be set before $EETF trades
  // and so a thin, manipulable market can be overridden by hand.
  const override = process.argv.includes("--eetf-price")
    ? Number(arg("eetf-price"))
    : null;
  const price = override ?? (await fetchUsdPrice(coinConfig.mint.toBase58()));
  if (!price) {
    throw new Error(
      "no $EETF price available (it has no market yet) — pass --eetf-price explicitly",
    );
  }

  const current = coinConfig.creationFeeCoin;
  const currentUsd = usdValueOfCoin(current, price);
  const desired = coinAmountForUsd(targetUsd, price);
  const drift = Math.abs(currentUsd - targetUsd) / targetUsd;

  console.log(`$EETF price:   $${price.toPrecision(6)}${override ? " (override)" : " (Jupiter)"}`);
  console.log(`target:        $${targetUsd.toFixed(2)} per basket launch`);
  console.log(
    `on-chain fee:  ${formatTokens(current, COIN_DECIMALS)} EETF  ≈ $${currentUsd.toFixed(2)}`,
  );
  console.log(`implied peg:   $${impliedPriceForTarget(current, targetUsd).toPrecision(6)} / EETF`);
  console.log(
    `would be:      ${formatTokens(desired, COIN_DECIMALS)} EETF  (drift ${(drift * 100).toFixed(1)}%)`,
  );

  if (drift <= REPEG_TOLERANCE) {
    console.log(`\nwithin ${(REPEG_TOLERANCE * 100).toFixed(0)}% tolerance — nothing to do.`);
    return;
  }
  if (desired === current) {
    console.log("\nalready at the right amount — nothing to do.");
    return;
  }
  if (dryRun) {
    console.log("\n--dry-run: not sending.");
    return;
  }

  // The burn share is passed through unchanged; this script only moves the fee.
  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ...updateCoinTermsTx({
        authority: admin.publicKey,
        devTreasury: coinConfig.devTreasury,
        creationFeeCoin: desired,
        creationBurnBps: coinConfig.creationBurnBps,
      }),
    ),
    [admin],
  );
  console.log(`\nre-pegged: ${sig}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
