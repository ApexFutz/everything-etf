/**
 * Launching a basket without already owning anything.
 *
 * `seed_basket` is in-kind: it wants real balances of every underlying. That
 * made launching circular — to create a basket of ten coins you first had to
 * go and buy ten coins, in the exact ratio your own weights implied. This
 * turns the whole thing into one flow: swap into each asset, create the
 * basket, seed it.
 *
 * Why every transaction can be built before any of them is sent: the swaps are
 * quoted **ExactOut**, so each one delivers a known amount regardless of what
 * the route does on the way. That makes the seed deposits deterministic, which
 * makes the seed transaction constructible up front, which means the wallet can
 * be asked to sign everything in a single prompt rather than once per leg.
 *
 * Order is swaps → create → seed, chosen for how it fails rather than how it
 * succeeds. A swap that fails partway leaves the user holding some tokens and
 * nothing else: no basket, no burned $EETF, and they can simply try again.
 * Creating first would mean a failed swap left an empty basket behind with the
 * launch fee already destroyed.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { JupiterQuote, ZapPlan } from "./zap";

export const JUPITER_SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";

export type ZapStepKind = "swap" | "create" | "seed";

export interface ZapStep {
  kind: ZapStepKind;
  /** Shown in the progress list, e.g. "Buy BONK". */
  label: string;
  transaction: Transaction | VersionedTransaction;
  /** Extra signers for legacy transactions (the basket mint, etc.). */
  signers?: Keypair[];
}

/**
 * Asks Jupiter to build the swap. Returns a VersionedTransaction carrying its
 * own blockhash and lookup tables — those are what let a route with many
 * accounts fit, so it must not be rebuilt as a legacy transaction.
 */
export async function fetchSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: PublicKey,
  signal?: AbortSignal,
): Promise<VersionedTransaction> {
  const res = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    signal,
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: userPublicKey.toBase58(),
      // The user pays in SOL, so it has to be wrapped on the way in and any
      // remainder unwrapped on the way out.
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Jupiter couldn't build the swap (${res.status})`);
  }
  const { swapTransaction } = (await res.json()) as { swapTransaction?: string };
  if (!swapTransaction) throw new Error("Jupiter returned no swap transaction");
  return VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
}

/**
 * The full ordered plan. `createIxs`/`seedIxs` come from the caller because
 * building them needs the program client, which this module deliberately
 * doesn't depend on.
 */
export async function buildZapLaunch(args: {
  connection: Connection;
  user: PublicKey;
  plan: ZapPlan;
  /** Symbols aligned with `plan.legs`, for labelling. */
  symbols: string[];
  createIxs: Transaction;
  seedIxs: Transaction;
  signal?: AbortSignal;
}): Promise<ZapStep[]> {
  const { connection, user, plan, symbols, createIxs, seedIxs } = args;

  if (plan.unroutable.length > 0) {
    throw new Error(
      `No swap route for ${plan.unroutable.length} token${plan.unroutable.length === 1 ? "" : "s"}. ` +
        `Remove ${plan.unroutable.length === 1 ? "it" : "them"} or pick something with more liquidity.`,
    );
  }

  // Quoted concurrently; one slow route shouldn't serialise the rest. A leg
  // with no quote is one the user already holds the input for (the asset IS
  // the input mint), so it needs no swap.
  const swaps = await Promise.all(
    plan.legs.map(async (leg, i): Promise<ZapStep | null> =>
      leg.quote
        ? {
            kind: "swap",
            label: `Buy ${symbols[i] ?? "token"}`,
            transaction: await fetchSwapTransaction(leg.quote, user, args.signal),
          }
        : null,
    ),
  );

  // One blockhash for both legacy transactions, taken as late as possible —
  // the whole batch is signed at once and the clock starts here.
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  for (const tx of [createIxs, seedIxs]) {
    tx.recentBlockhash = blockhash;
    tx.feePayer = user;
  }

  return [
    ...swaps.filter((s): s is ZapStep => s !== null),
    { kind: "create", label: "Create the basket", transaction: createIxs },
    { kind: "seed", label: "Make the initial deposit", transaction: seedIxs },
  ];
}

export interface ZapProgress {
  index: number;
  total: number;
  step: ZapStep;
  signature?: string;
}

/**
 * Sends a signed plan in order, confirming each before the next.
 *
 * Strictly sequential: the seed spends what the swaps produce and the basket
 * the create makes, so a parallel send would race its own dependencies.
 *
 * On failure it reports which step broke and how many had already landed,
 * because "the launch failed" and "seven swaps landed and then the basket
 * failed" need completely different things from the user.
 */
export async function sendZapLaunch(
  connection: Connection,
  signed: (Transaction | VersionedTransaction)[],
  steps: ZapStep[],
  onProgress?: (p: ZapProgress) => void,
): Promise<{ signatures: string[] } | { signatures: string[]; failedAt: number; error: unknown }> {
  const signatures: string[] = [];

  for (let i = 0; i < signed.length; i++) {
    onProgress?.({ index: i, total: signed.length, step: steps[i] });
    try {
      const sig = await connection.sendRawTransaction(signed[i].serialize(), {
        // Pre-signed and sent in order; a preflight against a state the
        // earlier steps haven't produced yet would fail spuriously.
        skipPreflight: true,
        maxRetries: 3,
      });
      await connection.confirmTransaction(sig, "confirmed");
      signatures.push(sig);
      onProgress?.({ index: i, total: signed.length, step: steps[i], signature: sig });
    } catch (error) {
      return { signatures, failedAt: i, error };
    }
  }
  return { signatures };
}
