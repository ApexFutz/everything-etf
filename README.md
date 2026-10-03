# Everything ETF

A launchpad for **equal-weight, on-chain basket tokens** on Solana. Anyone can create
a basket (e.g. a "Frog" basket of frog-themed memecoins), and the basket token can be
bought anywhere Solana tokens trade, including the pump.fun and fomo UIs. A bridged
copy is planned for Robinhood Chain, where it will trade on Ramses.

> **Status: v0.1, pre-audit, not deployed.** The fee/share math is unit-tested, and the whole
> program builds and runs end-to-end against the real compiled binary (see
> [Testing](#testing)) — but it has **not** had a security audit or a live run on devnet/mainnet.
> Do not put real funds in it yet.

---

## $EETF — the protocol coin

One coin for the whole launchpad. It has no inflation schedule, no staking
emissions and no rebase: the **only** supply event after genesis is a burn, and
the thing that drives burns is people launching baskets.

### Supply

| | |
|---|---|
| Genesis supply | 1,000,000,000 EETF (9 decimals) |
| Minted | once, inside `initialize_coin` |
| Mint authority after that | **None** — revoked in the same transaction, and the instruction re-reads the mint and fails if it isn't |
| Metadata | created with `is_mutable = false`; name, symbol and URI are frozen forever |

`initialize_coin` sends 100% of the supply to a single `genesis_owner` account.
Splitting that into liquidity, community and dev allocations happens off-chain
from that wallet — the program takes no position on it, so publish the
allocation and the destination wallets before you run the instruction.

### Where the coin is used

**Launching a basket costs $EETF.** `create_basket` takes `creation_fee_coin`
from the manager and splits it in one transaction:

- `creation_burn_bps` of it is **burned** — gone from supply, permanently
- the remainder goes to the **dev treasury**, which funds the build

Default suggestion: 250,000 EETF per basket, 70% burned / 30% dev. Both knobs
move with `update_coin_terms`, both are bounded by hardcoded limits the
authority cannot cross:

| Limit | Value | What it protects |
|---|---|---|
| `MIN_CREATION_BURN_BPS` | 50% | The burn can never be switched off or shrunk below half the fee |
| `MAX_CREATION_FEE_COIN` | 1% of genesis supply | New managers can never be priced out |

So the launchpad working *is* the tokenomics: every basket anyone creates
retires coin supply and pays for development, in the same instruction, with no
discretionary step in between.

### The burn vault

`CoinConfig.burn_vault` is a token account owned by the coin PDA. Anyone can
send $EETF into it with an ordinary transfer, and the only instruction that can
ever move those coins again is `crank_burn`, which burns the entire balance and
is **permissionless** — anyone can call it, and the only possible outcome is a
smaller supply. Nothing in the program can withdraw from it.

That is the hook for protocol revenue: the 10% protocol share of basket fees
arrives as basket tokens and underlyings, and once step 2 routes payouts
through Jupiter, the treasury can swap that revenue to $EETF, send it to the
burn vault, and let anyone crank it. Until then the vault is live but only
holds what people voluntarily send it. **The swap-and-send step is off-chain
and discretionary — it is a policy, not a guarantee the program enforces.**

`CoinConfig` keeps running totals (`total_burned`, `total_dev_fees`,
`baskets_funded`) and every burn emits an event, so circulating supply and
lifetime burn are both verifiable without trusting a dashboard.

### What the coin deliberately is not

It does not entitle holders to fees, it is not required to hold or trade a
basket token, and it does not vote on anything. Adding a revenue share or
governance means a securities question that a lawyer should answer first — the
roadmap items below are written on that assumption.

### Deployment order

`initialize_config` → `initialize_coin` → distribute from the genesis wallet →
baskets. `create_basket` reads the coin config, so no basket can be created
before the coin exists. Set `creation_fee_lamports` to 0 once the $EETF fee is
live, unless you want to keep a small SOL charge as a spam deterrent.

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
| Creation fee | `creation_fee_coin` in $EETF — burned / dev split, see above |
| Legacy SOL creation fee | `creation_fee_lamports`, set to 0 once the coin is live |
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
| `initialize_coin` | protocol authority, once | – |
| `update_coin_terms` | protocol authority | – |
| `crank_burn` | anyone | – |
| `update_protocol_terms` | protocol authority (future baskets only) | – |
| `create_basket` | anyone (becomes manager); costs $EETF | `[asset_mint, vault]` |
| `seed_basket` | manager, when supply is 0 | `[asset_mint, vault, manager_ata]` |
| `mint_basket` | anyone | `[asset_mint, vault, user_ata]` |
| `redeem_basket` | anyone | `[asset_mint, vault, user_ata]` |
| `accrue_fees` | anyone | – |
| `claim_fees` | manager or protocol authority | `[asset_mint, vault, payout_owner_ata]` |
| `lower_fees` | manager | – |

`create_basket` now also carries the coin accounts (`coin_config`, `coin_mint`,
`manager_coin_account`, `dev_coin_account`) and two extra token CPIs. With a
10-asset basket that is ~37 accounts and a lot of compute, so the client should
prepend a `ComputeBudget` request rather than rely on the 200k default.

`vault` is the associated token account of the **basket PDA** for that asset mint, under
the asset's own token program (SPL Token or Token-2022).

PDAs:

- config: `["config"]`
- coin config: `["coin"]`
- coin mint: `["coin_mint"]`
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

### Testing

Two layers:

- **Unit tests** (`cargo test -p everything-etf`) — pure fee/share math, no accounts. 15 cases
  in `programs/everything-etf/src/math.rs`.
- **End-to-end tests** (`cargo test -p tests-e2e`) — load the real compiled program
  (`target/deploy/everything_etf.so`, plus a mainnet dump of Metaplex token metadata) into
  [litesvm](https://github.com/LiteSVM/litesvm), an in-process SVM, and drive full
  transactions against it: no `solana-test-validator` needed. `tests/lifecycle.rs` runs the
  whole protocol end to end (genesis → basket → seed → mint/redeem → streaming fees → claims →
  lower fees).

```bash
cargo-build-sbf                   # produces target/deploy/everything_etf.so
cargo test -p tests-e2e
```

On Windows without Visual Studio installed, `cargo-build-sbf` and some of `tests-e2e`'s
dependencies need a linker/CRT configured manually (e.g. via `xwin` + `lld-link` from
Solana's own platform-tools) through a machine-specific `.cargo/config.toml`, which is
gitignored since it hardcodes local paths.

## Roadmap

1. ✅ **v0.1:** $EETF, baskets, in-kind mint/redeem, fees, events *(this release)*
2. Jupiter-routed SOL deposits/redemptions, plus a SOL cash leg in `claim_fees`
3. Seed a Solana pool and confirm visibility in the pump.fun and fomo UIs
4. LayerZero OFT Adapter on Solana and an OFT contract on Robinhood Chain
5. Ramses pool on Robinhood Chain
6. Oracle-priced rebalance crank to 1/N, probation/taper of underperformers,
   manager reserve and replacement proposals, timelocked changes
7. Launchpad UI and basket pages (holdings, history, manager track record), plus a
   public tokenomics page: circulating supply, lifetime burn, burn per basket
8. Treasury policy for revenue → $EETF → burn vault, and (lawyer permitting) a
   creation-fee discount for managers who lock $EETF

## Disclaimer

Experimental software. Not financial or legal advice. Basket tokens built on memecoins can
lose most or all of their value. Before launch, a securities lawyer should review the
product, including the use of the word "ETF."
