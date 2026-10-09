import Link from "next/link";
import { LiveStats } from "@/components/LiveStats";
import { Banner, ButtonLink, Card, Pill, Section } from "@/components/ui";
import {
  COIN_TOTAL_SUPPLY,
  MAX_ASSETS,
  MAX_MINT_FEE_BPS,
  MAX_REDEEM_FEE_BPS,
  MAX_STREAMING_FEE_BPS,
  MIN_ASSETS,
  MIN_CREATION_BURN_BPS,
} from "@/lib/etf/constants";
import { formatBps, formatTokens } from "@/lib/format";

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl px-6">
      {/* ---------------------------------------------------------------- hero */}
      <section className="grid items-center gap-10 py-14 lg:grid-cols-[1.15fr_1fr] lg:py-20">
        <div>
          <Pill tone="warn">Pre-audit · devnet only</Pill>
          <h1 className="mt-4 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            Equal-weight basket tokens,
            <br />
            <span className="text-accent">launched by anyone.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted">
            Bundle {MIN_ASSETS}–{MAX_ASSETS} Solana tokens into one tradeable basket. Mint and redeem
            in kind at NAV, so the basket is always backed by exactly what it holds — and every
            launch permanently burns $EETF supply.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <ButtonLink href="/baskets">Browse baskets</ButtonLink>
            <ButtonLink href="/baskets/new" variant="secondary">
              Launch a basket
            </ButtonLink>
          </div>
          <p className="mt-4 text-xs text-muted">
            Running on devnet. You&apos;ll need a wallet set to devnet — the create page can mint you
            test tokens to build a basket from.
          </p>
        </div>
        <BasketDiagram />
      </section>

      <LiveStats />

      <div className="mt-6">
        <Banner kind="warn">
          <strong>Not audited, and not for real funds.</strong> The fee and share math is unit-tested
          and the whole protocol is exercised end-to-end against the compiled program in CI, but it
          has had no security review. The deployment&apos;s upgrade authority is also still a single
          hot wallet, which means whoever holds it could change every rule below.
        </Banner>
      </div>

      <div className="space-y-16 py-16">
        {/* ------------------------------------------------------ how it works */}
        <Section
          id="how-it-works"
          title="How a basket works"
          lead="No oracles, no price feeds, no trusted pricing step. Everything is priced by the vault's own contents."
        >
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                step: "01",
                title: "Create",
                body: `A manager picks ${MIN_ASSETS}–${MAX_ASSETS} existing SPL or Token-2022 mints and names the basket. It charges no fees — they pay a one-time launch fee instead.`,
              },
              {
                step: "02",
                title: "Seed",
                body: "The manager makes the first deposit and receives the first basket tokens, setting the starting supply. Only they can seed, which blocks first-depositor share attacks.",
              },
              {
                step: "03",
                title: "Mint & redeem",
                body: "Anyone deposits every underlying pro-rata to mint at NAV, or burns basket tokens to redeem their share of each one. Always in kind.",
              },
              {
                step: "04",
                title: "Arbitrage",
                body: "A basket/SOL pool makes it buyable anywhere Solana tokens trade. Arbitrageurs mint when the pool trades above NAV and redeem when below, holding the peg.",
              },
            ].map((s) => (
              <li key={s.step}>
                <Card className="h-full">
                  <div className="font-mono text-xs text-accent">{s.step}</div>
                  <h3 className="mt-2 font-semibold">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
                </Card>
              </li>
            ))}
          </ol>
        </Section>

        {/* ------------------------------------------------------------- $EETF */}
        <Section
          id="eetf"
          title="$EETF: the launchpad working is the tokenomics"
          lead="One fixed-supply coin for the whole protocol. No inflation schedule, no staking emissions, no rebase — after genesis, the only supply event is a burn."
        >
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <h3 className="font-semibold">Fixed at genesis</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {formatTokens(COIN_TOTAL_SUPPLY, 9)} EETF minted once, inside{" "}
                <code className="text-xs">initialize_coin</code>, which revokes the mint authority in
                the same transaction and fails if it isn&apos;t actually gone. Supply can only ever
                fall.
              </p>
            </Card>
            <Card>
              <h3 className="font-semibold">Every launch burns</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Creating a basket costs $EETF. At least{" "}
                <strong className="text-burn">{formatBps(MIN_CREATION_BURN_BPS)}</strong> of that fee
                is burned on the spot — a floor the protocol authority cannot lower — and the rest
                funds development.
              </p>
            </Card>
            <Card>
              <h3 className="font-semibold">A one-way burn vault</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Anyone can send $EETF to the burn vault, and the only instruction that moves it again
                destroys it. Cranking that burn is permissionless: the only possible outcome is a
                smaller supply.
              </p>
            </Card>
          </div>

          <Card className="mt-4 border-dashed">
            <h3 className="font-semibold">What the coin deliberately is not</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              $EETF does <strong>not</strong> entitle holders to any share of fees, is{" "}
              <strong>not</strong> required to hold or trade a basket token, and does{" "}
              <strong>not</strong> vote on anything. Adding a revenue share or governance raises a
              securities question that belongs with a lawyer before it belongs in code.
            </p>
          </Card>

          <div className="mt-4">
            <Link href="/eetf" className="text-sm text-accent underline decoration-dotted underline-offset-2">
              See live supply and burn figures →
            </Link>
          </div>
        </Section>

        {/* --------------------------------------------------------- fee model */}
        <Section
          title="Fees, and the caps on them"
          lead="Managers set their own fees but can never exceed limits hardcoded in the program. They can lower them instantly; raising them above a cap is impossible, not merely discouraged."
        >
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[32rem] text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Fee</th>
                  <th className="px-4 py-2.5 font-medium">Set by</th>
                  <th className="px-4 py-2.5 font-medium">Hard cap</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-surface">
                {[
                  ["Mint a basket token", "Nobody — free", formatBps(MAX_MINT_FEE_BPS)],
                  ["Redeem", "Nobody — free", formatBps(MAX_REDEEM_FEE_BPS)],
                  ["Hold (annual)", "Nobody — free", formatBps(MAX_STREAMING_FEE_BPS)],
                  ["Launch a basket", "The creator, once", "$EETF + SOL"],
                ].map(([fee, who, cap]) => (
                  <tr key={fee}>
                    <td className="px-4 py-2.5 font-medium">{fee}</td>
                    <td className="px-4 py-2.5 text-muted">{who}</td>
                    <td className="px-4 py-2.5 tabular-nums">{cap}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            <strong>A basket charges nothing, ever.</strong> Creating one costs a one-time launch
            fee in $EETF and SOL, and after that minting, holding and redeeming are all free. Those
            three caps are zero in the compiled program, not settings, so no authority can raise
            them on a basket you already hold.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Two things follow. The basket tracks its net asset value as tightly as the mechanism
            allows, because every basis point charged on the way in or out widens the gap the market
            price can drift before arbitrage pays to close it — at zero there is no gap. And a
            creator earns by being right rather than by extracting: they hold 100% of the starting
            supply, so they make money the same way every other holder does.
          </p>
        </Section>

        {/* ------------------------------------------------------ asset safety */}
        <Section
          title="What a basket refuses to hold"
          lead="A vault you can't exit is worse than no vault. These are rejected at creation, not flagged after."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <h3 className="font-semibold">Freeze authorities</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Any mint with a freeze authority is rejected outright: whoever held it could freeze
                the basket&apos;s vault and trap every holder&apos;s assets inside.
              </p>
            </Card>
            <Card>
              <h3 className="font-semibold">Hostile Token-2022 extensions</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Transfer fees break pro-rata accounting, permanent delegates can drain a vault, and
                transfer hooks can block exits. Only metadata and group pointers are allowed through.
              </p>
            </Card>
          </div>
        </Section>

        {/* --------------------------------------------------------------- cta */}
        <section className="rounded-2xl border border-border bg-surface-2 px-6 py-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">Launch one on devnet</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted">
            The create page can mint you a set of test tokens, so you can go from nothing to a live,
            mintable basket in a couple of transactions.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <ButtonLink href="/baskets/new">Launch a basket</ButtonLink>
            <ButtonLink href="/baskets" variant="secondary">
              Browse existing
            </ButtonLink>
          </div>
        </section>
      </div>
    </div>
  );
}

/** N underlying assets converging into a single basket token. */
function BasketDiagram() {
  const assets = [
    { cy: 26, label: "A" },
    { cy: 76, label: "B" },
    { cy: 126, label: "C" },
    { cy: 176, label: "D" },
  ];
  return (
    <div className="relative">
      <svg
        viewBox="0 0 340 210"
        className="w-full"
        role="img"
        aria-label="Four underlying assets, each one quarter of the basket, combining into a single basket token"
      >
        {assets.map((a, i) => (
          <g key={a.label}>
            <path
              d={`M 74 ${a.cy} C 140 ${a.cy}, 150 105, 214 105`}
              fill="none"
              stroke="var(--border-strong)"
              strokeWidth="1.5"
            />
            <circle cx="46" cy={a.cy} r="22" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="1.5" />
            <text
              x="46"
              y={a.cy + 4}
              textAnchor="middle"
              className="fill-[var(--muted)] font-mono"
              fontSize="11"
            >
              1/{assets.length}
            </text>
            <text x="46" y={a.cy - 30} textAnchor="middle" className="fill-[var(--muted)]" fontSize="9">
              {`Asset ${a.label}`}
            </text>
            <circle cx="214" cy="105" r="3" fill="var(--accent)" opacity={0.25 + i * 0.25} />
          </g>
        ))}
        <rect
          x="232"
          y="69"
          width="86"
          height="72"
          rx="14"
          fill="var(--accent-soft)"
          stroke="var(--accent)"
          strokeWidth="1.5"
        />
        <text x="275" y="100" textAnchor="middle" className="fill-[var(--accent)] font-semibold" fontSize="12">
          1 basket
        </text>
        <text x="275" y="117" textAnchor="middle" className="fill-[var(--accent)]" fontSize="10">
          token
        </text>
      </svg>
      <p className="mt-2 text-center text-xs text-muted">
        Each asset is 1/N of the basket by design. Redeem any time for your share of all of them.
      </p>
    </div>
  );
}
