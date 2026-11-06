"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Banner, Button, Card, Field, Pill, TextInput } from "@/components/ui";
import {
  Candidate,
  DiscoverParams,
  generateCandidate,
  LIQUIDITY_BANDS,
  reweight,
  RiskTier,
  RISK_LABEL,
} from "@/lib/etf/discover";
import { MAX_ASSETS, MIN_ASSETS } from "@/lib/etf/constants";

const RISKS: RiskTier[] = ["conservative", "balanced", "degen"];
const THEME_CHIPS = ["AI", "Memes", "Dogs", "Cats", "DeFi", "Gaming", "Blue-chip"];
/** Past this many pixels of drag, releasing commits the swipe. */
const SWIPE_THRESHOLD = 110;

function money(v: number): string {
  if (!v) return "$0";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
}

export default function DiscoverPage() {
  const router = useRouter();

  const [risk, setRisk] = useState<RiskTier>("balanced");
  const [theme, setTheme] = useState("");
  const [size, setSize] = useState(5);
  const [bandIdx, setBandIdx] = useState(0);

  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drag state for the swipe. `dragX` drives the live transform; the ref tracks
  // the gesture start without re-rendering on every pointer move; `dragging`
  // drives the transition (a ref can't be read during render).
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<number | null>(null);

  const params = (): DiscoverParams => {
    const b = LIQUIDITY_BANDS[bandIdx];
    return {
      theme,
      risk,
      size,
      ...(bandIdx > 0 ? { minLiquidity: b.min, maxLiquidity: b.max } : {}),
    };
  };

  async function draw() {
    setLoading(true);
    setError(null);
    setDragX(0);
    try {
      const next = await generateCandidate(params());
      if (!next) {
        setError(
          bandIdx > 0
            ? `No coins in the ${LIQUIDITY_BANDS[bandIdx].label} band (${LIQUIDITY_BANDS[bandIdx].hint})${theme.trim() ? ` for "${theme.trim()}"` : ""} at this risk. Widen the liquidity or add a theme.`
            : theme.trim()
              ? `Nothing liquid enough matched "${theme.trim()}" at this risk. Try another theme or loosen the risk.`
              : "Couldn't reach the token index — check your connection and try again.",
        );
        setCandidate(null);
        return;
      }
      setCandidate(next);
    } finally {
      setLoading(false);
    }
  }

  function accept() {
    if (!candidate) return;
    try {
      sessionStorage.setItem("tote:discover", JSON.stringify(candidate));
    } catch {
      /* private mode etc. — the create page just won't pre-fill */
    }
    router.push("/baskets/new?from=discover");
  }

  function reject() {
    void draw();
  }

  function shuffleWeights() {
    if (candidate) setCandidate(reweight(candidate, risk));
  }

  // --- drag handlers ------------------------------------------------------
  function onPointerDown(e: React.PointerEvent) {
    if (!candidate || loading) return;
    dragStart.current = e.clientX;
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (dragStart.current === null) return;
    setDragX(e.clientX - dragStart.current);
  }
  function onPointerUp() {
    if (dragStart.current === null) return;
    const dx = dragX;
    dragStart.current = null;
    setDragging(false);
    if (dx > SWIPE_THRESHOLD) accept();
    else if (dx < -SWIPE_THRESHOLD) reject();
    else setDragX(0);
  }

  const swiping = dragging;
  const yes = dragX > 40;
  const no = dragX < -40;

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Discover a basket</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Set a risk level and (optionally) a theme, and we&apos;ll propose a basket from live
          Solana token data. Swipe right to take it into the launch flow, left for another.
        </p>
      </div>

      <Card className="space-y-4">
        <Field label="Risk">
          <div className="flex flex-wrap gap-2">
            {RISKS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRisk(r)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  risk === r
                    ? "border-accent bg-accent/10 font-medium text-foreground"
                    : "border-border text-muted hover:text-foreground"
                }`}
              >
                {RISK_LABEL[r]}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Theme" hint="Optional — a sector or vibe. Leave blank for top tokens.">
          <TextInput
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            maxLength={24}
            placeholder="AI, dogs, DeFi…"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {THEME_CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setTheme((t) => (t.toLowerCase() === c.toLowerCase() ? "" : c))}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  theme.toLowerCase() === c.toLowerCase()
                    ? "border-accent bg-accent/10 text-foreground"
                    : "border-border text-muted hover:text-foreground"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </Field>

        <Field label={`Size — ${size} tokens`}>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: MAX_ASSETS - MIN_ASSETS + 1 }, (_, i) => MIN_ASSETS + i).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setSize(n)}
                className={`h-9 w-9 rounded-lg border text-sm transition-colors ${
                  size === n
                    ? "border-accent bg-accent/10 font-medium text-foreground"
                    : "border-border text-muted hover:text-foreground"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label={`Liquidity — ${LIQUIDITY_BANDS[bandIdx].label} (${LIQUIDITY_BANDS[bandIdx].hint})`}
          hint="Keeps every pick in one size tier, so a basket won't mix giants with micro-caps."
        >
          <input
            type="range"
            min={0}
            max={LIQUIDITY_BANDS.length - 1}
            step={1}
            value={bandIdx}
            onChange={(e) => setBandIdx(Number(e.target.value))}
            className="w-full accent-[var(--accent)]"
            aria-label="Liquidity band"
          />
          <div className="mt-1 flex justify-between text-[10px] text-muted">
            {LIQUIDITY_BANDS.map((b, i) => (
              <span key={b.label} className={i === bandIdx ? "font-medium text-foreground" : ""}>
                {b.label}
              </span>
            ))}
          </div>
        </Field>

        <Button type="button" onClick={() => void draw()} disabled={loading}>
          {loading ? "Generating…" : candidate ? "Start over" : "Generate a basket"}
        </Button>
      </Card>

      {error && <Banner kind="error">{error}</Banner>}

      {candidate && (
        <div className="space-y-4">
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{
              transform: `translateX(${dragX}px) rotate(${dragX * 0.03}deg)`,
              transition: swiping ? "none" : "transform 0.2s ease",
              touchAction: "pan-y",
            }}
            className="relative cursor-grab touch-none select-none active:cursor-grabbing"
          >
            {/* swipe hints */}
            <div
              className={`pointer-events-none absolute left-4 top-4 z-10 rounded-md border-2 border-green-500 px-2 py-0.5 text-sm font-bold text-green-500 transition-opacity ${yes ? "opacity-100" : "opacity-0"}`}
            >
              TAKE IT
            </div>
            <div
              className={`pointer-events-none absolute right-4 top-4 z-10 rounded-md border-2 border-red-500 px-2 py-0.5 text-sm font-bold text-red-500 transition-opacity ${no ? "opacity-100" : "opacity-0"}`}
            >
              NEXT
            </div>

            <Card className="space-y-4">
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{candidate.name}</h2>
                  <p className="text-xs text-muted">${candidate.symbol}</p>
                </div>
                <Pill tone={risk === "degen" ? "warn" : "accent"}>{RISK_LABEL[risk]}</Pill>
              </div>

              <ul className="space-y-2">
                {candidate.tokens.map((t, i) => (
                  <li key={t.mint} className="flex items-center gap-3">
                    {t.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element -- arbitrary remote token icons
                      <img src={t.icon} alt="" className="h-7 w-7 shrink-0 rounded-full" />
                    ) : (
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs">
                        {t.symbol.slice(0, 2).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="font-medium">{t.symbol}</span>
                        {t.verified && <span className="text-xs text-accent">✓</span>}
                      </div>
                      <div className="truncate text-xs text-muted">
                        {money(t.liquidityUsd ?? 0)} liquidity
                      </div>
                      {/* Reward/tax info lives on the source — link out rather than
                          scrape it. stopPropagation so a tap doesn't start a swipe. */}
                      <div className="mt-0.5 flex gap-2 text-xs">
                        <a
                          href={`https://pump.fun/coin/${t.mint}`}
                          target="_blank"
                          rel="noreferrer"
                          onPointerDown={(e) => e.stopPropagation()}
                          className="text-accent underline decoration-dotted underline-offset-2"
                        >
                          pump.fun ↗
                        </a>
                        <a
                          href={`https://dexscreener.com/solana/${t.mint}`}
                          target="_blank"
                          rel="noreferrer"
                          onPointerDown={(e) => e.stopPropagation()}
                          className="text-muted underline decoration-dotted underline-offset-2 hover:text-foreground"
                        >
                          chart ↗
                        </a>
                      </div>
                    </div>
                    <div className="w-24 shrink-0">
                      <div className="mb-0.5 text-right text-xs tabular-nums text-muted">
                        {Math.round(candidate.weights[i] * 100)}%
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${candidate.weights[i] * 100}%` }}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted">
                <span>{candidate.tokens.length} tokens</span>
                <span>avg liquidity {money(candidate.stats.avgLiquidityUsd)}</span>
                <span>{candidate.stats.verifiedPct}% verified</span>
              </div>
            </Card>
          </div>

          <div className="flex items-center justify-center gap-3">
            <Button type="button" variant="secondary" onClick={reject} disabled={loading}>
              ✗ Next
            </Button>
            <Button type="button" variant="secondary" onClick={shuffleWeights} disabled={loading}>
              ↻ Reweight
            </Button>
            <Button type="button" onClick={accept} disabled={loading}>
              ✓ Take it
            </Button>
          </div>
          <p className="text-center text-xs text-muted">
            Real mainnet tokens — open pump.fun or the chart to check holder rewards, taxes and
            more. On devnet they&apos;re created as stand-ins in the launch step.
          </p>
        </div>
      )}
    </div>
  );
}
