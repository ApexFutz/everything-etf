/**
 * `Buffer` is a Node global. @solana/web3.js, @solana/spl-token, and our own
 * etf/* modules all use it unqualified, assuming it exists globally the way
 * it does in Node — true for this app's server-rendered HTML, but NOT for
 * the client-side bundle, since Next's Turbopack (unlike older webpack
 * configs) doesn't auto-polyfill Node builtins for the browser. Import this
 * once, as early as possible on the client (providers.tsx does), before any
 * Solana code runs there.
 */
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}
