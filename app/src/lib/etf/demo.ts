/**
 * Demo mode: practising the real launch flow on devnet with real tokens.
 *
 * The picker searches mainnet, because that is where the tokens anyone would
 * actually put in a basket live. Devnet has none of them, so every result is a
 * dead end there and the rest of the form is unreachable — you cannot try the
 * thing without spending real money on mainnet.
 *
 * This closes that gap without faking anything that matters. Picking BONK on
 * devnet creates a devnet SPL mint carrying BONK's symbol, name and decimals,
 * and remembers which real token it stands for. From then on the stand-in is
 * used for every transaction — a genuine mint, genuine `seed_basket`, genuine
 * basket — while prices and labels come from the real token. So the weights,
 * the dollar figures and the cost breakdown are all live and correct; the only
 * fiction is which mint address the vault happens to hold.
 *
 * The registry lives in localStorage because the mapping has to outlast the
 * launch: a basket page opened tomorrow still needs to know that this devnet
 * mint is standing in for BONK in order to price it.
 */
import { PublicKey } from "@solana/web3.js";

const STORAGE_KEY = "etf.demo.standins.v1";

export interface DemoToken {
  /** The devnet mint actually used on chain. */
  standIn: string;
  /** The real mainnet mint it represents — the key prices are looked up by. */
  mainnet: string;
  symbol: string;
  name: string;
  decimals: number;
}

type Registry = Record<string, DemoToken>;

/**
 * Every read and write is wrapped: localStorage throws outright in some
 * contexts (private windows, blocked site data) rather than returning null,
 * and a demo convenience must never be able to take the page down.
 */
function read(): Registry {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Registry) : {};
  } catch {
    return {};
  }
}

function write(reg: Registry): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reg));
  } catch {
    // Out of quota or blocked — the flow still works for this session, only
    // the mapping won't survive a reload.
  }
}

export function recordStandIns(tokens: DemoToken[]): void {
  const reg = read();
  for (const t of tokens) reg[t.standIn] = t;
  write(reg);
}

export function getStandIn(mint: PublicKey | string): DemoToken | null {
  const key = typeof mint === "string" ? mint : mint.toBase58();
  return read()[key] ?? null;
}

export function allStandIns(): DemoToken[] {
  return Object.values(read());
}

/**
 * Rewrites mints to the real token each stands for, leaving anything unknown
 * alone. Price lookups go through this so a demo basket shows true dollar
 * values instead of a column of nulls.
 */
export function resolveForPricing(mints: (PublicKey | string)[]): string[] {
  const reg = read();
  return mints.map((m) => {
    const key = typeof m === "string" ? m : m.toBase58();
    return reg[key]?.mainnet ?? key;
  });
}

export function clearStandIns(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to do
  }
}
