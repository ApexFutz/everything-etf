/**
 * Minimal Borsh-compatible encode/decode helpers, just for the shapes this
 * program's instructions and accounts actually use. No general-purpose Borsh
 * library needed: every field type here is one of u8/u16/u64/bool/Pubkey/
 * String/Vec<Pubkey>/Vec<u64>, encoded exactly as `AnchorSerialize` would.
 */
import { PublicKey } from "@solana/web3.js";

/**
 * 64-bit little-endian helpers, done with `DataView` rather than Buffer's
 * `writeBigUInt64LE` / `readBigUInt64LE`.
 *
 * Those methods exist on Node's Buffer but not reliably on the browser
 * polyfill webpack substitutes — the basket list died in a real browser with
 * "idBuf.writeBigUInt64LE is not a function" while every Node test passed,
 * because Node and the browser were running different implementations of the
 * same call. `DataView` is plain ECMAScript and behaves identically in both,
 * so the Node tests now exercise the same code path the browser does.
 */
export function u64ToLeBytes(v: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  new DataView(b.buffer, b.byteOffset, 8).setBigUint64(0, BigInt(v), true);
  return b;
}

export function readU64LE(data: Buffer, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

export function readI64LE(data: Buffer, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(offset, true);
}

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
    this.chunks.push(u64ToLeBytes(v));
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
    for (const v of vs) this.chunks.push(u64ToLeBytes(v));
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
    const v = readU64LE(this.data, this.offset);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    const v = readI64LE(this.data, this.offset);
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
