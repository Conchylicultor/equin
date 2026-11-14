/**
 * mulberry32: a seeded random stream, `() => number` in [0, 1). The same seed
 * (any number, taken modulo 2^32) always yields the same sequence, on every
 * host — what generated art and generated worlds are built from, so they come
 * out identical every time. Not cryptographic, and not for statistics.
 */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
