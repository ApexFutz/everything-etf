import Link from "next/link";
import { Card, Section } from "@/components/ui";
import {
  BASKET_DECIMALS,
  MAX_ASSETS,
  MAX_MINT_FEE_BPS,
  MAX_PROTOCOL_SHARE_BPS,
  MAX_REDEEM_FEE_BPS,
  MAX_STREAMING_FEE_BPS,
  MIN_ASSETS,
  MIN_CREATION_BURN_BPS,
} from "@/lib/etf/constants";
import { CREATION_FEE_USD_TARGET } from "@/lib/etf/pricing";
import { formatBps } from "@/lib/format";

export const metadata = {
  title: "Terms & how the fees work",
  description:
    "Every rate, how each one is calculated, and what can never be changed once a basket is live.",
};

/**
 * The page a creator should be able to read before spending anything.
 *
 * The point is no surprises after the fact: every rate, the arithmetic behind
 * it, worked examples with real numbers, and — the part that actually bites —
 * a plain list of what is permanent. Someone should be able to finish this page
 * and price the decision themselves rather than guess and find out later.
 */
export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-6 py-10">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Terms &amp; how the fees work</h1>
        <p className="leading-relaxed text-muted">
          Read this before you spend anything. It covers every fee, the arithmetic behind each one,
          and the decisions that are permanent once your basket exists. Nothing here changes after
          you launch — that is the point of writing it down.
        </p>
      </header>

      {/* ------------------------------------------------------------ cost */}
      <Section title="1. What launching costs you" id="cost">
        <Card className="space-y-4 text-sm leading-relaxed">
          <p>
            Three separate things, and only two of them are fees:
          </p>
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
      <Section title="2. What you can charge, and how it is calculated" id="fees">
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Fee</th>
                  <th className="px-4 py-2.5 font-medium">Charged on</th>
                  <th className="px-4 py-2.5 font-medium">Hard cap</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-surface">
                <tr>
                  <td className="px-4 py-2.5 font-medium">Mint</td>
                  <td className="px-4 py-2.5 text-muted">Each new basket token created</td>
                  <td className="px-4 py-2.5 tabular-nums">{formatBps(MAX_MINT_FEE_BPS)}</td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-medium">Redeem</td>
                  <td className="px-4 py-2.5 text-muted">Nothing — always free</td>
                  <td className="px-4 py-2.5 tabular-nums">{formatBps(MAX_REDEEM_FEE_BPS)}</td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-medium">Streaming</td>
                  <td className="px-4 py-2.5 text-muted">Everything held, per year</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {formatBps(MAX_STREAMING_FEE_BPS)} / year
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-medium">Protocol share</td>
                  <td className="px-4 py-2.5 text-muted">A cut of all of the above</td>
                  <td className="px-4 py-2.5 tabular-nums">{formatBps(MAX_PROTOCOL_SHARE_BPS)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <Card className="space-y-4 text-sm leading-relaxed">
            <div>
              <h3 className="font-medium">The mint fee</h3>
              <p className="mt-1 text-muted">
                Charged when someone creates new basket tokens by depositing the underlying coins.
                It is taken in basket tokens, not in cash.
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 text-xs">
                fee = amount_minted x mint_fee_bps / 10,000
              </pre>
              <p className="mt-2 text-muted">
                At {formatBps(MAX_MINT_FEE_BPS)}, someone minting 1,000 basket tokens pays 2.5 of
                them as the fee and receives 997.5. The 2.5 goes to an escrow owned by the basket.
              </p>
            </div>

            <div>
              <h3 className="font-medium">The streaming fee</h3>
              <p className="mt-1 text-muted">
                An annual rate on the whole basket, accrued continuously rather than billed. It is
                paid by <strong>minting new basket tokens into escrow</strong>, which dilutes every
                holder slightly — including you. Nobody is charged directly; everyone&apos;s share of
                the basket shrinks a little.
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 text-xs">
                accrued = supply x streaming_fee_bps / 10,000 x (seconds elapsed / seconds per year)
              </pre>
              <p className="mt-2 text-muted">
                It is charged on <em>time</em>, so what it earns depends on how long value stays in
                the basket — not on its peak size and not on trading volume. A basket that spikes and
                fades quickly earns very little from this fee no matter how large the spike was.
              </p>
            </div>

            <div>
              <h3 className="font-medium">Redeeming is free, permanently</h3>
              <p className="mt-1 text-muted">
                The cap is zero, so no basket can ever charge to redeem. This is deliberate rather
                than generous: minting and redeeming at true value is the mechanism that keeps a
                basket&apos;s market price tracking the coins inside it. Any exit fee widens the gap
                the price can drift before correcting it becomes profitable for anyone, and holders
                pay for that gap.
              </p>
            </div>

            <div>
              <h3 className="font-medium">How you get paid</h3>
              <p className="mt-1 text-muted">
                Fees collect as basket tokens in an escrow the basket itself owns. When you claim,
                the amount is fixed by an on-chain ledger — there is no discretionary withdrawal, and
                nobody can take more than the ledger says. The payout splits{" "}
                <strong>75% &ldquo;cash leg&rdquo; / 25% basket tokens</strong>. Today the cash leg
                is paid in-kind: escrow tokens are burned and you receive a pro-rata slice of the
                underlying coins at net asset value.
              </p>
              <p className="mt-2 text-muted">
                Claiming is value-neutral — it does not dilute other holders, and it does not protect
                you from the underlying coins falling, because the cash leg pays out those same
                coins. There is no deadline and no penalty for waiting. Claim when you want to.
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
                "Your fees are a permanent ceiling",
                "You can lower them at any time and never raise them. Whatever you set at launch is the most this basket will ever charge.",
              ],
              [
                "The protocol's share is locked in",
                "The protocol's cut is snapshotted onto your basket at creation. Later changes to the protocol's terms never touch baskets that already exist — in either direction.",
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
                Trading volume is not fee volume.
              </strong>{" "}
              Nothing you earn comes from people trading your basket token on an exchange, or from
              volume in the underlying coins. You earn from tokens being <em>created</em> (mint fee)
              and from value <em>staying</em> in the basket (streaming fee). A coin can be the most
              traded thing on Solana and pay your basket nothing.
            </li>
            <li>
              <strong className="font-medium text-foreground">
                Short-lived baskets earn mostly mint fees.
              </strong>{" "}
              The streaming fee needs time to accumulate. If a basket spikes and fades over a few
              weeks, most of what it ever earns comes from the mint fee on the way in.
            </li>
            <li>
              <strong className="font-medium text-foreground">
                Fees are paid in basket tokens.
              </strong>{" "}
              Your earnings are denominated in the basket, so if the underlying coins fall, your
              accrued fees fall with them. You are taking the same risk as your holders.
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
        The exact numbers for your basket — the coin amount, the SOL, the rent for your asset count,
        and the fees you are setting — are all shown on{" "}
        <Link href="/baskets/new" className="text-accent underline decoration-dotted underline-offset-2">
          the launch page
        </Link>{" "}
        before you confirm anything. Every rate above is enforced by the program, and the caps are
        compiled into it rather than configured, so they hold regardless of what any interface says.
      </p>
      <p className="text-xs text-muted">
        Basket tokens use {BASKET_DECIMALS} decimals.
      </p>
    </div>
  );
}
