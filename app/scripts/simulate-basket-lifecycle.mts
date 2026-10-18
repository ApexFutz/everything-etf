#!/usr/bin/env -S npx tsx
/**
 * Models what a per-basket fee would earn across a basket's whole life.
 *
 * NOTE: the protocol charges no per-basket fees. Every cap in constants.rs is
 * zero — minting, holding and redeeming are free, and the one-time launch fee is
 * the only fee that exists. This script exists to inform whether that should
 * ever change, so its rates are flags (--mint-fee-bps, --streaming-fee-bps)
 * rather than imported constants.
 *
 * The thing this exists to make visible: **trading volume is not fee volume.**
 *
 *  - Secondary trading of the basket token on a DEX pays the protocol nothing.
 *    The LPs earn that; the program never sees it.
 *  - Trading volume in the underlying coins pays the protocol nothing either.
 *    A basket holding a viral coin earns from holding it, not from its volume.
 *
 * Only two things actually pay:
 *
 *  - the **streaming fee**, charged on AUM over TIME, so what matters is the
 *    integral of AUM (dollar-years), not the peak; and
 *  - the **mint fee**, charged on primary creation FLOW — genuine inflows plus
 *    the arbitrage minting that keeps the basket near NAV.
 *
 * That split drives the result. A viral memecoin basket is a spike with a short
 * half-life: it has lots of flow and very little time, so the mint fee earns
 * far more over its life than the streaming fee does, even though the streaming
 * rate is double. A boring index that sits for three years is the reverse.
 *
 * Every assumption here is a guess about market behaviour and is printed as
 * such. The ratios between the lines are the robust part, not the absolutes.
 *
 * Usage (from app/):
 *   npx tsx scripts/simulate-basket-lifecycle.mts \
 *     [--peak-aum 1000000] [--seed-aum 10000] [--ramp-days 14] \
 *     [--half-life-days 42] [--creation-multiple 2.5] [--viral-rate 0.05] \
 *     [--launches-per-day 10] [--fdv 5000000] [--sol-price <live>]  *     [--mint-fee-bps 25] [--streaming-fee-bps 50] [--protocol-share-bps 1000]
 */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || !process.argv[i + 1] ? fallback : process.argv[i + 1];
}

const usd = (v: number) =>
  Math.abs(v) >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
const pct = (f: number) =>
  f === 0 ? "0%" : Math.abs(f) < 0.0001 ? `${(f * 100).toExponential(2)}%` : `${(f * 100).toFixed(3)}%`;
const row = (label: string, ...cells: string[]) =>
  console.log(`  ${label.padEnd(42)}${cells.map((c) => c.padStart(16)).join("")}`);
const rule = (t?: string) => console.log(t ? `\n${t}\n${"-".repeat(90)}` : "-".repeat(90));

/**
 * Dollar-years of AUM over a basket's life: a linear ramp from seed to peak,
 * then exponential decay. This integral is what the streaming fee is charged
 * on, and it's the number that peak AUM badly overstates.
 */
function dollarYears(seed: number, peak: number, rampDays: number, halfLifeDays: number): number {
  const ramp = ((seed + peak) / 2) * rampDays;
  const decay = peak * (halfLifeDays / Math.LN2); // integral of peak*e^(-lambda t)
  return (ramp + decay) / 365;
}

async function main() {
  const peakAum = Number(arg("peak-aum", "1000000"));
  const seedAum = Number(arg("seed-aum", "10000"));
  const rampDays = Number(arg("ramp-days", "14"));
  const halfLifeDays = Number(arg("half-life-days", "42"));
  const creationMultiple = Number(arg("creation-multiple", "2.5"));
  const viralRate = Number(arg("viral-rate", "0.05"));
  const launchesPerDay = Number(arg("launches-per-day", "10"));
  const fdv = Number(arg("fdv", "5000000"));

  const { CREATION_FEE_USD_TARGET, fetchUsdPrice, WRAPPED_SOL_MINT } = await import(
    "../src/lib/etf/pricing.js"
  );

  const livePrice = await fetchUsdPrice(WRAPPED_SOL_MINT);
  const solPrice = Number(arg("sol-price", String(livePrice ?? 150)));
  // Hypothetical rates. The protocol charges NONE of these today — every
  // per-basket fee cap is zero in constants.rs, so this models what a fee would
  // earn if one were ever added, not what anyone is paid now.
  const mintRate = Number(arg("mint-fee-bps", "25")) / 10_000;
  const streamRate = Number(arg("streaming-fee-bps", "50")) / 10_000;
  const protoShare = Number(arg("protocol-share-bps", "1000")) / 10_000;
  const solFeeUsd = 0.1 * solPrice;

  rule("HYPOTHETICAL — the protocol charges no per-basket fees today");
  console.log("  Every fee cap in constants.rs is zero: minting, holding and redeeming are");
  console.log("  free. This models what a fee WOULD earn if one were added, to inform that");
  console.log("  decision. Market behaviour below is guessed, not derived.");
  console.log();
  row("Peak AUM, a basket that catches", usd(peakAum));
  row("Seed AUM (manager's initial buy)", usd(seedAum));
  row("Days to peak, then decay half-life", `${rampDays} d`, `${halfLifeDays} d`);
  row("Cumulative creation flow", `${creationMultiple}x peak`, usd(creationMultiple * peakAum));
  row("Share of baskets that catch", pct(viralRate));
  row("Launches per day", String(launchesPerDay));
  row("Fee schedule", `mint ${mintRate * 100}%`, `stream ${streamRate * 100}%/yr`);
  row("Redeem fee", "0%", "always free");
  row("Protocol share of fees", pct(protoShare));
  row("$EETF FDV", usd(fdv));

  // ----------------------------------------------------- one basket that hits
  const viralYears = dollarYears(seedAum, peakAum, rampDays, halfLifeDays);
  const viralStream = viralYears * streamRate;
  const viralMint = creationMultiple * peakAum * mintRate;
  const viralTotal = viralStream + viralMint;

  rule("ONE BASKET THAT CATCHES — fees over its whole life");
  row("Peak AUM", usd(peakAum));
  row("Dollar-years of AUM (the integral)", usd(viralYears), `${(viralYears / peakAum).toFixed(3)}x peak`);
  console.log();
  row("Streaming fees, lifetime", usd(viralStream), pct(viralStream / viralTotal));
  row("Mint fees, lifetime", usd(viralMint), pct(viralMint / viralTotal));
  row("Redeem fees, lifetime", usd(0));
  rule();
  row("Gross fees, lifetime", usd(viralTotal));
  row("  to the manager", usd(viralTotal * (1 - protoShare)));
  row("  to the protocol", usd(viralTotal * protoShare));
  row("Launch fee the manager paid", usd(CREATION_FEE_USD_TARGET + solFeeUsd));
  rule();
  row("Manager's net on one hit", usd(viralTotal * (1 - protoShare) - CREATION_FEE_USD_TARGET - solFeeUsd));
  console.log();
  const ratio = viralMint / viralStream;
  if (ratio >= 1) {
    console.log(`  The mint fee earns ${ratio.toFixed(1)}x what the streaming fee does here, despite being`);
    console.log("  half the rate: this basket is rich in FLOW and poor in TIME, accumulating");
    console.log(`  only ${(viralYears / peakAum).toFixed(2)} dollar-years per dollar of peak AUM.`);
  } else {
    console.log(`  The streaming fee earns ${(1 / ratio).toFixed(1)}x what the mint fee does here. This basket`);
    console.log(`  lives long enough to be taxed on TIME — ${(viralYears / peakAum).toFixed(2)} dollar-years per dollar of`);
    console.log("  peak AUM — which is the regime streaming fees are designed for.");
  }
  console.log();
  console.log("  Which fee dominates is set by how long the basket lives, so the two");
  console.log("  rates are a bet on what gets launched here. Short-lived viral baskets");
  console.log("  pay mostly mint fees; a long-lived index pays mostly streaming.");

  // ------------------------------------------------------------ one that dies
  const dudYears = dollarYears(seedAum, seedAum, rampDays, halfLifeDays * 2);
  const dudStream = dudYears * streamRate;
  const dudMint = seedAum * 0.5 * mintRate;
  const dudTotal = dudStream + dudMint;

  rule("ONE BASKET THAT DOESN'T — same maths, no inflow");
  row("AUM stays at seed", usd(seedAum));
  row("Gross fees, lifetime", usd(dudTotal));
  row("  to the protocol", usd(dudTotal * protoShare));
  row("Launch fee the manager paid", usd(CREATION_FEE_USD_TARGET + solFeeUsd));
  row("Manager's net", usd(dudTotal * (1 - protoShare) - CREATION_FEE_USD_TARGET - solFeeUsd));
  console.log();
  console.log("  A dud roughly pays for itself. That matters more than it looks: if");
  console.log("  launching were clearly loss-making, nobody would run the experiments");
  console.log("  that produce the hits.");

  // ----------------------------------------------------------- a year of them
  const perYear = launchesPerDay * 365;
  const virals = perYear * viralRate;
  const duds = perYear * (1 - viralRate);
  const annualGross = virals * viralTotal + duds * dudTotal;
  const annualProtocolFees = annualGross * protoShare;
  const annualSolFees = perYear * solFeeUsd;
  const annualDevCoin = perYear * CREATION_FEE_USD_TARGET * 0.3;
  const annualCreationBurn = perYear * CREATION_FEE_USD_TARGET * 0.7;

  rule(`A YEAR OF LAUNCHES — ${launchesPerDay}/day, ${pct(viralRate)} catch`);
  row("Baskets launched", perYear.toLocaleString("en-US"));
  row("  that catch / that don't", Math.round(virals).toLocaleString("en-US"), Math.round(duds).toLocaleString("en-US"));
  console.log();
  row("Gross fees across all baskets", usd(annualGross));
  row("  to managers", usd(annualGross * (1 - protoShare)));
  row("  to the protocol", usd(annualProtocolFees));
  console.log();
  console.log("  Protocol income by source:");
  row("  fee share (basket tokens + assets)", usd(annualProtocolFees), pct(annualProtocolFees / (annualProtocolFees + annualSolFees + annualDevCoin)));
  row("  SOL creation fees", usd(annualSolFees), pct(annualSolFees / (annualProtocolFees + annualSolFees + annualDevCoin)));
  row("  $EETF dev share", usd(annualDevCoin), pct(annualDevCoin / (annualProtocolFees + annualSolFees + annualDevCoin)));
  rule();
  row("Total protocol + dev income", usd(annualProtocolFees + annualSolFees + annualDevCoin));
  row("Burned automatically (creation fee)", usd(annualCreationBurn));

  // -------------------------------------------------------------- burn yields
  rule("WHAT THIS DOES FOR $EETF");
  console.log("  Burn yield = dollars of $EETF retired per year / FDV. Read as a");
  console.log("  buyback yield: what the burn returns to a holder.\n");
  console.log(`  ${"FDV".padStart(14)}${"creation burn".padStart(17)}${"+ fee share".padStart(17)}${"total".padStart(13)}`);
  rule();
  for (const f of [500_000, 5_000_000, 50_000_000, 500_000_000]) {
    const a = annualCreationBurn / f;
    const bq = annualProtocolFees / f;
    console.log(
      `  ${usd(f).padStart(14)}${pct(a).padStart(17)}${pct(bq).padStart(17)}${pct(a + bq).padStart(13)}`,
    );
  }
  console.log();
  console.log(`  The fee share is ${(annualProtocolFees / annualCreationBurn).toFixed(0)}x the creation burn. Routing protocol fee`);
  console.log("  revenue into the burn vault is worth far more than anything that can be");
  console.log("  done to the launch fee — and unlike the launch fee, it scales with AUM,");
  console.log("  which is the thing that grows when the protocol succeeds.");
  console.log();
  console.log("  Caveat the program does not solve: that revenue arrives as basket");
  console.log("  tokens and underlying assets. Converting it to $EETF and sending it to");
  console.log("  the burn vault is a discretionary off-chain step today.");

  // --------------------------------------------------------------- claim drag
  rule("CLAIM TIMING — why it is value-neutral");
  const decayPerMonth = 0.5 ** (30 / halfLifeDays);
  console.log("  A decaying basket's accrued fees lose dollar value while they sit:");
  console.log(`  at a ${halfLifeDays}-day half-life, ${pct(1 - decayPerMonth)} per month.`);
  console.log();
  row("Claim worth now", usd(viralTotal * protoShare), "100%");
  row("  the same claim a month later", usd(viralTotal * protoShare * decayPerMonth), pct(decayPerMonth));
  row("  three months later", usd(viralTotal * protoShare * decayPerMonth ** 3), pct(decayPerMonth ** 3));
  console.log();
  console.log("  It is tempting to read that as a reason to claim early. It isn't, and");
  console.log("  the mechanics are worth being exact about:");
  console.log();
  console.log("   - Dilution happens at ACCRUAL, not at claim. `accrue_streaming_fee`");
  console.log("     mints the new tokens into escrow there and then, so NAV per token");
  console.log("     has already absorbed it before anyone claims.");
  console.log("   - Claiming is NAV-neutral to everyone else. The 75% cash leg burns");
  console.log("     escrow tokens and pays pro-rata underlyings against the pre-burn");
  console.log("     supply — a redemption at NAV. Assets and supply fall together, so");
  console.log("     remaining holders are untouched.");
  console.log("   - Claiming does not escape the decay either. The cash leg pays out the");
  console.log("     SAME underlying coins that are falling. Claiming converts basket");
  console.log("     exposure into equivalent underlying exposure at NAV, and nothing");
  console.log("     more.");
  console.log();
  console.log("  So the number above is not a claim-timing loss — it is just the asset");
  console.log("  falling, and it falls on the claimer identically whether they claimed");
  console.log("  or not. Only SELLING avoids it, which means 'claim early' is really");
  console.log("  'sell early'. Building urgency into claiming would be manufacturing");
  console.log("  sell pressure and calling it a feature.");
  console.log();
  console.log("  The one genuine market effect is the 25% basket-token leg: a claimer");
  console.log("  who dumps those on a DEX pushes the price below NAV. Note what");
  console.log("  defends against that — redemption is free, so arbitrageurs close the");
  console.log("  discount at zero fee cost. The zero redeem fee is what makes the");
  console.log("  basket resilient to claim-dumping.");
  rule();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
