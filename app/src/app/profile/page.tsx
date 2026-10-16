"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Banner, Button, Card, Field, TextInput } from "@/components/ui";
import { Creator } from "@/components/Creator";
import { fetchProfile, setProfileTx } from "@/lib/etf/client";
import { MAX_PROFILE_NAME_LEN } from "@/lib/etf/constants";
import { identityFor } from "@/lib/etf/identity";
import { useSendTx } from "@/hooks/useSendTx";
import { explorerTxUrl } from "@/lib/format";

export default function ProfilePage() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { send, pending, error, setError } = useSendTx();

  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    try {
      const p = await fetchProfile(connection, publicKey);
      setSaved(p?.name ?? null);
      setDraft(p?.name ?? "");
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    // Fetch-on-mount; refresh() is reused after a save, matching the pattern
    // on the basket detail page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  // Byte length, because that is what the program checks — a 32-character
  // name of multi-byte glyphs would be rejected on chain while a character
  // count here said it was fine.
  const bytes = new TextEncoder().encode(draft.trim()).length;
  const tooLong = bytes > MAX_PROFILE_NAME_LEN;
  const unchanged = draft.trim() === (saved ?? "");
  const canSave = Boolean(publicKey) && draft.trim().length > 0 && !tooLong && !unchanged;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) return setError("connect a wallet first");
    setSignature(null);
    const sig = await send(setProfileTx({ owner: publicKey, name: draft.trim() }));
    if (sig) {
      setSignature(sig);
      await refresh();
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Your name</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          What people see beside the baskets you launch. Stored on chain at an address derived from
          your wallet, so everyone sees the same thing — not just you, and not just in this browser.
        </p>
      </div>

      {!publicKey ? (
        <Card>
          <p className="text-sm text-muted">Connect a wallet to set a name.</p>
        </Card>
      ) : (
        <>
          <Card className="space-y-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted">Preview</div>
              <div className="mt-2">
                <Creator address={publicKey} size="md" chosenName={draft.trim() || saved} />
              </div>
            </div>

            <form onSubmit={onSubmit} className="space-y-3">
              <Field
                label="Display name"
                hint={`${bytes}/${MAX_PROFILE_NAME_LEN} bytes`}
              >
                <TextInput
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={identityFor(publicKey).name}
                  disabled={loading}
                />
              </Field>

              {tooLong && (
                <Banner kind="warn">
                  That is {bytes} bytes — the limit is {MAX_PROFILE_NAME_LEN}. Emoji and accented
                  characters take more than one byte each.
                </Banner>
              )}

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={!canSave || pending}>
                  {pending ? "Saving…" : saved ? "Update name" : "Set name"}
                </Button>
                {saved && unchanged && !pending && (
                  <span className="text-xs text-muted">Saved.</span>
                )}
              </div>
            </form>
          </Card>

          {error && <Banner kind="error">{error}</Banner>}
          {signature && (
            <Banner kind="success">
              Name updated.{" "}
              <a className="underline" href={explorerTxUrl(signature)} target="_blank" rel="noreferrer">
                View transaction
              </a>
            </Banner>
          )}

          <Card className="space-y-2 text-sm leading-relaxed text-muted">
            <p>
              <strong className="font-medium text-foreground">
                Setting a name costs a transaction.
              </strong>{" "}
              The first one also pays rent for the small account that stores it; changing it later
              is just the network fee.
            </p>
            <p>
              <strong className="font-medium text-foreground">Names are not unique.</strong> Anyone
              can pick any name, including one somebody else is already using, so a name is never
              proof of who someone is — the wallet address is shown alongside it everywhere for
              exactly that reason. Check the address before trusting a basket.
            </p>
            <p>
              Until you set one you get a name derived from your wallet, the same for everyone
              looking at it.{" "}
              <Link href="/baskets" className="text-accent underline decoration-dotted underline-offset-2">
                See the baskets
              </Link>
              .
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
