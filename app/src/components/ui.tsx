"use client";

import Link from "next/link";
import { explorerUrl, shortAddress } from "@/lib/format";

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-surface p-5 ${className}`}>{children}</div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "default" | "accent" | "burn";
}) {
  const valueTone = {
    default: "",
    accent: "text-accent",
    burn: "text-burn",
  }[tone];
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${valueTone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-accent";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`${inputClass} font-mono text-xs ${props.className ?? ""}`}
    />
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  const styles = {
    primary: "bg-accent text-accent-fg hover:brightness-110",
    secondary: "border border-border-strong hover:bg-surface-2",
    danger: "bg-red-600 text-white hover:bg-red-700",
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

/** Button-shaped link, for CTAs that navigate rather than submit. */
export function ButtonLink({
  href,
  variant = "primary",
  children,
  className = "",
}: {
  href: string;
  variant?: "primary" | "secondary";
  children: React.ReactNode;
  className?: string;
}) {
  const styles = {
    primary: "bg-accent text-accent-fg hover:brightness-110",
    secondary: "border border-border-strong hover:bg-surface-2",
  }[variant];
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-all ${styles} ${className}`}
    >
      {children}
    </Link>
  );
}

export function Banner({
  kind,
  children,
}: {
  kind: "error" | "success" | "info" | "warn";
  children: React.ReactNode;
}) {
  const styles = {
    error: "border-red-300 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-200",
    success:
      "border-green-300 bg-green-50 text-green-900 dark:border-green-900/60 dark:bg-green-950/50 dark:text-green-200",
    info: "border-border bg-surface-2 text-foreground",
    warn: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100",
  }[kind];
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm break-words ${styles}`} role="status">
      {children}
    </div>
  );
}

export function AddressLink({ address, chars = 4 }: { address: string; chars?: number }) {
  return (
    <Link
      href={explorerUrl(address)}
      target="_blank"
      rel="noreferrer"
      className="font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid"
      title={address}
    >
      {shortAddress(address, chars)}
    </Link>
  );
}

/** Section wrapper for the landing page's long-form content. */
export function Section({
  title,
  lead,
  children,
  id,
}: {
  title: string;
  lead?: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>
      {lead && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{lead}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

export function Pill({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "accent" | "warn" }) {
  const styles = {
    default: "border-border bg-surface-2 text-muted",
    accent: "border-transparent bg-accent-soft text-accent",
    warn: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${styles}`}>
      {children}
    </span>
  );
}
