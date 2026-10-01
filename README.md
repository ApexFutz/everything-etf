# Everything ETF

A launchpad for **equal-weight, on-chain basket tokens** on Solana. Anyone can create
a basket (e.g. a "Frog" basket of frog-themed memecoins), and the basket token can be
bought anywhere Solana tokens trade, including the pump.fun and fomo UIs. A bridged
copy is planned for Robinhood Chain, where it will trade on Ramses.

> **Status: v0.1, pre-audit, not deployed.** Compiles for the Solana runtime and the
> fee/share math is unit-tested. It has **not** had integration tests on a validator or
> a security audit. Do not put real funds in it yet.

---

## How a basket works

1. A **manager** creates a basket from 2 to 10 existing SPL / Token-2022 coins.
   Each coin is meant to be **1/N** of the basket.
2. The manager **seeds** it with the first deposit and receives the first basket tokens.
3. Anyone can **mint** basket tokens by depositing each underlying pro-rata (at NAV),
   or **redeem** them for their share of every underlying.
4. A **basket/SOL pool** (Raydium/Meteora) makes the token buyable in pump.fun and fomo
   through their aggregators. Arbitrageurs keep the pool price near NAV by minting
   when the pool is above NAV and redeeming when it's below.

## Fee model

| Item | Value |
|---|---|
| Creation fee | 0.25 SOL to the protocol treasury |
| Mint / redeem fee | set per basket, hard cap 1% each |
| Streaming (management) fee | set per basket, hard cap 3% / year |
| Protocol share of all fees | 10% (locked onto each basket at creation, hard cap 30%) |
| Payout split for every recipient | **75% cash leg / 25% basket tokens** |

Example, 1 SOL of fees: protocol gets 0.075 cash + 0.025 in basket tokens;
manager gets 0.675 cash + 0.225 in basket tokens.

Fees accrue in basket-token units in a fee escrow owned by the basket PDA. On
`claim_fees`, 25% is transferred as basket tokens and 75% is burned and paid out of the vault.
In **v0.1 the cash leg is paid in-kind** (pro-rata underlyings). **Step 2** adds a
Jupiter swap inside `claim_fees` so it arrives as SOL.

### The only ways value leaves a vault

1. `redeem_basket`: only to the holder burning their own tokens.
2. `claim_fees`: amount fixed by on-chain ledgers, paid only to the manager or the protocol treasury.
3. *(step 6)* rebalance swaps, bounded by oracle prices.

Managers can **lower** fees instantly but can never raise them above the hard caps.
Raising fees (within caps) will go through a timelock in step 6.

> **Upgrade authority is the master key.** Whoever holds the program's upgrade authority can
> change every rule above. Before mainnet, put it behind a multisig and timelock, or freeze
> the program after audit, and show who holds it on every basket page.

## Asset safety rules

`create_basket` rejects asset mints that could trap or drain the vault:

- any **freeze authority**, since the vault could be frozen
- Token-2022 extensions other than metadata and group pointers: transfer fees break
  accounting, a permanent delegate can drain the vault, and transfer hooks can block exits

## Instructions

| Instruction | Who | Remaining accounts (per asset, in basket order) |
|---|---|---|
| `initialize_config` | program upgrade authority, once | – |
| `update_protocol_terms` | protocol authority (future baskets only) | – |
| `create_basket` | anyone (becomes manager) | `[asset_mint, vault]` |
| `seed_basket` | manager, when supply is 0 | `[asset_mint, vault, manager_ata]` |
| `mint_basket` | anyone | `[asset_mint, vault, user_ata]` |
| `redeem_basket` | anyone | `[asset_mint, vault, user_ata]` |
| `accrue_fees` | anyone | – |
| `claim_fees` | manager or protocol authority | `[asset_mint, vault, payout_owner_ata]` |
| `lower_fees` | manager | – |

`vault` is the associated token account of the **basket PDA** for that asset mint, under
the asset's own token program (SPL Token or Token-2022).

PDAs:

- config: `["config"]`
- basket: `["basket", basket_id (u64 LE)]`
- basket mint: `["basket_mint", basket]`

Every state change emits an event (`BasketCreated`, `Minted`, `Redeemed`,
`StreamingFeeAccrued`, `FeesClaimed`, ...). An indexer turns these into each basket
page's public holdings and history.

## Rounding

Rounding always favours existing holders: deposits round **up** and payouts and fees round
**down**. A mint followed by an immediate redeem can never return more than was put in (tested).

## Build and test

```bash
# Anchor 0.31.x, Solana/Agave 2.1.x
anchor build
cargo test -p everything-etf      # math unit tests
anchor keys sync                  # replace the placeholder program ID with your keypair's
```

`Cargo.lock` is pinned to crates compatible with Solana platform-tools (Rust 1.79).
If a dependency update breaks `anchor build` with an `edition2024` error, run
`cargo update -p blake3 --precise 1.5.5`.

## Roadmap

1. ✅ **v0.1:** baskets, in-kind mint/redeem, fees, events *(this release)*
2. Jupiter-routed SOL deposits/redemptions, plus a SOL cash leg in `claim_fees`
3. Seed a Solana pool and confirm visibility in the pump.fun and fomo UIs
4. LayerZero OFT Adapter on Solana and an OFT contract on Robinhood Chain
5. Ramses pool on Robinhood Chain
6. Oracle-priced rebalance crank to 1/N, probation/taper of underperformers,
   manager reserve and replacement proposals, timelocked changes
7. Launchpad UI and basket pages (holdings, history, manager track record)

## Disclaimer

Experimental software. Not financial or legal advice. Basket tokens built on memecoins can
lose most or all of their value. Before launch, a securities lawyer should review the
product, including the use of the word "ETF."
