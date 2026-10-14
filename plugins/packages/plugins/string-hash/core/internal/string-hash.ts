// Portable string hashes: plain JS over `Math.imul`, no `node:crypto` and no
// `Bun.hash`, so the Bun server, central and a browser page all compute the
// same value for the same string. None is cryptographic — they tell contents
// apart, they do not defend against a forged collision.

/**
 * The cyrb53 mixing core: both 32-bit lanes after the final avalanche. `hash53`
 * keeps 53 bits of them (a safe JS integer); `hash64` keeps all 64.
 */
function cyrb53Lanes(str: string, seed: number): [number, number] {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1, h2];
}

/**
 * cyrb53: a 53-bit hash of `str` as a non-negative safe integer. `seed`
 * (default 0) selects an independent hash family; seed 0 is the classic cyrb53.
 */
export function hash53(str: string, seed = 0): number {
  const [h1, h2] = cyrb53Lanes(str, seed);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A ~106-bit hash of `str` as 28 lowercase hex chars: two independently seeded
 * `hash53`s, each zero-padded to 14 chars. For identities a 53-bit space is too
 * small for (ETags over many bodies).
 */
export function hashHex(str: string): string {
  const a = hash53(str, 0).toString(16).padStart(14, "0");
  const b = hash53(str, 0x9e3779b9).toString(16).padStart(14, "0");
  return a + b;
}

/** A 64-bit hash of `str` as an unsigned `bigint` (both cyrb53 lanes, whole). */
export function hash64(str: string): bigint {
  const [h1, h2] = cyrb53Lanes(str, 0);
  return (BigInt(h2 >>> 0) << 32n) | BigInt(h1 >>> 0);
}
