import Link from "next/link";
import { DEFAULT_RPC_URL, PROGRAM_ID } from "@/lib/etf/constants";
import { explorerUrl, shortAddress } from "@/lib/format";

function clusterLabel(rpcUrl: string): string {
  if (rpcUrl.includes("devnet")) return "devnet";
  if (rpcUrl.includes("testnet")) return "testnet";
  if (rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")) return "localnet";
  return "mainnet-beta";
}

export function Footer() {
  const cluster = clusterLabel(DEFAULT_RPC_URL);
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div>
            Program{" "}
            <Link
              href={explorerUrl(PROGRAM_ID.toBase58())}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline decoration-dotted underline-offset-2"
            >
              {shortAddress(PROGRAM_ID.toBase58(), 6)}
            </Link>{" "}
            on <span className="font-medium">{cluster}</span>
          </div>
          <div>
            Experimental, pre-audit software. Not financial or legal advice. Basket tokens built on
            memecoins can lose most or all of their value.
          </div>
        </div>
        <Link
          href="https://github.com/ApexFutz/everything-etf"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >
          Source on GitHub
        </Link>
      </div>
    </footer>
  );
}
