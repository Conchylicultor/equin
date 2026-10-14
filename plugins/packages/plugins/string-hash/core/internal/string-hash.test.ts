import { describe, expect, test } from "bun:test";
import { hash53, hash64, hashHex } from "./string-hash";

describe("hash53", () => {
  test("is the classic cyrb53 at seed 0 (pinned values)", () => {
    // Reference values of the canonical cyrb53 (seed 0) — the resource
    // protocol id is built on these, so they must never drift.
    expect(hash53("")).toBe(3338908027751811);
    expect(hash53("a")).toBe(7929297801672961);
    expect(hash53("hello world")).toBe(3259054761512980);
  });

  test("is a safe non-negative integer", () => {
    for (const s of ["", "x", "longer string ✓", '{"id":1}']) {
      const h = hash53(s);
      expect(Number.isSafeInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
    }
  });

  test("the seed selects another family", () => {
    expect(hash53("abc", 1)).not.toBe(hash53("abc"));
    expect(hash53("abc", 1)).toBe(hash53("abc", 1));
  });
});

describe("hashHex", () => {
  test("is 28 hex chars, deterministic, content-sensitive", () => {
    const h = hashHex('{"a":1}');
    expect(h).toMatch(/^[0-9a-f]{28}$/);
    expect(hashHex('{"a":1}')).toBe(h);
    expect(hashHex('{"a":2}')).not.toBe(h);
  });

  test("its first half is hash53 at seed 0", () => {
    expect(hashHex("abc").slice(0, 14)).toBe(
      hash53("abc").toString(16).padStart(14, "0"),
    );
  });
});

describe("hash64", () => {
  test("is an unsigned 64-bit bigint, deterministic, content-sensitive", () => {
    const h = hash64('{"id":"A","v":1}');
    expect(typeof h).toBe("bigint");
    expect(h >= 0n && h < 1n << 64n).toBe(true);
    expect(hash64('{"id":"A","v":1}')).toBe(h);
    expect(hash64('{"id":"A","v":2}')).not.toBe(h);
  });

  test("its low 53 bits agree with hash53", () => {
    const s = "agreement";
    expect(Number(hash64(s) & ((1n << 53n) - 1n))).toBe(hash53(s));
  });
});
