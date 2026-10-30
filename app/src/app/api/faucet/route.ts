/**
 * Devnet self-serve faucet: tops a tester's wallet up to a target of test SOL
 * and $TOTE so they can create a basket front-to-back without the admin being
 * online. Devnet only — $TOTE is a valueless test token there.
 *
 * Balance-gated rather than time-gated (the chosen cap): it only sends the
 * shortfall up to a fixed target, so repeated clicks can't stack past it and no
 * database is needed. The cap resets naturally as a tester spends.
 *
 * Signs with a dedicated faucet wallet (FAUCET_SECRET) that holds nothing but a
 * pile of devnet $TOTE and some SOL — never the admin/upgrade-authority key, so
 * a leak only risks the faucet's own balance.
 */
import { NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import { fetchCoinConfig } from "@/lib/etf/client";

// web3.js needs Node crypto, and the key must never be bundled to the client.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How much a wallet is topped up *to* — not per request, but a ceiling. */
const SOL_TARGET = 0.5;
/** $TOTE target, as a multiple of one launch fee (≈ five launches). */
const TOTE_TARGET_LAUNCHES = 5n;
/** Rent for an associated token account, roughly, as a SOL-capacity guard. */
const ATA_RENT_LAMPORTS = 2_100_000n;

function loadFaucet(): Keypair | null {
  const secret = process.env.FAUCET_SECRET;
  if (!secret) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const faucet = loadFaucet();
  if (!faucet) {
    return NextResponse.json(
      { ok: false, error: "Faucet isn't configured — set FAUCET_SECRET." },
      { status: 503 },
    );
  }

  let recipient: PublicKey;
  try {
    const body = (await req.json()) as { recipient?: string };
    recipient = new PublicKey(body.recipient ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid recipient address." }, { status: 400 });
  }

  const url =
    process.env.FAUCET_RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
  // Devnet only: $TOTE has real value on mainnet, so never hand it out there.
  if (!/devnet|localhost|127\.0\.0\.1/.test(url)) {
    return NextResponse.json({ ok: false, error: "Faucet is devnet-only." }, { status: 403 });
  }
  const connection = new Connection(url, "confirmed");

  try {
    const coinConfig = await fetchCoinConfig(connection);
    if (!coinConfig) {
      return NextResponse.json({ ok: false, error: "Coin not initialized here." }, { status: 500 });
    }
    const mint = coinConfig.mint;
    const { decimals } = await getMint(connection, mint);

    const solTarget = BigInt(Math.round(SOL_TARGET * LAMPORTS_PER_SOL));
    const toteTarget = coinConfig.creationFeeCoin * TOTE_TARGET_LAUNCHES;

    // What the recipient already has — the balance gate.
    const haveSol = BigInt(await connection.getBalance(recipient));
    const recipientAta = getAssociatedTokenAddressSync(mint, recipient);
    let haveTote = 0n;
    let recipientAtaExists = true;
    try {
      haveTote = (await getAccount(connection, recipientAta)).amount;
    } catch (e) {
      if (e instanceof TokenAccountNotFoundError) {
        recipientAtaExists = false;
      } else {
        throw e;
      }
    }

    const solTopUp = solTarget > haveSol ? solTarget - haveSol : 0n;
    const toteTopUp = toteTarget > haveTote ? toteTarget - haveTote : 0n;
    if (solTopUp === 0n && toteTopUp === 0n) {
      return NextResponse.json({
        ok: true,
        funded: { sol: false, tote: false },
        message: "You already have enough test SOL and $TOTE.",
        sol: haveSol.toString(),
        tote: haveTote.toString(),
      });
    }

    // Make sure the faucet can actually cover it before building the transaction.
    const faucetSol = BigInt(await connection.getBalance(faucet.publicKey));
    const faucetAta = getAssociatedTokenAddressSync(mint, faucet.publicKey);
    let faucetTote = 0n;
    try {
      faucetTote = (await getAccount(connection, faucetAta)).amount;
    } catch {
      faucetTote = 0n;
    }
    const solNeededFromFaucet = solTopUp + (recipientAtaExists ? 0n : ATA_RENT_LAMPORTS) + 10_000n;
    if (faucetSol < solNeededFromFaucet) {
      return NextResponse.json(
        { ok: false, error: "Faucet is low on SOL — ping the admin to refill." },
        { status: 503 },
      );
    }
    if (toteTopUp > 0n && faucetTote < toteTopUp) {
      return NextResponse.json(
        { ok: false, error: "Faucet is out of $TOTE — ping the admin to refill." },
        { status: 503 },
      );
    }

    const ixs: TransactionInstruction[] = [];
    if (!recipientAtaExists) {
      ixs.push(createAssociatedTokenAccountInstruction(faucet.publicKey, recipientAta, recipient, mint));
    }
    if (toteTopUp > 0n) {
      ixs.push(
        createTransferCheckedInstruction(
          faucetAta,
          mint,
          recipientAta,
          faucet.publicKey,
          toteTopUp,
          decimals,
        ),
      );
    }
    if (solTopUp > 0n) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: faucet.publicKey,
          toPubkey: recipient,
          lamports: Number(solTopUp),
        }),
      );
    }

    const signature = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(...ixs),
      [faucet],
    );

    return NextResponse.json({
      ok: true,
      signature,
      funded: { sol: solTopUp > 0n, tote: toteTopUp > 0n },
      sol: (haveSol + solTopUp).toString(),
      tote: (haveTote + toteTopUp).toString(),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Faucet request failed." },
      { status: 500 },
    );
  }
}
