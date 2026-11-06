/**
 * "Smart basket" discovery: turn a risk tier + theme + size into a candidate
 * basket the user can accept or reject. Rules-based on live Jupiter signals —
 * no model, so generating is instant and free, which is what a swipe flow needs.
 *
 * Every candidate is real mainnet tokens with real liquidity/verification/
 * organic-score behind the pick. On devnet the accepted tokens flow through the
 * create page's existing stand-in path, so this needs no program or key.
 */
import { normalize } from "./weights";
import { MAX_ASSETS } from "./constants";

const JUP = "https://lite-api.jup.ag/tokens/v2";

export type RiskTier = "conservative" | "balanced" | "degen";

export interface DiscoverParams {
  /** Free-text sector/vibe; blank falls back to the risk tier's top-lists. */
  theme: string;
  risk: RiskTier;
  size: number;
  /**
   * Liquidity band, in USD. When set, every pick must fall inside it, so the
   * basket stays within one size tier instead of mixing giants with micro-caps.
   * Unset means the risk tier's own floor applies with no ceiling.
   */
  minLiquidity?: number;
  maxLiquidity?: number;
}

/** Size tiers for the liquidity slider. `max: Infinity` = no ceiling. */
export const LIQUIDITY_BANDS: { label: string; hint: string; min: number; max: number }[] = [
  { label: "Any", hint: "any size", min: 0, max: Infinity },
  { label: "Micro", hint: "$1k–50k", min: 1_000, max: 50_000 },
  { label: "Small", hint: "$50k–250k", min: 50_000, max: 250_000 },
  { label: "Mid", hint: "$250k–2M", min: 250_000, max: 2_000_000 },
  { label: "Large", hint: "$2M–25M", min: 2_000_000, max: 25_000_000 },
  { label: "Huge", hint: "$25M+", min: 25_000_000, max: Infinity },
];

export interface CandidateToken {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  icon?: string;
  verified?: boolean;
  scoreLabel?: string;
  liquidityUsd?: number;
}

export interface Candidate {
  name: string;
  symbol: string;
  tokens: CandidateToken[];
  /** Positional, summing to 1, aligned with `tokens`. */
  weights: number[];
  stats: { avgLiquidityUsd: number; verifiedPct: number };
}

interface RawJupToken {
  id: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  icon?: string;
  isVerified?: boolean;
  organicScoreLabel?: string;
  liquidity?: number;
  audit?: { freezeAuthorityDisabled?: boolean };
}

const RISK: Record<
  RiskTier,
  { minLiq: number; verifiedOnly: boolean; scores: string[]; pools: string[]; label: string }
> = {
  conservative: {
    minLiq: 250_000,
    verifiedOnly: true,
    scores: ["high"],
    pools: ["toporganicscore/24h", "toptraded/24h"],
    label: "Conservative",
  },
  balanced: {
    minLiq: 50_000,
    verifiedOnly: false,
    scores: ["high", "medium"],
    pools: ["toptraded/24h", "toptrending/24h"],
    label: "Balanced",
  },
  degen: {
    minLiq: 3_000,
    verifiedOnly: false,
    scores: ["high", "medium", "low"],
    pools: ["toptrending/24h", "toptraded/24h"],
    label: "Degen",
  },
};

/** SOL and the stablecoins — real tokens, but a dull thing to put in a basket. */
const BORING = new Set([
  "USDC", "USDT", "SOL", "WSOL", "USDS", "PYUSD", "EURC", "USDG", "FDUSD",
  "JITOSOL", "MSOL", "BSOL", "JUPSOL", "INF",
]);

/**
 * Cached so that swiping — which re-queries the same pools every card — doesn't
 * re-hit the API each time. The lite API rate-limits bursts, and a throttled
 * fetch returns empty, which would empty the whole basket; on any failure we
 * fall back to a cached copy (even a stale one) rather than nothing.
 */
const CACHE_TTL = 90_000;
const poolCache = new Map<string, { at: number; data: RawJupToken[] }>();

async function fetchJup(path: string): Promise<RawJupToken[]> {
  const cached = poolCache.get(path);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;
  try {
    const res = await fetch(`${JUP}/${path}`, { headers: { accept: "application/json" } });
    if (!res.ok) return cached?.data ?? [];
    const j = await res.json();
    const data = Array.isArray(j) ? (j as RawJupToken[]) : [];
    poolCache.set(path, { at: Date.now(), data });
    return data;
  } catch {
    return cached?.data ?? [];
  }
}

function dedupById(tokens: RawJupToken[]): RawJupToken[] {
  const seen = new Set<string>();
  const out: RawJupToken[] = [];
  for (const t of tokens) {
    if (t?.id && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/**
 * Conceptual themes ("blue-chip", "defi") aren't token names, so a literal
 * search finds nothing. This maps the common ones to search terms that do hit.
 * An empty list means "no keyword search" — the concept is expressed purely by
 * the risk tier's quality top-lists (that *is* what blue-chip means). Unknown
 * free-text themes search for themselves.
 */
const THEME_SYNONYMS: Record<string, string[]> = {
  "blue-chip": [],
  bluechip: [],
  "blue chip": [],
  memes: ["meme", "pepe", "wif", "bonk", "doge"],
  meme: ["meme", "pepe", "wif", "bonk", "doge"],
  defi: ["defi", "finance", "swap", "lend", "perp"],
  gaming: ["game", "gaming", "play"],
  game: ["game", "gaming", "play"],
  ai: ["ai", "agent", "gpt"],
  dogs: ["dog", "shib", "inu", "bonk"],
  dog: ["dog", "shib", "inu"],
  cats: ["cat", "popcat", "mew"],
  cat: ["cat", "popcat", "mew"],
};

function themeKeywords(theme: string): string[] {
  const t = theme.trim().toLowerCase();
  if (!t) return [];
  if (t in THEME_SYNONYMS) return THEME_SYNONYMS[t];
  return [t];
}

const matchesKeyword = (t: RawJupToken, keywords: string[]): boolean => {
  if (keywords.length === 0) return false;
  const hay = `${t.symbol ?? ""} ${t.name ?? ""}`.toLowerCase();
  return keywords.some((k) => hay.includes(k));
};

/** The tier's merged top-lists — always available, always quality. */
async function fetchBasePool(risk: RiskTier): Promise<RawJupToken[]> {
  const lists = await Promise.all(RISK[risk].pools.map(fetchJup));
  return dedupById(lists.flat());
}

/**
 * Tokens from searching the theme keywords. Capped at three searches to keep the
 * request burst small (the rest of a long synonym list still drives matching).
 */
async function fetchThemePool(keywords: string[]): Promise<RawJupToken[]> {
  if (keywords.length === 0) return [];
  const lists = await Promise.all(
    keywords.slice(0, 3).map((k) => fetchJup(`search?query=${encodeURIComponent(k)}`)),
  );
  return dedupById(lists.flat());
}

/** Jupiter marks a freeze authority as present with `false` (absent = unknown). */
const hasFreezeAuthority = (t: RawJupToken) => t.audit?.freezeAuthorityDisabled === false;

/**
 * `relax` loosens the gate in stages so a thin theme still yields something:
 * 0 = full rules, 1 = drop the organic-score floor, 2 = drop verified-only,
 * 3 = quarter the liquidity floor. Freeze-authority and "boring" are never
 * relaxed — the first the program rejects, the second defeats the point.
 */
function filterPool(
  raw: RawJupToken[],
  risk: RiskTier,
  relax: number,
  band?: { min: number; max: number },
): RawJupToken[] {
  const cfg = RISK[risk];
  // An explicit band is a user choice and is never relaxed — mixing sizes is
  // exactly what it's there to prevent. Without one, the tier floor relaxes.
  const min = band ? band.min : relax >= 3 ? cfg.minLiq / 4 : cfg.minLiq;
  const max = band ? band.max : Infinity;
  return raw.filter((t) => {
    if (!t?.id || !t.symbol) return false;
    if (hasFreezeAuthority(t)) return false;
    if (BORING.has(t.symbol.toUpperCase())) return false;
    if (relax < 2 && cfg.verifiedOnly && !t.isVerified) return false;
    if (relax < 1 && !cfg.scores.includes(t.organicScoreLabel ?? "low")) return false;
    const liq = t.liquidity ?? 0;
    if (liq < min || liq > max) return false;
    return true;
  });
}

function toCandidate(t: RawJupToken): CandidateToken {
  return {
    mint: t.id,
    symbol: t.symbol || t.id.slice(0, 4),
    name: t.name || "Unnamed token",
    decimals: t.decimals ?? 9,
    icon: t.icon,
    verified: t.isVerified,
    scoreLabel: t.organicScoreLabel,
    liquidityUsd: t.liquidity,
  };
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Weights with a deliberate random tilt, so "reshuffle" changes something and
 * degen baskets feel lively. Conservative leans toward the deeper-liquidity
 * names; the rest start even. No single token exceeds 45%.
 */
export function weightTokens(tokens: CandidateToken[], risk: RiskTier): number[] {
  if (tokens.length === 0) return [];
  const base = tokens.map((t) =>
    risk === "conservative" ? Math.sqrt(Math.max(t.liquidityUsd ?? 1, 1)) : 1,
  );
  const spread = risk === "degen" ? 1.2 : risk === "balanced" ? 0.5 : 0.25;
  const tilted = base.map((b) => b * (1 - spread / 2 + Math.random() * spread));
  const capped = normalize(tilted).map((w) => Math.min(w, 0.45));
  return normalize(capped);
}

const RISK_WORD: Record<RiskTier, string> = {
  conservative: "Core",
  balanced: "Blend",
  degen: "Degen",
};

const NO_THEME_NAMES = ["Solana", "Grab Bag", "Wildcard", "House", "Spotlight"];

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function nameFor(params: DiscoverParams, tokens: CandidateToken[]): { name: string; symbol: string } {
  const base = params.theme.trim()
    ? titleCase(params.theme.trim())
    : NO_THEME_NAMES[Math.floor(Math.random() * NO_THEME_NAMES.length)];
  const name = `${base} ${RISK_WORD[params.risk]}`.slice(0, 32);
  const symbol =
    tokens
      .map((t) => t.symbol[0] ?? "")
      .join("")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 6)
      .toUpperCase() || "BASKET";
  return { name, symbol };
}

/**
 * Draws one candidate. The universe is always the tier's top-lists plus any
 * theme-search hits, so there's real material even when a theme finds nothing —
 * the theme then acts as a preference, not a filter. Returns null only when the
 * token index can't be reached at all. Each call re-samples (the "next" card).
 */
export async function generateCandidate(params: DiscoverParams): Promise<Candidate | null> {
  const keywords = themeKeywords(params.theme);
  const [base, themed] = await Promise.all([
    fetchBasePool(params.risk),
    fetchThemePool(keywords),
  ]);
  const themeIds = new Set(themed.map((t) => t.id));
  const universe = dedupById([...themed, ...base]);
  if (universe.length === 0) return null; // index unreachable

  const size = Math.min(Math.max(params.size, 2), MAX_ASSETS);
  const band =
    params.minLiquidity != null || params.maxLiquidity != null
      ? { min: params.minLiquidity ?? 0, max: params.maxLiquidity ?? Infinity }
      : undefined;
  const inBand = (t: RawJupToken) =>
    !band || ((t.liquidity ?? 0) >= band.min && (t.liquidity ?? 0) <= band.max);

  // Apply the risk gate, loosening in stages until there's enough to fill it.
  let eligible: RawJupToken[] = [];
  for (let relax = 0; relax <= 3; relax++) {
    eligible = filterPool(universe, params.risk, relax, band);
    if (eligible.length >= size) break;
  }
  // Last resort: ignore the risk thresholds and take anything a basket can hold
  // — but still honour the liquidity band, since not mixing sizes is the point.
  if (eligible.length < 2) {
    eligible = universe.filter(
      (t) => t?.symbol && !hasFreezeAuthority(t) && !BORING.has(t.symbol.toUpperCase()) && inBand(t),
    );
  }
  if (eligible.length < 2) return null;

  // Prefer on-theme tokens, then backfill from the rest so the count is met.
  const onTheme = (t: RawJupToken) => themeIds.has(t.id) || matchesKeyword(t, keywords);
  const matches = shuffle(eligible.filter(onTheme));
  const rest = shuffle(eligible.filter((t) => !onTheme(t)));
  const pick = [...matches, ...rest].slice(0, size).map(toCandidate);

  const weights = weightTokens(pick, params.risk);
  const { name, symbol } = nameFor(params, pick);
  const liqs = pick.map((t) => t.liquidityUsd ?? 0);
  const stats = {
    avgLiquidityUsd: liqs.reduce((a, b) => a + b, 0) / pick.length,
    verifiedPct: Math.round((pick.filter((t) => t.verified).length / pick.length) * 100),
  };
  return { name, symbol, tokens: pick, weights, stats };
}

/** Re-roll just the weights on the same tokens — the reshuffle action. */
export function reweight(candidate: Candidate, risk: RiskTier): Candidate {
  return { ...candidate, weights: weightTokens(candidate.tokens, risk) };
}

export const RISK_LABEL: Record<RiskTier, string> = {
  conservative: RISK.conservative.label,
  balanced: RISK.balanced.label,
  degen: RISK.degen.label,
};
