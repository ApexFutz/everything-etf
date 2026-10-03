"use client";

import "@/lib/buffer-polyfill";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { useMemo } from "react";
import { DEFAULT_RPC_URL } from "@/lib/etf/constants";

import "@solana/wallet-adapter-react-ui/styles.css";

export function Providers({ children }: { children: React.ReactNode }) {
  // No explicit adapters: Phantom, Solflare, Backpack etc. all register
  // themselves via the Wallet Standard, which wallet-adapter-react picks up
  // automatically.
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={DEFAULT_RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
