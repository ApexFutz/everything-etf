/**
 * `EtfError` mirrored from programs/everything-etf/src/errors.rs. Variant
 * order matters: Anchor's error code is `6000 + <variant index>`.
 */
const VARIANTS = [
  ["InvalidAssetCount", "A basket needs between 2 and 10 assets"],
  ["DuplicateAsset", "The same asset was listed twice"],
  ["InvalidAssetMint", "Asset mint is not owned by the SPL Token or Token-2022 program"],
  ["FreezeAuthorityNotAllowed", "Asset mints with a freeze authority are not allowed"],
  ["UnsupportedTokenExtension", "Asset uses a Token-2022 extension that is not supported"],
  ["InvalidRemainingAccounts", "Remaining accounts do not match the expected layout"],
  ["AssetMismatch", "Asset account does not match the basket's asset list"],
  ["InvalidVault", "Vault account is not the basket's associated token account"],
  ["InvalidTokenOwner", "Token account has the wrong owner"],
  ["FeeAboveCap", "Fee exceeds the protocol hard cap"],
  ["FeeIncreaseNotAllowed", "Fees can only be lowered"],
  ["ProtocolShareAboveCap", "Protocol share exceeds the hard cap"],
  ["MetadataTooLong", "Name, symbol or URI is too long"],
  ["AlreadySeeded", "Basket has already been seeded"],
  ["NotSeeded", "Basket has not been seeded yet"],
  ["ZeroAmount", "Amount must be greater than zero"],
  ["AmountListMismatch", "Amount list length does not match the number of assets"],
  ["SlippageIn", "Required deposit exceeds max_amounts_in"],
  ["SlippageOut", "Payout is below min_amounts_out"],
  ["NothingToClaim", "Nothing to claim"],
  ["Unauthorized", "Signer is not allowed to perform this action"],
  ["BurnShareBelowFloor", "Burn share of the creation fee is below the protocol floor"],
  ["CreationFeeAboveCap", "Creation fee exceeds the protocol hard cap"],
  ["NothingToBurn", "Burn vault is empty"],
  ["MintAuthorityNotRevoked", "Coin mint authority was not revoked"],
  ["MathOverflow", "Arithmetic overflow"],
  ["AuthorityUnchanged", "New authority is the same as the current one"],
] as const;

const ERROR_CODE_OFFSET = 6000;

export const ETF_ERRORS: Record<number, { name: string; message: string }> = Object.fromEntries(
  VARIANTS.map(([name, message], i) => [ERROR_CODE_OFFSET + i, { name, message }]),
);

/** Pulls a numeric "Custom":N or "custom program error: 0xN" code out of a thrown error, if there is one. */
export function extractCustomErrorCode(err: unknown): number | null {
  const text = err instanceof Error ? err.message : String(err);
  const hex = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const dec = text.match(/"Custom":\s*(\d+)/);
  if (dec) return parseInt(dec[1], 10);
  return null;
}

/** A human-readable message for any error thrown while sending a transaction. */
export function describeError(err: unknown): string {
  const code = extractCustomErrorCode(err);
  if (code != null) {
    const known = ETF_ERRORS[code];
    if (known) return `${known.name}: ${known.message}`;
    return `Program error ${code} (0x${code.toString(16)})`;
  }
  return err instanceof Error ? err.message : String(err);
}
