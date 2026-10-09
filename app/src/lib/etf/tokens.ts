/**
 * The token list the launch form searches.
 *
 * Two sources, because they answer different questions:
 *
 * - **Jupiter's token search** is what people actually want to put in a
 *   basket — pump.fun graduates and the rest of the memecoin long tail,
 *   searchable by ticker. It's mainnet data.
 * - **The connected wallet's holdings**, because seeding a basket deposits
 *   every asset: you can only launch with tokens you actually hold. These
 *   come first and carry balances.
 *
 * Results are annotated with the two things that decide whether a token is
 * worth putting in a basket, surfaced in the dropdown rather than discovered
 * when the launch transaction reverts:
 *
 * - **Can a basket even hold it.** The program rejects any mint with a freeze
 *   authority, since whoever holds that key could freeze the vault and trap
 *   every holder's assets. Jupiter reports this, but not reliably — for USDC
 *   the flag is absent rather than false, despite USDC very much having one —
 *   so every result is checked against the chain itself.
 * - **Is it the real one.** `isVerified` / `organicScore`: searching "bonk"
 *   returns a dozen impersonators alongside it. Picking the wrong one means a
 *   basket full of a worthless clone.
 */
import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchMetadataFor } from "./metadata";

export interface TokenOption {
  mint: PublicKey;
  symbol: string;
  name: string;
  decimals: number;
  /** Raw balance held by the connected wallet, if any. */
  balance?: bigint;
  /** True when the wallet holds it — these can actually be seeded. */
  owned: boolean;
  icon?: string;
  verified?: boolean;
  /** Jupiter's organic-activity rating: "high" | "medium" | "low". */
  scoreLabel?: string;
  liquidityUsd?: number;
  /**
   * Why this token can't be put in a basket, if it can't. Set means the
   * picker shows it but refuses to select it.
   */
  blockedReason?: string;
}

export type Cluster = "devnet" | "mainnet-beta";

const FREEZE_REASON =
  "Has a freeze authority — baskets reject these, since whoever holds it could freeze the vault";

export function clusterOf(rpcUrl: string): Cluster {
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

interface JupiterToken {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  isVerified?: boolean;
  organicScoreLabel?: string;
  liquidity?: number;
  tokenProgram?: string;
  audit?: { freezeAuthorityDisabled?: boolean; mintAuthorityDisabled?: boolean };
}

/**
 * Searches Jupiter's token index (mainnet). `cluster` doesn't filter the
 * search — the index only covers mainnet either way — it decides whether the
 * results are selectable here, since a mainnet mint simply isn't an account
 * on devnet.
 */
export async function searchTokens(
  query: string,
  cluster: Cluster,
  connection?: Connection,
): Promise<TokenOption[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  let raw: JupiterToken[];
  try {
    const res = await fetch(
      `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return [];
    raw = (await res.json()) as JupiterToken[];
  } catch {
    return []; // offline, rate-limited, whatever — local matches still work
  }

  const tokens = raw.slice(0, 20).map((t) => ({
    mint: new PublicKey(t.id),
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    owned: false,
    icon: t.icon,
    verified: t.isVerified,
    scoreLabel: t.organicScoreLabel,
    liquidityUsd: t.liquidity,
    // Jupiter's audit flags are only a hint: for USDC, for instance, the
    // `freezeAuthorityDisabled` field is absent rather than false, even
    // though it very much has one. The chain is checked below instead.
    blockedReason: t.audit?.freezeAuthorityDisabled === false ? FREEZE_REASON : undefined,
  }));

  if (!connection) return tokens;

  // One batched lookup settles both questions authoritatively: does this mint
  // exist on the cluster we're pointed at, and can a basket actually hold it.
  try {
    const infos = await connection.getMultipleAccountsInfo(tokens.map((t) => t.mint));
    return tokens.map((t, i) => {
      const verdict = classifyMint(infos[i]);
      return "error" in verdict
        ? {
            ...t,
            blockedReason:
              verdict.missing && cluster === "devnet"
                ? "Mainnet token — doesn't exist on devnet"
                : verdict.error,
          }
        : { ...t, decimals: verdict.decimals, blockedReason: undefined };
    });
  } catch {
    return tokens; // RPC hiccup — fall back to Jupiter's hint
  }
}

/**
 * Classifies a raw mint account. SPL Mint layout: COption<Pubkey> mint
 * authority (4 + 32), supply (8), decimals (1), is_initialized (1), then
 * COption<Pubkey> freeze authority — so decimals sits at 44 and the freeze
 * authority's option tag at 46. Verified against spl-token's own parser.
 */
function classifyMint(
  info: AccountInfo<Buffer> | null,
): { decimals: number } | { error: string; missing?: boolean } {
  // An address with no account can come back either as null or as a
  // zero-length system-owned account depending on the RPC — devnet returns the
  // latter for mainnet mint addresses — so both count as "not here".
  if (!info || info.data.length === 0) {
    return { error: "That mint doesn't exist on this cluster.", missing: true };
  }
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return { error: "That address isn't a token mint." };
  }
  if (info.data.length < 82) return { error: "That address isn't a token mint." };
  if (info.data.readUInt32LE(46) === 1) {
    return {
      error:
        "Has a freeze authority — baskets reject these, since whoever holds it could freeze the vault",
    };
  }
  return { decimals: info.data[44] };
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

/**
 * Authoritative eligibility check, for tokens from any source (a pasted
 * address, a wallet holding, a search hit). Jupiter's audit flags are a
 * useful prefilter but this is the thing the program itself enforces.
 */
export async function checkEligibility(
  connection: Connection,
  mint: PublicKey,
): Promise<{ decimals: number } | { error: string }> {
  return classifyMint(await connection.getAccountInfo(mint));
}
