# Tote

A launchpad for **on-chain basket tokens** on Solana. Anyone can create
a basket (e.g. a "Frog" basket of frog-themed memecoins), and the basket token can be
bought anywhere Solana tokens trade, including the pump.fun and fomo UIs. A bridged
copy is planned for Robinhood Chain, where it will trade on Ramses.

> **Status: v0.1, pre-audit, live on devnet only.** The fee/share math is unit-tested, the
> whole program runs end-to-end against the real compiled binary (see [Testing](#testing)),
> and it's deployed and initialized on devnet at
> [`9mT7xrj7xWiTPkH8pMQ8yzz8d8Fs9TacqyYQ61yPUzyq`](https://explorer.solana.com/address/9mT7xrj7xWiTPkH8pMQ8yzz8d8Fs9TacqyYQ61yPUzyq?cluster=devnet) —
> but it has **not** had a security audit, and that devnet deployment's upgrade authority is a
> single hot wallet (see [#4](https://github.com/ApexFutz/everything-etf/issues/4)). Do not put
> real funds in it, and do not deploy to mainnet, until both of those are addressed.

---

## $TOTE — the protocol coin

One coin for the whole launchpad. It has no inflation schedule, no staking
emissions and no rebase: the **only** supply event after genesis is a burn, and
the thing that drives burns is people launching baskets.

### Supply

| | |
|---|---|
| Genesis supply | 1,000,000,000 TOTE (9 decimals) |
| Minted | once, inside `initialize_coin` |
| Mint authority after that | **None** — revoked in the same transaction, and the instruction re-reads the mint and fails if it isn't |
| Metadata | created with `is_mutable = false`; name, symbol and URI are frozen forever |

`initialize_coin` sends 100% of the supply to a single `genesis_owner` account.
Splitting that into liquidity, community and dev allocations happens off-chain
from that wallet — the program takes no position on it, so publish the
allocation and the destination wallets before you run the instruction.

**No allocation is locked or vested, by decision.** There is no escrow, no
cliff and no release schedule, and the program contains no instruction that
could enforce one. Distributing the bulk of supply up front with no insider
overhang is a legitimate end state rather than only a deferral — it is roughly
what Hyperliquid did, and the absence of an unlock calendar is a large part of
why that structure held up.

What makes it work is distributing. The failure mode is *not* "no locks" — it
is "no locks, plus a wallet holding most of the supply that could sell at any
time," which carries every drawback of an unlock schedule and none of the
credibility. So treat this as a **one-way door**: locking can be added later
only while the coins are still undistributed, because nothing can un-distribute
them. Settle the question before any public distribution, not after.

### Where the coin is used

**Launching a basket costs $TOTE.** `create_basket` takes `creation_fee_coin`
from the manager and splits it in one transaction:

- `creation_burn_bps` of it is **burned** — gone from supply, permanently
- the remainder goes to the **dev treasury**, which funds the build

**The fee targets $15 per launch, not a fixed number of coins.** A constant coin
amount can't hold that target on its own: if $TOTE appreciates 10x, launching
costs 10x in real terms and launches stop — which stops the burn the whole
supply story rests on — and if it craters, the fee stops filtering anything and
spam baskets return. So `creation_fee_coin` is treated as a *cached quote* of
the $5 target, and `app/scripts/repeg-coin-fee-devnet.mts` re-quotes it through
`update_coin_terms` when it drifts more than 25%. The launch form shows the live
dollar value next to the fee, so drift is visible to anyone launching rather
than only to whoever runs the script.

What the target implies, at a 1,000,000,000 genesis supply:

| $TOTE fully-diluted valuation | Price / coin | $15 launch fee |
|---|---|---|
| $50,000 | $0.00005 | 300,000 TOTE |
| $500,000 | $0.0005 | 30,000 TOTE |
| $5,000,000 | $0.005 | 3,000 TOTE |

The split stays 70% burned / 30% dev. Both knobs move with
`update_coin_terms`, both are bounded by hardcoded limits the authority cannot
cross:

| Limit | Value | What it protects |
|---|---|---|
| `MIN_CREATION_BURN_BPS` | 50% | The burn can never be switched off or shrunk below half the fee |
| `MAX_CREATION_FEE_COIN` | 1% of genesis supply | New managers can never be priced out |

So the launchpad working *is* the tokenomics: every basket anyone creates
retires coin supply and pays for development, in the same instruction, with no
discretionary step in between.

### The burn vault

`CoinConfig.burn_vault` is a token account owned by the coin PDA. Anyone can
send $TOTE into it with an ordinary transfer, and the only instruction that can
ever move those coins again is `crank_burn`, which burns the entire balance and
is **permissionless** — anyone can call it, and the only possible outcome is a
smaller supply. Nothing in the program can withdraw from it.

That is the hook for protocol revenue. Note that basket fees are currently
zero, so the protocol's share of them is zero too — the SOL launch fee is the
only revenue today. If fees ever return, that share arrives as basket tokens
and underlyings, and once step 2 routes payouts
through Jupiter, the treasury can swap that revenue to $TOTE, send it to the
burn vault, and let anyone crank it. Until then the vault is live but only
holds what people voluntarily send it. **The swap-and-send step is off-chain
and discretionary — it is a policy, not a guarantee the program enforces.**

`CoinConfig` keeps running totals (`total_burned`, `total_dev_fees`,
`baskets_funded`) and every burn emits an event, so circulating supply and
lifetime burn are both verifiable without trusting a dashboard.

### Adding a new $TOTE sink

Basket creation is the first use of $TOTE, not the only planned one. Anything
that burns $TOTE **must** go through `utils::burn_coin`, which performs the CPI,
reloads the mint, and increments `total_burned` as one unit. Do not call
`token::burn` on the coin mint directly.

`total_burned` is not a dashboard counter. It is the meter every public claim
about the supply rests on and the only on-chain record that supply actually
shrank, so a burn that doesn't increment it is a burn that didn't happen as far
as the protocol is concerned. (It would also be the natural gate for a
burn-linked release schedule, if one were ever added — nothing commits to that
today.) The opposite mistake matters too:
`redeem_basket` and `claim_fees` both call `token::burn` on a *basket* mint, and
those must never touch this counter.

`total_burned_accounts_for_every_coin_that_left_the_supply` in
`tests-e2e/tests/lifecycle.rs` enforces this. It runs every path that burns
anything and asserts `total_burned == COIN_TOTAL_SUPPLY - supply`, so it fails
in both directions — an uncounted coin burn and a wrongly-counted basket-token
burn. If you add a sink and that test goes red, the sink is wrong, not the test.

One caveat for a sink that **locks or stakes** $TOTE rather than burning it:
locked float and burned supply compound against a fixed supply, which squeezes
the tradeable float and drives the price up — and every fee quoted as a fixed
number of coins then gets more expensive at once. Price such a sink against a
dollar target, the way the creation fee is (see the fee model below).

### What the coin deliberately is not

It does not entitle holders to fees, it is not required to hold or trade a
basket token, and it does not vote on anything. Adding a revenue share or
governance means a securities question that a lawyer should answer first — the
roadmap items below are written on that assumption.

### Deployment order

`initialize_config` → `initialize_coin` → distribute from the genesis wallet →
baskets. `create_basket` reads the coin config, so no basket can be created
before the coin exists. Set `creation_fee_lamports` to 0 once the $TOTE fee is
live, unless you want to keep a small SOL charge as a spam deterrent.

### Deploying to devnet

```bash
scripts/deploy-devnet.sh
```

Builds with `cargo-build-sbf` and deploys/upgrades the program on devnet. It refuses to run
if `target/deploy/everything_etf-keypair.json`'s pubkey doesn't match `declare_id!` — which is
expected on any machine that doesn't have the real deploy keypair, since that keypair is a
private key and is never committed (`target/` is gitignored). See the script's header comment
for how to resolve that, and `--help` for all flags. It stops after the binary is live;
`initialize_config`/`initialize_coin` above are separate, one-time admin calls.

## How a basket works

1. A **manager** creates a basket from 2 to 10 existing SPL / Token-2022 coins
   and chooses each one's share. Equal weight is the default the launch form
   offers, not a rule the program enforces — `seed_basket` takes whatever
   amounts it is handed, and whatever ratio the first deposit lands in *is* the
   basket. Nothing rebalances afterwards, so those weights drift with price: a
   basket seeded 25/25/25/25 reads 40/20/20/20 once one coin doubles.
2. The manager **seeds** it with the first deposit and receives the first basket tokens.
3. Anyone can **mint** basket tokens by depositing each underlying pro-rata (at NAV),
   or **redeem** them for their share of every underlying.
4. A **basket/SOL pool** (Raydium/Meteora) makes the token buyable in pump.fun and fomo
   through their aggregators. Arbitrageurs keep the pool price near NAV by minting
   when the pool is above NAV and redeeming when it's below.

## Fee model

**A basket charges nothing.** The one-time launch fee is the only fee in the
protocol.

| Item | Value |
|---|---|
| $TOTE launch fee | `creation_fee_coin`, targeting ~$15 — burned / dev split, see above |
| SOL launch fee | `creation_fee_lamports`, 0.1 SOL by default |
| Mint fee | **0** — `MAX_MINT_FEE_BPS` is 0 |
| Redeem fee | **0** — `MAX_REDEEM_FEE_BPS` is 0 |
| Streaming (management) fee | **0** — `MAX_STREAMING_FEE_BPS` is 0 |
| Protocol share of basket fees | moot while the caps are zero (hard cap 30%) |
| Payout split, if fees ever return | 75% cash leg / 25% basket tokens |

All three caps are compiled into the program rather than stored as settings, so
there is no authority — creator or protocol — that can introduce a fee on a
basket that already exists.

### Why zero rather than low

The market the caps were originally set against charges something: Index Coop's
DPI charges 0.95%/yr streaming with **0% mint and 0% redeem**; MVI charges
1.5%/yr on the same zero/zero basis; Symmetry runs with management and
performance fees disabled entirely. Charging less than that was the first
decision; charging nothing was the second.

Mint and redeem were never ordinary revenue lines — they are the arbitrage path
that keeps a basket trading at NAV. Every basis point charged there widens the
band the price can drift inside before correcting it becomes profitable, and
holders pay for that band as tracking error. At zero there is no band.

That leaves a creator earning the way every other holder does: they hold 100%
of the starting supply, so their return is the basket appreciating. There is no
fee stream to harvest, and nothing being steadily sold into the market.

For the SOL leg: pump.fun charges 0.02 SOL platform plus ~0.012 SOL of rent, and
the market has since moved toward free creation monetised by trading fees — which
is exactly the lever this protocol has given up. 0.1 SOL is above pump.fun's and
intended to be: a basket allocates a mint, metadata, a fee escrow and one vault
per asset, and launching one is a fund launch rather than a naked token mint.
Account rent is about 0.015 SOL of that and is refundable, not revenue.

The fee plumbing (`fee_escrow`, `accrue_fees`, `claim_fees`, `lower_fees`,
`protocol_share_bps`) is left in place but unreachable: nothing accrues and
there is never anything to claim. Future revenue is intended to come from
mechanics beside the basket rather than from taxing it.

### The only ways value leaves a vault

1. `redeem_basket`: only to the holder burning their own tokens.
2. `claim_fees`: amount fixed by on-chain ledgers, paid only to the manager or the protocol treasury.
3. *(step 6)* rebalance swaps, bounded by oracle prices.

`lower_fees` still exists but can only ever restate zero: with every cap at
zero, any non-zero value is an increase and is rejected.

> **Upgrade authority is the master key.** Whoever holds the program's upgrade authority can
> change every rule above. Before mainnet, put it behind a multisig and timelock, or freeze
> the program after audit, and show who holds it on every basket page.

### Admin roles

Four distinct powers, which should not share a key:

| Role | What it can do | Devnet today |
|---|---|---|
| Program upgrade authority | Rewrite every rule in this document | `9YKU84a5…` |
| `Config.authority` | Change terms for future baskets, claim protocol fees, rotate itself | `9YKU84a5…` |
| `Config.treasury` | Receives SOL launch fees | `7DDdySxh…` |
| `CoinConfig.dev_treasury` | Receives the un-burned share of $TOTE launch fees | `B8AHAB11…` |

The two treasuries are already separate (`split-admin-roles-devnet.mts`). The
first two still share one key, which is the gap worth closing: that key can both
operate the protocol *and* replace the program underneath it, so a single
compromise is total.

Separating them is one command, and the receiving key already exists and is
funded:

```bash
solana program set-upgrade-authority <program-id> \
  --upgrade-authority keys/devnet-admin.json \
  --new-upgrade-authority <upgrade-authority pubkey> \
  --url devnet
```

After that, `scripts/deploy-devnet.sh` needs `--deployer` pointed at the
upgrade-authority key rather than the admin key — deploying is the one thing
the admin key will no longer be able to do, which is the point.

Two further steps remain, and neither is a key move:

- **Multisig.** A single separate key is separation of duties, not shared
  custody. Real protection means the upgrade authority being a Squads multisig,
  so no one person can upgrade alone.
- **Timelock.** Nothing in the program delays an upgrade, so even a multisig can
  change the rules with no warning to anyone holding a basket. A timelock is a
  program change, not a configuration one.

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
| `create_basket` | anyone (becomes manager); costs $TOTE | `[asset_mint, vault]` |
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
  lower fees); `tests/edge_cases.rs` covers every `require!`/constraint the program checks —
  fee caps, asset-count bounds, duplicate/freezable assets, slippage, unauthorized claims, and
  so on — asserting the exact `EtfError` each one returns.

```bash
cargo-build-sbf --manifest-path programs/everything-etf/Cargo.toml --arch v1  # -> target/deploy/everything_etf.so
cargo test -p tests-e2e
```

`--arch v1` matters as much as `--manifest-path`. Recent `cargo-build-sbf` releases default to
`--arch v3`, which emits an SBPF v3 binary that litesvm 0.12 (and the pinned Agave in CI) refuses
to load with a bare `InvalidAccountData` — and which lands in `target/sbpfv3-solana-solana/`
instead of `target/sbpf-solana-solana/`, so the only visible symptom is every `tests-e2e` test
failing at `add_program_from_file`. The deployed devnet program is v1; keep building v1.

`--manifest-path` matters: a bare `cargo-build-sbf` from the workspace root also tries to
build `tests-e2e` (litesvm and friends) for the SBF target, which fails — those crates are
host-only.

On Windows without Visual Studio installed, `cargo-build-sbf` and some of `tests-e2e`'s
dependencies need a linker/CRT configured manually (e.g. via `xwin` + `lld-link` from
Solana's own platform-tools) through a machine-specific `.cargo/config.toml`, which is
gitignored since it hardcodes local paths.

## Web app

[`app/`](app/) is a Next.js frontend — connect a wallet, create/seed/mint/redeem baskets,
claim fees, and run the one-time protocol/coin setup. See [`app/README.md`](app/README.md)
for setup; it talks to whatever program ID/cluster you point it at via `.env.local`; there's
no Anchor TS client involved (no Anchor CLI in this toolchain to generate an IDL from), so it
hand-builds every instruction itself under `app/src/lib/etf/`.

## Roadmap

1. ✅ **v0.1:** $TOTE, baskets, in-kind mint/redeem, fees, events *(this release)*
2. Jupiter-routed SOL deposits/redemptions, plus a SOL cash leg in `claim_fees`
3. Seed a Solana pool and confirm visibility in the pump.fun and fomo UIs
4. LayerZero OFT Adapter on Solana and an OFT contract on Robinhood Chain
5. Ramses pool on Robinhood Chain
6. Oracle-priced rebalance crank to 1/N, probation/taper of underperformers,
   manager reserve and replacement proposals, timelocked changes
7. Launchpad UI and basket pages (holdings, history, manager track record), plus a
   public tokenomics page: circulating supply, lifetime burn, burn per basket
8. Treasury policy for revenue → $TOTE → burn vault, and (lawyer permitting) a
   creation-fee discount for managers who lock $TOTE

## Disclaimer

Experimental software. Not financial or legal advice. Basket tokens built on memecoins can
lose most or all of their value. Before launch, a securities lawyer should review the
product, including the use of the word "ETF."
