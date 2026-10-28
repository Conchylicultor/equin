import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { z } from "zod";

export class Rank {
  private constructor(private readonly _v: string) {}

  static from(value: string): Rank {
    return new Rank(value);
  }

  static compare(a: Rank, b: Rank): -1 | 0 | 1 {
    if (a._v < b._v) return -1;
    if (a._v > b._v) return 1;
    return 0;
  }

  static between(prev: Rank | null, next: Rank | null): Rank {
    return new Rank(generateKeyBetween(prev?._v ?? null, next?._v ?? null));
  }

  /**
   * Generate `n` evenly-spaced ranks strictly between `prev` and `next`, in
   * ascending order. Use this for inserting a contiguous run of items (bulk
   * move, paste, duplicate) — it splits the interval once instead of repeatedly
   * calling `between` and feeding the result back, which grows key length
   * unboundedly. Returns `[]` when `n <= 0`.
   */
  static nBetween(prev: Rank | null, next: Rank | null, n: number): Rank[] {
    if (n <= 0) return [];
    return generateNKeysBetween(prev?._v ?? null, next?._v ?? null, n).map(
      (v) => new Rank(v),
    );
  }

  static equals(a: Rank, b: Rank): boolean {
    return a._v === b._v;
  }

  toJSON(): string {
    return this._v;
  }

  toString(): string {
    return this._v;
  }
}

// Accepts the wire form (a raw string) or an already-wrapped `Rank`, and always
// outputs a `Rank`.
export const RankSchema: z.ZodType<Rank> = z.preprocess(
  (v) => (typeof v === "string" ? Rank.from(v) : v),
  z.custom<Rank>((v) => v instanceof Rank),
);
