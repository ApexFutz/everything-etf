import Link from "next/link";
import { Card, Section } from "@/components/ui";
import {
  BASKET_DECIMALS,
  MAX_ASSETS,
  MAX_MINT_FEE_BPS,
  MAX_REDEEM_FEE_BPS,
  MAX_STREAMING_FEE_BPS,
  MIN_ASSETS,
  MIN_CREATION_BURN_BPS,
} from "@/lib/etf/constants";
import { CREATION_FEE_USD_TARGET } from "@/lib/etf/pricing";
import { formatBps } from "@/lib/format";

export const metadata = {
  title: "Terms & what it costs",
  description:
    "What launching costs, why baskets charge no ongoing fees, and what can never be changed.",
};

/**
 * The page a creator should be able to read before spending anything.
 *
 * The point is no surprises after the fact: what it costs, why a basket charges
 * nothing once it exists, and a plain list of what is permanent. Someone should
 * be able to finish this page and price the decision themselves rather than
 * guess and find out later.
 */
export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-6 py-10">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Terms &amp; what it costs</h1>
        <p className="leading-relaxed text-muted">
          Read this before you spend anything. It covers what launching costs, why a basket charges
          nothing after that, and the decisions that are permanent once it exists. None of it
          changes after you launch — that is the point of writing it down.
        </p>
      </header>

      {/* ------------------------------------------------------------ cost */}
      <Section title="1. What launching costs you" id="cost">
        <Card className="space-y-4 text-sm leading-relaxed">
          <p>Three separate things, and only two of them are fees:</p>
          <dl className="space-y-3">
            <div>
              <dt className="font-medium">$EETF launch fee</dt>
              <dd className="text-muted">
                Targets about ${CREATION_FEE_USD_TARGET} worth of $EETF. It is stored on-chain as a
                fixed number of coins and re-quoted as the $EETF price moves, so the dollar cost
                stays roughly flat rather than tracking the token. The exact coin amount is shown on
                the launch page before you confirm.{" "}
                <strong>At least {formatBps(MIN_CREATION_BURN_BPS)} of it is burned</strong> —
                destroyed, not collected — and the remainder funds development. The burn share is
                floored in the program and cannot be switched off.
              </dd>
            </div>
            <div>
              <dt className="font-medium">SOL protocol fee</dt>
              <dd className="text-muted">
                A flat amount of SOL to the protocol treasury, shown on the launch page. This is
                revenue.
              </dd>
            </div>
            <div>
              <dt className="font-medium">Account rent — not a fee</dt>
              <dd className="text-muted">
                Solana charges rent to hold accounts open, and a basket opens several: the basket
                itself, its token mint, its metadata, a fee escrow, one vault per asset, and your own
                token account. This is a <strong>refundable deposit</strong>, not revenue. Nobody
                receives it, and it comes back if those accounts are ever closed. It scales with how
                many assets you pick.
              </dd>
            </div>
          </dl>
          <p className="text-muted">
            You also deposit your initial buy — the actual tokens that go into the basket. That is
            not a cost; you receive 100% of the basket&apos;s starting supply in exchange, and you
            still own the value.
          </p>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ fees */}
      <Section title="2. What a basket charges: nothing" id="fees">
        <div className="space-y-4">
          <Card className="space-y-4 text-sm leading-relaxed">
            <p>
              <strong>There are no ongoing fees of any kind.</strong> Minting basket tokens, holding
              them and redeeming them are free — for you, and for everyone who ever holds your
              basket. The launch fee above is the only fee in the protocol.
            </p>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[30rem] text-sm">
                <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Action</th>
                    <th className="px-4 py-2.5 font-medium">Fee</th>
                    <th className="px-4 py-2.5 font-medium">Hard cap</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border bg-surface">
                  {(
                    [
                      ["Mint basket tokens", MAX_MINT_FEE_BPS],
                      ["Redeem basket tokens", MAX_REDEEM_FEE_BPS],
                      ["Hold, per year", MAX_STREAMING_FEE_BPS],
                    ] as const
                  ).map(([label, cap]) => (
                    <tr key={label}>
                      <td className="px-4 py-2.5 font-medium">{label}</td>
                      <td className="px-4 py-2.5 text-muted">Free</td>
                      <td className="px-4 py-2.5 tabular-nums">{formatBps(cap)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-muted">
              Those caps are <strong>compiled into the program</strong> rather than stored as
              settings, so no authority anywhere — not the creator, not the protocol — can raise them
              later. A fee cannot appear on a basket you already hold.
            </p>
          </Card>

          <Card className="space-y-4 text-sm leading-relaxed">
            <div>
              <h3 className="font-medium">Then how does a creator make money?</h3>
              <p className="mt-1 text-muted">
                By the basket going up. Your initial buy mints the basket&apos;s entire starting
                supply to you, so you begin holding 100% of it. If the coins you picked appreciate,
                your position appreciates with them — exactly like every other holder&apos;s. There
                is no fee stream, which also means there is nothing for anyone to extract from
                holders, and nothing being steadily sold into the market.
              </p>
            </div>
            <div>
              <h3 className="font-medium">Why zero rather than low</h3>
              <p className="mt-1 text-muted">
                Minting and redeeming at true value is the mechanism that keeps a basket&apos;s market
                price tracking the coins inside it. A fee on either side widens the band the price can
                drift within before correcting it becomes profitable for an arbitrageur, and holders
                pay for that band as tracking error. At zero there is no band.
              </p>
            </div>
            <div>
              <h3 className="font-medium">What that guarantees you as a holder</h3>
              <p className="mt-1 text-muted">
                You can always redeem basket tokens for a pro-rata slice of the underlying coins at
                net asset value, free, without permission from anyone. That is the floor under the
                basket&apos;s price, and nothing in the program can remove it.
              </p>
            </div>
          </Card>
        </div>
      </Section>

      {/* ------------------------------------------------------- permanent */}
      <Section title="3. What is permanent" id="permanent">
        <Card className="space-y-3 text-sm leading-relaxed">
          <p className="text-muted">
            These are set when the basket is created and cannot be changed by you, by the protocol,
            or by anyone else afterwards. This is the list worth reading twice.
          </p>
          <ul className="space-y-2.5">
            {[
              [
                "It will never charge a fee",
                "All three fee caps are zero and compiled in, so no fee can be introduced on this basket later by anyone.",
              ],
              [
                "The assets are fixed",
                `The coins you pick are the coins forever. There is no adding, removing or swapping, and between ${MIN_ASSETS} and ${MAX_ASSETS} are allowed.`,
              ],
              [
                "Weights are equal and do not rebalance",
                "Every asset gets an equal share by design. The basket does not rebalance, so weights drift with price and the basket tracks whatever the coins do from here.",
              ],
              [
                "The name, symbol and metadata are frozen",
                "Created immutable. They cannot be edited later.",
              ],
              [
                "Assets with a freeze authority are rejected",
                "The program refuses any mint whose freeze authority still exists, because whoever holds that key could freeze the vault and trap every holder's assets. This is checked before you pay.",
              ],
              [
                "You cannot un-launch it",
                "There is no delete. The basket, its mint and its vaults exist from then on.",
              ],
            ].map(([title, body]) => (
              <li key={title} className="flex gap-3">
                <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span>
                  <strong className="font-medium">{title}.</strong>{" "}
                  <span className="text-muted">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ risk */}
      <Section title="4. Do your own homework" id="risk">
        <Card className="space-y-3 text-sm leading-relaxed text-muted">
          <p>
            A few things that are true and worth knowing before you decide whether launching is worth
            it to you:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="font-medium text-foreground">
                The launch fee is a cost, not an investment.
              </strong>{" "}
              You pay it once and it does not come back. Most of the $EETF portion is burned
              outright. If the basket goes nowhere, that money is simply gone.
            </li>
            <li>
              <strong className="font-medium text-foreground">
                Your only return is the basket appreciating.
              </strong>{" "}
              There are no fees to collect. If the coins you picked fall, you lose — on the same terms
              as everyone holding your basket, because you hold it too.
            </li>
            <li>
              <strong className="font-medium text-foreground">
                Nobody is managing anything for you.
              </strong>{" "}
              There is no strategy, no rebalancing and no active management. A basket mechanically
              holds equal shares of what you chose, so it rises and falls with those coins.
            </li>
            <li>
              <strong className="font-medium text-foreground">This is pre-audit software.</strong>{" "}
              The program has an automated test suite but has not had a third-party security audit.
              Bugs can lose funds.
            </li>
          </ul>
          <p>
            Basket tokens built on memecoins can lose most or all of their value. Nothing on this
            site is financial, investment, tax or legal advice, and none of it is a promise about
            what any basket will do.
          </p>
        </Card>
      </Section>

      <p className="text-sm text-muted">
        The exact numbers for your basket — the coin amount, the SOL, and the rent for your asset
        count — are all shown on{" "}
        <Link href="/baskets/new" className="text-accent underline decoration-dotted underline-offset-2">
          the launch page
        </Link>{" "}
        before you confirm anything. Every limit above is enforced by the program, and the caps are
        compiled into it rather than configured, so they hold regardless of what any interface says.
      </p>
      <p className="text-xs text-muted">Basket tokens use {BASKET_DECIMALS} decimals.</p>
    </div>
  );
}
