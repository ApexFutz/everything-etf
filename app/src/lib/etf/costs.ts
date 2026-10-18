/**
 * What launching a basket actually costs, in SOL.
 *
 * Creating a basket allocates a pile of accounts, each of which needs to be
 * rent-exempt, and that rent is paid by the manager. It's the largest part of
 * the SOL cost and it isn't obvious from anywhere in the UI unless we add it
 * up, so this does — from the chain's own rent schedule rather than a
 * hardcoded guess.
 */
import { Connection } from "@solana/web3.js";

/** Sizes of the accounts `create_basket` and `seed_basket` allocate. */
export const ACCOUNT_SIZES = {
  /** 8-byte discriminator + Basket::INIT_SPACE (assets Vec is max_len(10)). */
  basket: 478,
  /** SPL Mint. */
  mint: 82,
  /** SPL token account (fee escrow, each asset vault, the manager's own ATA). */
  tokenAccount: 165,
  /** Metaplex token metadata v3. */
  metadata: 607,
} as const;

export interface CreateCostEstimate {
  /** Rent for every account the launch allocates. */
  rentLamports: bigint;
  /** Rough network fee allowance for the two transactions. */
  networkFeeLamports: bigint;
  lines: { label: string; lamports: bigint }[];
}

/**
 * Rent for: the basket account, its token mint, its Metaplex metadata, the fee
 * escrow, one vault per asset, and the manager's own basket-token account.
 */
export async function estimateCreateCost(
  connection: Connection,
  assetCount: number,
): Promise<CreateCostEstimate> {
  const [basket, mint, tokenAccount, metadata] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZES.basket),
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZES.mint),
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZES.tokenAccount),
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZES.metadata),
  ]);

  // fee escrow + one vault per asset + the manager's own basket-token account
  const tokenAccounts = BigInt(tokenAccount) * BigInt(assetCount + 2);

  const lines = [
    { label: "Basket account", lamports: BigInt(basket) },
    { label: "Basket token mint", lamports: BigInt(mint) },
    { label: "Token metadata", lamports: BigInt(metadata) },
    {
      label: `Token accounts (${assetCount} vault${assetCount === 1 ? "" : "s"} + escrow + yours)`,
      lamports: tokenAccounts,
    },
  ];

  const rentLamports = lines.reduce((sum, l) => sum + l.lamports, 0n);
  // Two transactions, a handful of signatures each, at the 5000-lamport base.
  const networkFeeLamports = 20_000n;

  return { rentLamports, networkFeeLamports, lines };
}
