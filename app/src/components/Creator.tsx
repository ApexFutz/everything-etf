"use client";

import { PublicKey } from "@solana/web3.js";
import { identityFor } from "@/lib/etf/identity";
import { shortAddress } from "@/lib/format";

/**
 * A wallet, shown as a person.
 *
 * The address is kept alongside the name rather than replaced by it: the name
 * is derived from the key and could in principle collide, so it's a label for
 * recognition, never the identifier. `title` carries the full address for
 * anyone who needs to copy it.
 */
export function Creator({
  address,
  size = "sm",
  showAddress = true,
}: {
  address: PublicKey | string;
  size?: "sm" | "md";
  showAddress?: boolean;
}) {
  const key = typeof address === "string" ? address : address.toBase58();
  const { name, initials, hue } = identityFor(key);
  const dim = size === "md" ? "h-7 w-7 text-[11px]" : "h-5 w-5 text-[9px]";

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={key}>
      <span
        aria-hidden
        className={`${dim} inline-flex shrink-0 items-center justify-center rounded-full font-semibold`}
        // Inline because the hue is per-wallet; Tailwind can't enumerate 360.
        style={{
          backgroundColor: `hsl(${hue} 70% 90%)`,
          color: `hsl(${hue} 70% 28%)`,
        }}
      >
        {initials}
      </span>
      <span className="truncate">
        <span className={size === "md" ? "font-medium" : ""}>{name}</span>
        {showAddress && (
          <span className="ml-1.5 font-mono text-xs text-muted">{shortAddress(key, 4)}</span>
        )}
      </span>
    </span>
  );
}
