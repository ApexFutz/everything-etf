/**
 * Minimal Borsh-compatible encode/decode helpers, just for the shapes this
 * program's instructions and accounts actually use. No general-purpose Borsh
 * library needed: every field type here is one of u8/u16/u64/bool/Pubkey/
 * String/Vec<Pubkey>/Vec<u64>, encoded exactly as `AnchorSerialize` would.
 */
import { PublicKey } from "@solana/web3.js";

export class Writer {
  private chunks: Buffer[] = [];

  u8(v: number) {
    this.chunks.push(Buffer.from([v & 0xff]));
    return this;
  }

  u16(v: number) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v, 0);
    this.chunks.push(b);
    return this;
  }

  /** `v` as a bigint or number; always written as 8 bytes, little-endian. */
  u64(v: bigint | number) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v), 0);
    this.chunks.push(b);
    return this;
  }

  pubkey(p: PublicKey) {
    this.chunks.push(p.toBuffer());
    return this;
  }

  /** Borsh string: u32 length prefix + UTF-8 bytes. */
  string(s: string) {
    const bytes = Buffer.from(s, "utf-8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    this.chunks.push(len, bytes);
    return this;
  }

  /** Borsh Vec<Pubkey>: u32 length prefix + 32 bytes each. */
  vecPubkey(ps: PublicKey[]) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(ps.length, 0);
    this.chunks.push(len, ...ps.map((p) => p.toBuffer()));
    return this;
  }

  /** Borsh Vec<u64>: u32 length prefix + 8 bytes each, little-endian. */
  vecU64(vs: (bigint | number)[]) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(vs.length, 0);
    this.chunks.push(len);
    for (const v of vs) {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(v), 0);
      this.chunks.push(b);
    }
    return this;
  }

  bytes(b: Buffer | readonly number[]) {
    this.chunks.push(Buffer.from(b));
    return this;
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Sequential reader over raw account data (already past the 8-byte discriminator). */
export class Reader {
  private offset = 0;
  constructor(private data: Buffer) {}

  u8(): number {
    const v = this.data.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    const v = this.data.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  u64(): bigint {
    const v = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    const v = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  pubkey(): PublicKey {
    const v = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }

  vecPubkey(): PublicKey[] {
    const len = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    const out: PublicKey[] = [];
    for (let i = 0; i < len; i++) out.push(this.pubkey());
    return out;
  }
}

/** True if `data`'s leading 8 bytes match `discriminator`. */
export function hasDiscriminator(data: Buffer, discriminator: number[]): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== discriminator[i]) return false;
  return true;
}
