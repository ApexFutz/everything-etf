/**
 * Just enough Metaplex Token Metadata to read a mint's name/symbol and to
 * attach metadata to the throwaway mints the dev helper creates. We don't pull
 * in the Metaplex JS SDK for this — two operations don't justify the
 * dependency, and the encodings below are pinned by the program's own
 * `create_metadata_accounts_v3` CPI (anchor-spl), which these mirror.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { METADATA_PROGRAM_ID } from "./constants";
import { Writer } from "./codec";

export function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  )[0];
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  uri: string;
}

/**
 * Metadata account layout: key(1) + update_authority(32) + mint(32), then
 * three Borsh strings. Metaplex pads those to fixed maximums with NULs, so the
 * length prefix is the padded length and the trailing NULs have to be trimmed.
 */
export function decodeMetadata(data: Buffer): TokenMetadata | null {
  try {
    let offset = 1 + 32 + 32;
    const readString = (): string => {
      const len = data.readUInt32LE(offset);
      offset += 4;
      const raw = data.subarray(offset, offset + len).toString("utf-8");
      offset += len;
      return raw.replace(/\0+$/, "").trim();
    };
    const name = readString();
    const symbol = readString();
    const uri = readString();
    return { name, symbol, uri };
  } catch {
    return null;
  }
}

/** Reads metadata for many mints at once; entries are null where there is none. */
export async function fetchMetadataFor(
  connection: Connection,
  mints: PublicKey[],
): Promise<(TokenMetadata | null)[]> {
  if (mints.length === 0) return [];
  const pdas = mints.map(metadataPda);
  // getMultipleAccountsInfo caps at 100 per call.
  const out: (TokenMetadata | null)[] = [];
  for (let i = 0; i < pdas.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(pdas.slice(i, i + 100));
    out.push(...infos.map((info) => (info ? decodeMetadata(info.data) : null)));
  }
  return out;
}

/**
 * `CreateMetadataAccountV3` (instruction 33). Encoding mirrors what the
 * program's own CPI emits: DataV2 {name, symbol, uri, seller_fee_basis_points,
 * creators?, collection?, uses?} then is_mutable, then collection_details?.
 */
export function createMetadataV3Instruction(args: {
  mint: PublicKey;
  mintAuthority: PublicKey;
  payer: PublicKey;
  updateAuthority: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}): TransactionInstruction {
  const data = new Writer()
    .u8(33)
    .string(args.name)
    .string(args.symbol)
    .string(args.uri)
    .u16(0) // seller_fee_basis_points
    .u8(0) // creators: None
    .u8(0) // collection: None
    .u8(0) // uses: None
    .u8(1) // is_mutable: true
    .u8(0) // collection_details: None
    .finish();

  return new TransactionInstruction({
    programId: METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadataPda(args.mint), isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.mintAuthority, isSigner: true, isWritable: false },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.updateAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}
