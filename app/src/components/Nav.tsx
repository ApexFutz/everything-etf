"use client";

import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Baskets" },
  { href: "/baskets/new", label: "Create" },
  { href: "/admin", label: "Admin" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="border-b border-black/10 dark:border-white/10">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-semibold tracking-tight">
            Everything ETF
          </Link>
          <nav className="flex gap-4 text-sm">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={
                  pathname === l.href
                    ? "font-medium text-foreground"
                    : "text-zinc-500 hover:text-foreground dark:text-zinc-400"
                }
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <WalletMultiButton />
      </div>
    </header>
  );
}
