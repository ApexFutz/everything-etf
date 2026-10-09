#!/usr/bin/env node
// Prints the Anchor sighash discriminators for this program's instructions
// and account structs. Re-run this (and update
// app/src/lib/etf/discriminators.ts by hand with the output) whenever an
// instruction or #[account] struct is renamed in the Rust program — there's
// no Anchor CLI in this project's toolchain to regenerate a real IDL from,
// so these are tracked by hand instead.
//
// Formula (from anchor-syn's codegen::program::common::sighash): the first 8
// bytes of sha256(`${namespace}:${name}`) — namespace "global" for
// instructions (exact snake_case fn name), "account" for account types
// (exact Rust struct name).
import { createHash } from "node:crypto";

function disc(namespace, name) {
  const hash = createHash("sha256").update(`${namespace}:${name}`).digest();
  return Array.from(hash.subarray(0, 8));
}

const instructions = [
  "initialize_config",
  "update_protocol_terms",
  "update_authority",
  "initialize_coin",
  "update_coin_terms",
  "crank_burn",
  "create_basket",
  "seed_basket",
  "mint_basket",
  "redeem_basket",
  "accrue_fees",
  "claim_fees",
  "lower_fees",
];
const accounts = ["Config", "Basket", "CoinConfig"];

console.log("// instructions (global:<name>)");
for (const name of instructions) {
  console.log(`${name}: [${disc("global", name).join(", ")}]`);
}
console.log("// accounts (account:<Name>)");
for (const name of accounts) {
  console.log(`${name}: [${disc("account", name).join(", ")}]`);
}
