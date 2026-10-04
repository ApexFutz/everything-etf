/**
 * The token list the launch form searches.
 *
 * Deliberately *not* a Jupiter/mainnet ticker list: those addresses don't exist
 * on devnet, so picking a familiar ticker there would produce a mint the
 * program can't find and a launch that fails at the last step. The set that's
 * actually correct is narrower anyway — seeding a basket means depositing every
 * asset, so the only tokens worth offering are ones the connected wallet
 * holds. Those come first, annotated with the balance, plus a handful of
 * well-known mints that exist on the cluster in question.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchMetadataFor } from "./metadata";

export interface TokenOption {
  mint: PublicKey;
  symbol: string;
  name: string;
  decimals: number;
  /** Raw balance held by the connected wallet, if any. */
  balance?: bigint;
  /** True when the wallet holds it — these sort first and can actually be seeded. */
  owned: boolean;
}

/** Mints that exist on every cluster, or on devnet specifically. */
const WELL_KNOWN: Record<"devnet" | "mainnet-beta", { mint: string; symbol: string; name: string }[]> = {
  devnet: [
    { mint: "So11111111111111111111111111111111111111112", symbol: "wSOL", name: "Wrapped SOL" },
    {
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      symbol: "USDC",
      name: "USD Coin (devnet)",
    },
  ],
  "mainnet-beta": [
    { mint: "So11111111111111111111111111111111111111112", symbol: "wSOL", name: "Wrapped SOL" },
    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USD Coin" },
    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", name: "Bonk" },
  ],
};

export function clusterOf(rpcUrl: string): "devnet" | "mainnet-beta" {
  return rpcUrl.includes("devnet") || rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")
    ? "devnet"
    : "mainnet-beta";
}

/**
 * Every SPL / Token-2022 mint the wallet holds a non-zero balance of, with
 * on-chain metadata resolved where it exists.
 */
export async function fetchWalletTokens(
  connection: Connection,
  owner: PublicKey,
): Promise<TokenOption[]> {
  const [classic, token2022] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection
      .getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })
      .catch(() => ({ value: [] as never[] })),
  ]);

  const held = new Map<string, { mint: PublicKey; decimals: number; balance: bigint }>();
  for (const { account } of [...classic.value, ...token2022.value]) {
    const info = account.data.parsed?.info;
    if (!info) continue;
    const amount = BigInt(info.tokenAmount?.amount ?? "0");
    if (amount === 0n) continue;
    held.set(info.mint, {
      mint: new PublicKey(info.mint),
      decimals: info.tokenAmount.decimals as number,
      balance: amount,
    });
  }

  const entries = [...held.values()];
  const metadata = await fetchMetadataFor(
    connection,
    entries.map((e) => e.mint),
  );

  return entries.map((e, i) => ({
    mint: e.mint,
    decimals: e.decimals,
    balance: e.balance,
    owned: true,
    symbol: metadata[i]?.symbol || `${e.mint.toBase58().slice(0, 4)}…`,
    name: metadata[i]?.name || "Unnamed token",
  }));
}

/**
 * Wallet holdings first, then well-known mints for the cluster that the wallet
 * doesn't already hold (resolved for decimals, skipped if absent on-chain).
 */
export async function fetchTokenOptions(
  connection: Connection,
  owner: PublicKey | null,
  rpcUrl: string,
): Promise<TokenOption[]> {
  const owned = owner ? await fetchWalletTokens(connection, owner) : [];
  const ownedMints = new Set(owned.map((t) => t.mint.toBase58()));

  const candidates = WELL_KNOWN[clusterOf(rpcUrl)].filter((k) => !ownedMints.has(k.mint));
  const infos = await connection.getMultipleAccountsInfo(
    candidates.map((c) => new PublicKey(c.mint)),
  );

  const known: TokenOption[] = [];
  candidates.forEach((c, i) => {
    const info = infos[i];
    if (!info) return; // not deployed on this cluster — don't offer it
    known.push({
      mint: new PublicKey(c.mint),
      symbol: c.symbol,
      name: c.name,
      // SPL Mint layout: decimals is a u8 at offset 44.
      decimals: info.data[44],
      owned: false,
    });
  });

  return [...owned, ...known];
}

/** Case-insensitive match on symbol, name, or the start of the address. */
export function filterTokens(options: TokenOption[], query: string): TokenOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (t) =>
      t.symbol.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.mint.toBase58().toLowerCase().startsWith(q),
  );
}
