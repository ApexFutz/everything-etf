# Deploying the Tote app (public devnet test)

Goal: a public URL a tester can open, connect a devnet wallet, and create/seed/
mint/redeem baskets. This is a **devnet** deployment — the program is already
live + initialized at `9mT7xrj7xWiTPkH8pMQ8yzz8d8Fs9TacqyYQ61yPUzyq`, so no
on-chain work is needed to go live.

The app lives in the **`app/`** subdirectory of the repo — this matters for the
host's root-directory setting below.

## Path A — Vercel (recommended, persistent, free)
1. In Vercel, **Add New → Project → Import** `ApexFutz/everything-etf`.
2. **Root Directory → `app`** (critical — the Next app isn't at the repo root).
   Framework auto-detects as Next.js; build = `next build`, no overrides needed.
3. **Environment variables:**
   - `NEXT_PUBLIC_ETF_PROGRAM_ID` = `9mT7xrj7xWiTPkH8pMQ8yzz8d8Fs9TacqyYQ61yPUzyq`
   - `NEXT_PUBLIC_RPC_URL` = your devnet RPC (see below). If omitted it falls back
     to `https://api.devnet.solana.com` (works, but rate-limits hard for a shared tester).
4. **Deploy.** You get a `*.vercel.app` URL. Pushes to `main` auto-redeploy.
   > `NEXT_PUBLIC_*` vars are inlined at **build** time — change one → redeploy.

## Dedicated devnet RPC (strongly recommended)
The public `api.devnet.solana.com` throttles aggressively and will make the app
feel broken for a tester. Grab a free devnet endpoint (Helius / QuickNode /
Alchemy) and set it as `NEXT_PUBLIC_RPC_URL`. Note it's embedded in the client
bundle (public) — fine for a devnet key; don't reuse a mainnet secret here.

## Path B — instant throwaway URL (no host account)
From `app/`, build + serve prod, then tunnel it:
```bash
npm run build && npm run start      # serves on :3000
cloudflared tunnel --url http://localhost:3000   # prints a public https URL
```
Live only while your machine runs it — fine for a quick "look at this now," not
for ongoing testing.

## What a tester does
1. Open the URL; set their wallet (Phantom etc.) to **Devnet**.
2. Fund it: `solana airdrop 2 <address> --url devnet`, or a web devnet faucet.
3. **Create a basket** (`/baskets/new`) — use the built-in "create stand-in
   tokens" helper (devnet has no real tokens).
4. **Seed → Mint → Redeem** via the on-chain forms.

## Fund a tester with $TOTE (so they can create a basket)
Creating a basket burns a $TOTE launch fee (currently 300,000 TOTE) from the
manager's wallet, and a fresh devnet wallet holds none — the app now says
"Not enough $TOTE" and blocks the launch. $TOTE's mint authority was revoked at
genesis, so you can't mint more; you **transfer** from the genesis holder (the
admin wallet). A tester sends you their wallet address, then from `app/`:
```bash
npx tsx scripts/airdrop-tote-devnet.mts --to <their-wallet-pubkey>
```
This both transfers $TOTE (five launches' worth by default) **and** tops their
devnet SOL up to 0.5 — enough to pay rent for the stand-in mints, the basket and
its vaults — so they can finish the whole flow without airdropping anything
themselves. SOL comes from the free cluster faucet, falling back to the admin
wallet if the faucet is rate-limited. Flags: `--amount <whole TOTE>`,
`--sol <target>` (or `--no-sol`), `--dry-run` to preview. Buying/redeeming
existing baskets needs no $TOTE — only creating one does.

## Devnet caveats to tell testers
- **"Buy/Sell with SOL"** can't quote on devnet (Jupiter is mainnet-only) — use
  the in-kind seed/mint/redeem forms instead.
- No DEX pools / pump.fun on devnet — that's a mainnet-launch step.
- `/admin` and `/tote` exist but testers don't need them.
