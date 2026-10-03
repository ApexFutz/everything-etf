# Everything ETF — web app

A Next.js frontend for the Everything ETF Solana program (`../programs/everything-etf`):
connect a wallet, create baskets, seed/mint/redeem, claim fees, and run the one-time
protocol/coin setup from `/admin`.

## Why there's no Anchor TS client here

This project's toolchain has no Anchor CLI available (see the repo root README's
"Testing" section), so there's no generated IDL to build an `@coral-xyz/anchor`
`Program` client from. Instead, `src/lib/etf/` hand-builds every instruction and
decodes every account directly:

- `constants.ts` — PDA seeds, fee caps, program ID (mirrors `constants.rs`)
- `discriminators.ts` — precomputed Anchor sighashes (see
  `scripts/compute-discriminators.mjs`; regenerate by hand if an instruction or
  `#[account]` struct is ever renamed in the Rust program)
- `codec.ts` — the handful of Borsh primitives this program's args/accounts use
- `instructions.ts` — one builder per instruction, each a literal transcription of its
  `#[derive(Accounts)]` struct's field order and the handler's argument list
- `accounts.ts` — decoders for `Config`/`Basket`/`CoinConfig`
- `client.ts` — the above, assembled into ready-to-send transactions (PDA derivation,
  ATA creation bundled in, etc.)

Read any of these side-by-side with its Rust counterpart; that's how they're meant to be
verified, since there's no IDL acting as a single source of truth to check against.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in NEXT_PUBLIC_ETF_PROGRAM_ID once deployed
npm run dev
```

Until `NEXT_PUBLIC_ETF_PROGRAM_ID` points at a real deployment, the app loads fine but
every account read comes back empty and every transaction fails — see the repo root's
`scripts/deploy-devnet.sh` to get a real program on devnet, then:

```bash
npx tsx scripts/initialize-devnet.mts \
  --program-id <deployed program id> \
  --admin ../keys/devnet-admin.json \
  --url https://api.devnet.solana.com
```

That runs `initialize_config` and `initialize_coin` (skipping either if already done) and
prints the `.env.local` values to use.

## Known simplifications (demo-grade, not production-grade)

- **Mint/redeem send the most permissive `max_amounts_in`/`min_amounts_out`**, not a real
  quote of each vault's live balance — fine for a devnet demo, not for real funds. Fetch
  each vault's balance and compute the actual expected deposit/payout
  (see `math.rs::deposit_for_mint`/`payout_for_burn`) before using this against anything
  that matters.
- **One keypair plays every admin role** in the initialize script (upgrade authority,
  protocol treasury, $EETF genesis owner, dev treasury) — fine for trying things out,
  not how you'd actually want a real deployment split.
- **No basket listing pagination** — `listBaskets` fetches every `Basket` account in one
  `getProgramAccounts` call, which won't scale indefinitely.
