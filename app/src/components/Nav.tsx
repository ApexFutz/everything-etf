"use client";

import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const LINKS = [
  { href: "/baskets", label: "Baskets" },
  { href: "/eetf", label: "$EETF" },
  { href: "/baskets/new", label: "Create" },
  { href: "/terms", label: "Fees & terms" },
  { href: "/admin", label: "Admin" },
];

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  function isActive(href: string) {
    return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
  }

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-7">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <BasketMark />
            Everything ETF
          </Link>
          <nav className="hidden gap-5 text-sm sm:flex">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={
                  isActive(l.href)
                    ? "font-medium text-foreground"
                    : "text-muted transition-colors hover:text-foreground"
                }
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <WalletMultiButton />
          <button
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg border border-border px-2.5 py-2 text-sm sm:hidden"
          >
            ☰
          </button>
        </div>
      </div>
      {open && (
        <nav className="flex flex-col gap-1 border-t border-border px-6 py-3 text-sm sm:hidden">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className={`rounded-md px-2 py-1.5 ${
                isActive(l.href) ? "bg-surface-2 font-medium" : "text-muted"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

function BasketMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="text-accent">
      <circle cx="9" cy="9" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 1v16M1 9h16" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
    </svg>
  );
}
