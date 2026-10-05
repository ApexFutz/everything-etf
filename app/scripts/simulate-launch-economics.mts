#!/usr/bin/env -S npx tsx
/**
 * Models what a day of basket launches does to funds and to $EETF supply.
 *
 * Every number the program actually enforces is imported rather than retyped —
 * the fee caps from constants.ts, the $5 target from pricing.ts, and the rent
 * schedule from `estimateCreateCost`, which asks the chain rather than using a
 * formula (the real rate is 5080 lamports/byte, not the 6960 you get from the
 * commonly-quoted 3480-per-byte-year figure). So this cannot drift from the
 * protocol it is modelling.
 *
 * Usage (from app/):
 *   npx tsx scripts/simulate-launch-economics.mts \
 *     [--baskets 10] [--assets 3] [--fdv 5000000] [--aum-per-basket 10000] \
 *     [--creation-fee-sol 0.1] [--burn-bps 7000] [--protocol-share-bps 1000] \
 *     [--sol-price <live>] [--url <rpc>]
 */
import { Connection } from "@solana/web3.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || !process.argv[i + 1] ? fallback : process.argv[i + 1];
}

const usd = (v: number) =>
  Math.abs(v) >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
const solFmt = (lamports: bigint) => `${(Number(lamports) / 1e9).toFixed(5)} SOL`;
const coins = (n: number) => (n >= 1 ? Math.round(n).toLocaleString("en-US") : n.toPrecision(3));
const pct = (frac: number) =>
  frac === 0 ? "0%" : frac < 0.0001 ? `${(frac * 100).toExponential(2)}%` : `${(frac * 100).toFixed(4)}%`;
const row = (label: string, ...cells: string[]) =>
  console.log(`  ${label.padEnd(44)}${cells.map((c) => c.padStart(17)).join("")}`);
const rule = (t?: string) =>
  console.log(t ? `\n${t}\n${"-".repeat(95)}` : "-".repeat(95));

async function main() {
  const url = arg("url", "https://api.devnet.solana.com");
  const baskets = Number(arg("baskets", "10"));
  const assetsPerBasket = Number(arg("assets", "3"));
  const fdv = Number(arg("fdv", "5000000"));
  const aumPerBasket = Number(arg("aum-per-basket", "10000"));
  const burnBps = Number(arg("burn-bps", "7000"));
  const protocolShareBps = Number(arg("protocol-share-bps", "1000"));
  const creationFeeSol = Number(arg("creation-fee-sol", "0.1"));

  const { estimateCreateCost } = await import("../src/lib/etf/costs.js");
  const { CREATION_FEE_USD_TARGET, fetchUsdPrice, WRAPPED_SOL_MINT } = await import(
    "../src/lib/etf/pricing.js"
  );
  const { COIN_TOTAL_SUPPLY, MAX_MINT_FEE_BPS, MAX_STREAMING_FEE_BPS } = await import(
    "../src/lib/etf/constants.js"
  );

  const livePrice = await fetchUsdPrice(WRAPPED_SOL_MINT);
  const solPrice = Number(arg("sol-price", String(livePrice ?? 150)));
  const cost = await estimateCreateCost(new Connection(url, "confirmed"), assetsPerBasket);
  const toUsd = (lamports: bigint) => (Number(lamports) / 1e9) * solPrice;

  const supply = Number(COIN_TOTAL_SUPPLY / 1_000_000_000n); // whole coins
  const coinPrice = fdv / supply;
  const feeUsd = CREATION_FEE_USD_TARGET;
  const burnShare = burnBps / 10_000;
  const feeCoins = feeUsd / coinPrice;

  rule("ASSUMPTIONS");
  row("$EETF supply (fixed, never minted again)", `${coins(supply)}`);
  row("$EETF fully-diluted valuation", usd(fdv));
  row("  implied price per coin", `$${coinPrice.toPrecision(3)}`);
  row("Launch fee", usd(feeUsd), `${coins(feeCoins)} EETF`);
  row("  burned / to dev", `${burnBps / 100}%`, `${(10_000 - burnBps) / 100}%`);
  row("SOL creation fee", `${creationFeeSol} SOL`);
  row("SOL price", usd(solPrice), livePrice ? "(live)" : "(assumed)");
  row("Baskets launched", String(baskets), `${assetsPerBasket} assets each`);
  row("Assumed AUM per basket", usd(aumPerBasket));
  row("Mint fee / streaming fee", `${MAX_MINT_FEE_BPS / 100}%`, `${MAX_STREAMING_FEE_BPS / 100}%/yr`);

  // -------------------------------------------------------------- one launch
  const creationFeeLamports = BigInt(Math.round(creationFeeSol * 1e9));
  const totalSolLamports = creationFeeLamports + cost.rentLamports + cost.networkFeeLamports;

  rule("WHAT ONE LAUNCH COSTS, AND WHERE IT GOES");
  console.log(`  ${"".padEnd(44)}${"amount".padStart(17)}${"in USD".padStart(17)}${"ends up".padStart(17)}`);
  rule();
  for (const l of cost.lines) {
    row(l.label, solFmt(l.lamports), usd(toUsd(l.lamports)), "locked in rent");
  }
  row("Network fees", solFmt(cost.networkFeeLamports), usd(toUsd(cost.networkFeeLamports)), "validators");
  row("Protocol fee", solFmt(creationFeeLamports), usd(toUsd(creationFeeLamports)), "treasury");
  rule();
  row("SOL out of pocket", solFmt(totalSolLamports), usd(toUsd(totalSolLamports)));
  row("  recoverable if accounts close", solFmt(cost.rentLamports), usd(toUsd(cost.rentLamports)));
  row("$EETF burned", `${coins(feeCoins * burnShare)}`, usd(feeUsd * burnShare), "destroyed");
  row("$EETF to dev treasury", `${coins(feeCoins * (1 - burnShare))}`, usd(feeUsd * (1 - burnShare)), "dev wallet");
  rule();
  row("Real cost to the manager", "", usd(toUsd(totalSolLamports - cost.rentLamports) + feeUsd));

  // ----------------------------------------------------------------- day one
  const b = baskets;
  const daySol = totalSolLamports * BigInt(b);
  const dayTreasury = creationFeeLamports * BigInt(b);
  const dayRent = cost.rentLamports * BigInt(b);
  const burnedCoins = feeCoins * burnShare * b;
  const devCoins = feeCoins * (1 - burnShare) * b;
  const dayRevenue = toUsd(dayTreasury) + feeUsd * (1 - burnShare) * b;

  rule(`DAY ONE - ${b} BASKETS LAUNCHED`);
  row("Managers pay, all in", solFmt(daySol), usd(toUsd(daySol)));
  row("  to protocol treasury (SOL)", solFmt(dayTreasury), usd(toUsd(dayTreasury)));
  row("  locked as account rent", solFmt(dayRent), usd(toUsd(dayRent)));
  row("$EETF spent by managers", `${coins(feeCoins * b)}`, usd(feeUsd * b));
  row("  burned", `${coins(burnedCoins)}`, usd(feeUsd * burnShare * b));
  row("  to dev treasury", `${coins(devCoins)}`, usd(feeUsd * (1 - burnShare) * b));
  rule();
  row("Protocol + dev revenue, day one", "", usd(dayRevenue));
  row("  annualised at this rate", "", usd(dayRevenue * 365));

  // ------------------------------------------------------------------ supply
  rule("SUPPLY IMPACT");
  row("Supply before", `${coins(supply)} EETF`);
  row("Burned today", `${coins(burnedCoins)} EETF`, pct(burnedCoins / supply));
  row("Supply after", `${coins(supply - burnedCoins)} EETF`);
  console.log();
  console.log("  Share of supply burned per launch = (fee x burn share) / FDV.");
  console.log("  Supply cancels out of that expression. The burn is fixed in DOLLARS,");
  console.log("  so the share of supply it retires is set entirely by the valuation —");
  console.log("  and shrinks as the valuation rises.");
  console.log();
  console.log(
    `  ${"FDV".padStart(14)}${"price/coin".padStart(14)}${"EETF per launch".padStart(18)}${"burned/day".padStart(16)}${"% of supply/day".padStart(18)}`,
  );
  rule();
  for (const f of [50_000, 500_000, 5_000_000, 50_000_000, 500_000_000]) {
    const p = f / supply;
    const c = feeUsd / p;
    const burned = c * burnShare * b;
    console.log(
      `  ${usd(f).padStart(14)}${`$${p.toPrecision(3)}`.padStart(14)}${coins(c).padStart(18)}${coins(burned).padStart(16)}${pct(burned / supply).padStart(18)}`,
    );
  }

  // ------------------------------------------------------------------ runway
  rule("BURN RUNWAY");
  console.log(`  Sustained ${b} launches/day, holding FDV constant.\n`);
  console.log(
    `  ${"FDV".padStart(14)}${"1% of supply".padStart(18)}${"10% of supply".padStart(18)}${"50% of supply".padStart(18)}`,
  );
  rule();
  for (const f of [50_000, 500_000, 5_000_000, 50_000_000]) {
    const perDay = (feeUsd * burnShare * b) / f;
    const t = (target: number) => {
      const d = target / perDay;
      return d > 3650 ? `${Math.round(d / 365)} yr` : d > 365 ? `${(d / 365).toFixed(1)} yr` : `${Math.round(d)} d`;
    };
    console.log(`  ${usd(f).padStart(14)}${t(0.01).padStart(18)}${t(0.1).padStart(18)}${t(0.5).padStart(18)}`);
  }

  // --------------------------------------------------------------- recurring
  const totalAum = aumPerBasket * b;
  const streamingYr = totalAum * (MAX_STREAMING_FEE_BPS / 10_000);
  const mintFees = totalAum * (MAX_MINT_FEE_BPS / 10_000);
  const protoShare = protocolShareBps / 10_000;

  rule("RECURRING FEES, ONCE THOSE BASKETS EXIST");
  row("Combined AUM", usd(totalAum));
  row("Streaming fees / year", usd(streamingYr));
  row("  to managers", usd(streamingYr * (1 - protoShare)));
  row("  to protocol", usd(streamingYr * protoShare));
  row("Mint fees per 1x AUM minted", usd(mintFees));
  row("  to protocol", usd(mintFees * protoShare));
  row("Redeem fees", usd(0), "always free");
  rule();
  row("Protocol take / year", "", usd(streamingYr * protoShare + mintFees * protoShare));
  console.log();
  console.log("  Paid in basket tokens and underlyings, not SOL. Converting that to");
  console.log("  $EETF and sending it to the burn vault is an off-chain policy step —");
  console.log("  the program does not enforce it.");
  rule();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
