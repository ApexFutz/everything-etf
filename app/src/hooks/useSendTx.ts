"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Signer, Transaction, TransactionInstruction } from "@solana/web3.js";
import { useCallback, useState } from "react";
import { describeError } from "@/lib/etf/errors";

export function useSendTx() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  const send = useCallback(
    async (instructions: TransactionInstruction[], extraSigners?: Signer[]) => {
      if (!publicKey) {
        setError("connect a wallet first");
        return null;
      }
      setPending(true);
      setError(null);
      setSignature(null);
      try {
        const tx = new Transaction().add(...instructions);
        const sig = await sendTransaction(tx, connection, { signers: extraSigners });
        await connection.confirmTransaction(sig, "confirmed");
        setSignature(sig);
        return sig;
      } catch (e) {
        setError(describeError(e));
        return null;
      } finally {
        setPending(false);
      }
    },
    [publicKey, sendTransaction, connection],
  );

  return { send, pending, error, signature, setError };
}
