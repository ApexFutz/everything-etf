/**
 * Readable names for wallets.
 *
 * A basket's author showing as `9YKU…G6cY` is unusable: you can't recognise a
 * creator you liked, can't tell two baskets by the same person apart from two
 * by strangers, and can't say the name out loud.
 *
 * The name is **derived from the public key**, not generated and stored. That
 * sounds like a smaller thing than "generate one on first connect" and is
 * actually a bigger one: it needs no transaction, no database and no first
 * visit, so every wallet already has a name — including the ones that created
 * the baskets already on chain, and including people who have never opened
 * this app. Two different browsers, two different users, and the chain itself
 * all agree, because there is nothing to disagree about.
 *
 * The tradeoff is that it can't be edited. A chosen name has to live
 * somewhere everyone can read, which means either a profile account in the
 * program or a server — a real decision, deferred rather than faked with
 * localStorage, which would show the owner a name nobody else can see.
 *
 * Collisions are possible and harmless: the name is a label shown beside the
 * address, never a substitute for it. 54 × 64 × 10,000 is about 34.5M
 * combinations, so two creators sharing one is rare and the address is right
 * there when it happens.
 */
import { PublicKey } from "@solana/web3.js";

const ADJECTIVES = [
  "amber", "arctic", "bold", "brave", "bright", "calm", "clever", "cobalt",
  "copper", "crimson", "curious", "daring", "deep", "eager", "electric",
  "ember", "fearless", "fleet", "gentle", "gilded", "golden", "hidden",
  "humble", "indigo", "ivory", "jade", "keen", "lucid", "lunar", "mellow",
  "mighty", "nimble", "noble", "obsidian", "patient", "quiet", "rapid",
  "restless", "royal", "ruby", "sapphire", "scarlet", "silent", "silver",
  "solar", "steady", "stellar", "swift", "tidal", "velvet", "vivid", "wander",
  "wild", "zephyr",
];

const NOUNS = [
  "albatross", "anchor", "aurora", "badger", "basilisk", "beacon", "bison",
  "canyon", "cedar", "cobra", "comet", "condor", "coral", "crane", "dolphin",
  "dragon", "eagle", "ember", "falcon", "fennec", "ferret", "finch", "fjord",
  "gazelle", "glacier", "griffin", "harbor", "hawk", "heron", "ibis", "jaguar",
  "kestrel", "lantern", "lemur", "lynx", "magpie", "mammoth", "marlin",
  "meadow", "monsoon", "narwhal", "nebula", "ocelot", "osprey", "otter",
  "panther", "pelican", "phoenix", "quasar", "raven", "reef", "rhino",
  "sable", "salmon", "sparrow", "sphinx", "stallion", "summit", "tempest",
  "tundra", "viper", "walrus", "willow", "wolf",
];

/**
 * FNV-1a over the raw key bytes. Not cryptographic — it only needs to spread
 * similar keys apart, and it has to produce the same answer everywhere, which
 * rules out anything async like SubtleCrypto for a function used during render.
 */
function hash(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface WalletIdentity {
  /** "Swift Falcon 4821" */
  name: string;
  /** "SF" — for an avatar chip. */
  initials: string;
  /** Stable hue, 0–359, for colouring that avatar. */
  hue: number;
}

export function identityFor(key: PublicKey | string): WalletIdentity {
  const pk = typeof key === "string" ? new PublicKey(key) : key;
  const h = hash(pk.toBytes());

  // Three independent slices of the hash, so the parts vary independently.
  const adjective = ADJECTIVES[h % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length];
  const number = h % 10_000;

  const title = (w: string) => w[0].toUpperCase() + w.slice(1);
  return {
    name: `${title(adjective)} ${title(noun)} ${String(number).padStart(4, "0")}`,
    initials: `${adjective[0]}${noun[0]}`.toUpperCase(),
    hue: h % 360,
  };
}
