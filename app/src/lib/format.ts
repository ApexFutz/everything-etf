/** Formatting/parsing helpers for token amounts and bps, shared by every form. */

/** `123456789n` base units, 9 decimals -> "123.456789". Trims trailing zeros. */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const s = a.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  let frac = decimals > 0 ? s.slice(s.length - decimals) : "";
  frac = frac.replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

/** "123.456789" with 9 decimals -> 123456789n. Throws on anything unparseable. */
export function parseToBaseUnits(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error(`"${input}" is not a valid amount`);
  }
  const [wholeRaw, fracRaw = ""] = trimmed.split(".");
  const whole = wholeRaw || "0";
  if (fracRaw.length > decimals) {
    throw new Error(`at most ${decimals} decimal places allowed`);
  }
  const frac = fracRaw.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

/** 150 bps -> "1.5%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function explorerUrl(address: string, cluster: "devnet" | "mainnet-beta" = "devnet"): string {
  const suffix = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/address/${address}${suffix}`;
}

export function explorerTxUrl(sig: string, cluster: "devnet" | "mainnet-beta" = "devnet"): string {
  const suffix = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${sig}${suffix}`;
}

export function shortAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}
