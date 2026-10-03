/**
 * Anchor discriminators, precomputed.
 *
 * Anchor 0.31 computes these as the first 8 bytes of
 * sha256(`${namespace}:${name}`) — `global:<instruction_name>` for
 * instructions, `account:<StructName>` for account types (see
 * anchor-syn's `codegen::program::common::sighash`). There's no Anchor CLI
 * in this project's toolchain to generate an IDL from, so these are computed
 * once (scripts/compute-discriminators.mjs) and hardcoded here — if an
 * instruction or account struct is ever renamed in the Rust program, these
 * must be regenerated to match.
 */

export const INSTRUCTION_DISCRIMINATORS = {
  initialize_config: [208, 127, 21, 1, 194, 190, 196, 70],
  update_protocol_terms: [19, 128, 92, 219, 14, 97, 117, 87],
  initialize_coin: [157, 22, 183, 45, 31, 253, 33, 186],
  update_coin_terms: [86, 39, 64, 13, 55, 234, 184, 58],
  crank_burn: [51, 203, 144, 198, 171, 213, 49, 54],
  create_basket: [47, 105, 155, 148, 15, 169, 202, 211],
  seed_basket: [149, 209, 187, 119, 255, 86, 66, 172],
  mint_basket: [41, 184, 119, 7, 57, 187, 242, 237],
  redeem_basket: [37, 133, 222, 57, 189, 160, 151, 41],
  accrue_fees: [136, 229, 178, 88, 250, 122, 35, 46],
  claim_fees: [82, 251, 233, 156, 12, 52, 184, 202],
  lower_fees: [183, 17, 140, 37, 177, 120, 23, 86],
} as const;

export const ACCOUNT_DISCRIMINATORS = {
  Config: [155, 12, 170, 224, 30, 250, 204, 130],
  Basket: [219, 79, 107, 135, 231, 243, 218, 248],
  CoinConfig: [97, 103, 88, 149, 58, 133, 241, 93],
} as const;
