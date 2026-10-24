# Testing Tote

A repeatable path from a clean checkout to exercising the whole protocol. Two
layers: **automated tests** (run these first — they're fast and catch drift) and
a **manual/scripted devnet run** (proves the deployed program + the TS client
work end to end).

The devnet program is already deployed **and initialized** at
[`9mT7xrj7xWiTPkH8pMQ8yzz8d8Fs9TacqyYQ61yPUzyq`](https://explorer.solana.com/address/9mT7xrj7xWiTPkH8pMQ8yzz8d8Fs9TacqyYQ61yPUzyq?cluster=devnet),
so you don't need to build or deploy anything to start testing.

---

## 1. Automated tests

| Test | Command | Runs on Windows? |
|---|---|---|
| Rust fee/share math (15 cases) | `cargo test -p everything-etf` | ✅ |
| Weight-allocator math | `cd app && npx tsx tests/weights.mts` | ✅ |
| Pool seed-at-NAV math | `cd app && npx tsx tests/pool.mts` | ✅ |
| Program end-to-end (litesvm) | `cargo test -p tests-e2e` | ❌ WSL/Linux/CI only |
| TS ⇄ Rust consistency | `cd app && npx tsx tests/program-consistency.mts` | ❌ WSL/Linux/CI only |

**Windows note on `cargo`:** if `cargo` isn't on your PATH, it's installed at
`%USERPROFILE%\.cargo\bin\cargo.exe` — call it by full path, or add that dir to
PATH.

**Why two tests are CI/WSL-only:** `litesvm`'s npm package ships no Windows
binary, and the e2e build needs `cargo-build-sbf --arch v1` plus a machine-
specific linker/CRT setup (see root README → "Testing"). Both run green in
[CI](.github/workflows/ci.yml); don't spend time fighting them on Windows.

---

## 2. Manual end-to-end on devnet (via the web app)

### Setup (one time)
```bash
cd app
npm install
# .env.local already points at the deployed devnet program + devnet RPC:
#   NEXT_PUBLIC_ETF_PROGRAM_ID=9mT7xrj7xWiTPkH8pMQ8yzz8d8Fs9TacqyYQ61yPUzyq
#   NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
npm run dev          # http://localhost:3000
```
Connect a browser wallet set to **devnet** and fund it:
`solana airdrop 2 <your-wallet> --url devnet` (repeat if rate-limited).

### The flow to exercise
1. **Create a basket** (`/baskets/new`). Devnet has no real tokens, so use the
   form's built-in "create stand-in tokens" helper (it mints test SPL tokens
   with metadata — `app/src/lib/etf/devHelpers.ts`). Pick 2–10, set weights, launch.
   - Creating a basket burns the **$TOTE creation fee** (`creation_burn_bps`
     burned, remainder to the dev treasury).
2. **Seed it** — the manager's first deposit sets the starting ratio.
3. **Mint** more at NAV (in-kind: deposit each underlying pro-rata).
4. **Redeem** some back for the underlyings.
5. **crank_burn** (permissionless) from `/admin` — burns whatever sits in the
   $TOTE burn vault.

### What to verify
- The basket page (`/baskets/[id]`) shows **"Fees: None"** (mint/redeem/holding
  are all free — the launch fee is the only fee).
- The `/tote` page / `LiveStats` show `CoinConfig` running totals
  (`total_burned`, `total_dev_fees`, `baskets_funded`) moving as you create and
  crank.
- A mint immediately followed by an equal redeem never returns more than you put
  in (rounding favours the vault).

### Faster: scripted lifecycle
Does create → seed → mint → redeem in one command against devnet, using the same
TS client the app uses:
```bash
cd app
npx tsx scripts/demo-basket-devnet.mts \
  --program-id 9mT7xrj7xWiTPkH8pMQ8yzz8d8Fs9TacqyYQ61yPUzyq \
  --manager ../keys/devnet-admin.json
```
It prints the new basket's `/baskets/<id>` URL to open in the running app.

---

## 3. Known devnet limitations (not bugs)

- **"Buy/Sell with SOL" can't quote on devnet.** The zap routes through Jupiter,
  whose index is mainnet-only, so `ZapTrade` shows "can't quote" and you fall
  back to the in-kind seed/mint/redeem forms. (Pricing/NAV also reads mainnet
  Jupiter, so stand-ins are priced *as* the real token they stand in for.)
- **Pool seeding is mainnet-only.** `pool.ts` computes the seed-at-NAV amounts
  and venue links now, but `buildSeedPoolPlan` is wired at mainnet-launch time —
  devnet has no Raydium liquidity and the aggregator UIs (pump.fun/fomo) don't
  index devnet, so there's nothing to seed or verify there.
- **Admin keys share a wallet.** On devnet one key plays upgrade authority,
  protocol treasury, $TOTE genesis owner and dev treasury. See root README →
  "Admin roles" for the split required before mainnet.
