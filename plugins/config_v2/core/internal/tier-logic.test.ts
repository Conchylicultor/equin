import { describe, expect, test } from "bun:test";
import { propagate, threeWayMerge } from "./tier-logic";
import { computeHash, readonlyProxy } from "./config-proxy";
import type { ConfigFileContent, ConfigProxy } from "./config-proxy";
import type { JsonValue } from "./types";

// In-memory ConfigProxy for exercising propagate's ancestor capture without
// touching disk. `null` content = file absent.
function memProxy(initial?: ConfigFileContent): ConfigProxy & {
  snapshot: () => ConfigFileContent | null;
} {
  let state: ConfigFileContent | null = initial ?? null;
  return {
    read: () => (state ? { ...state } : null),
    write: (content, hash) => {
      state = { content, hash };
    },
    exists: () => state !== null,
    snapshot: () => (state ? { ...state } : null),
  };
}

// An override proxy written against the given origin content (records its hash).
function overrideFor(content: JsonValue, originContent: JsonValue): ConfigProxy {
  return memProxy({ content, hash: computeHash(originContent) });
}

describe("threeWayMerge", () => {
  test("auto-resolves single-sided changes, flags divergent fields", () => {
    const base = { a: 1, b: 1, c: 1 };
    const ours = { a: 2, b: 1, c: 2 }; // user changed a and c
    const theirs = { a: 1, b: 9, c: 9 }; // origin changed b and c
    const { merged, conflicts } = threeWayMerge(base, ours, theirs);
    expect(merged).toEqual({ a: 2, b: 9, c: 2 });
    expect(conflicts).toEqual(["c"]);
  });

  test("both sides made the same change → no conflict", () => {
    const { merged, conflicts } = threeWayMerge({ a: 1 }, { a: 5 }, { a: 5 });
    expect(merged).toEqual({ a: 5 });
    expect(conflicts).toEqual([]);
  });

  test("key only in theirs (new upstream field) is added", () => {
    const { merged, conflicts } = threeWayMerge({ a: 1 }, { a: 1 }, { a: 1, b: 2 });
    expect(merged).toEqual({ a: 1, b: 2 });
    expect(conflicts).toEqual([]);
  });

  test("key only in ours (user-added field) is kept", () => {
    const { merged, conflicts } = threeWayMerge({ a: 1 }, { a: 1, z: 9 }, { a: 1 });
    expect(merged).toEqual({ a: 1, z: 9 });
    expect(conflicts).toEqual([]);
  });

  test("clean (no changes either side) is a no-op", () => {
    const doc = { a: 1, b: 2 };
    const { merged, conflicts } = threeWayMerge(doc, doc, doc);
    expect(merged).toEqual(doc);
    expect(conflicts).toEqual([]);
  });

  test("idempotent: re-merging the merged result yields the same conflicts", () => {
    const base = { a: 1, b: 1, c: 1 };
    const ours = { a: 2, b: 1, c: 2 };
    const theirs = { a: 1, b: 9, c: 9 };
    const first = threeWayMerge(base, ours, theirs);
    const second = threeWayMerge(base, first.merged, theirs);
    expect(second.conflicts).toEqual(first.conflicts);
    expect(second.merged).toEqual(first.merged);
  });
});

describe("propagate ancestor capture", () => {
  const v1: JsonValue = { x: 1 };
  const v2: JsonValue = { x: 2 };
  const v3: JsonValue = { x: 3 };

  test("first conflict: captures the base the override was written against", () => {
    const origin = memProxy({ content: v1, hash: computeHash(v1) });
    const overwrites = overrideFor({ x: 99 }, v1); // in sync with origin v1
    const ancestor = memProxy();

    const { conflict } = propagate(readonlyProxy(v2), origin, overwrites, ancestor);
    expect(conflict).toBe(true);
    expect(ancestor.snapshot()?.content).toEqual(v1);
    expect(origin.snapshot()?.content).toEqual(v2); // origin advanced
  });

  test("repeated build before reconcile does NOT clobber the captured base", () => {
    const origin = memProxy({ content: v1, hash: computeHash(v1) });
    const overwrites = overrideFor({ x: 99 }, v1);
    const ancestor = memProxy();

    propagate(readonlyProxy(v2), origin, overwrites, ancestor); // captures v1, origin→v2
    propagate(readonlyProxy(v3), origin, overwrites, ancestor); // origin v2 ≠ ow.hash → no capture

    expect(ancestor.snapshot()?.content).toEqual(v1); // still the true base
    expect(origin.snapshot()?.content).toEqual(v3);
  });

  test("no override → no capture", () => {
    const origin = memProxy({ content: v1, hash: computeHash(v1) });
    const ancestor = memProxy();
    const { conflict } = propagate(readonlyProxy(v2), origin, memProxy(), ancestor);
    expect(conflict).toBe(false);
    expect(ancestor.exists()).toBe(false);
  });

  test("override already in sync with new upstream → no conflict, no capture", () => {
    const origin = memProxy({ content: v1, hash: computeHash(v1) });
    // override written against v2, and the incoming upstream is also v2
    const overwrites = overrideFor({ x: 99 }, v2);
    const ancestor = memProxy();
    const { conflict } = propagate(readonlyProxy(v2), origin, overwrites, ancestor);
    expect(conflict).toBe(false);
    expect(ancestor.exists()).toBe(false);
  });

  test("reconcile (override re-synced to current origin) then new upstream captures fresh base", () => {
    const origin = memProxy({ content: v1, hash: computeHash(v1) });
    const overwrites = overrideFor({ x: 99 }, v1);
    const ancestor = memProxy();

    propagate(readonlyProxy(v2), origin, overwrites, ancestor); // capture v1, origin→v2
    // user "Keep my values" re-stamps the override hash to the current origin (v2)
    overwrites.write({ x: 99 }, computeHash(v2));

    propagate(readonlyProxy(v3), origin, overwrites, ancestor); // now in sync with v2 → capture v2
    expect(ancestor.snapshot()?.content).toEqual(v2);
  });

  test("an unstamped (hand-written) override is stamped with the origin it replaces", () => {
    const origin = memProxy({ content: v1, hash: computeHash(v1) });
    const overwrites = memProxy({ content: { x: 99 }, hash: null });
    const ancestor = memProxy();

    const { conflict } = propagate(
      readonlyProxy(v2),
      origin,
      overwrites,
      ancestor,
    );
    // Written against v1, so v2 makes it a conflict — with v1 kept as the base.
    expect(conflict).toBe(true);
    expect(overwrites.read()).toEqual({
      content: { x: 99 },
      hash: computeHash(v1),
    });
    expect(ancestor.snapshot()?.content).toEqual(v1);
  });

  test("an override that does not parse is never stamped (that would rewrite its text)", () => {
    const origin = memProxy({ content: v1, hash: computeHash(v1) });
    const broken = { content: { x: 99 }, hash: null, syntaxErrors: ["bad"] };
    const overwrites = memProxy(broken);
    propagate(readonlyProxy(v2), origin, overwrites);
    expect(overwrites.snapshot()).toEqual(broken);
  });

  test("backward compatible: omitting the ancestor proxy still reports conflict", () => {
    const origin = memProxy({ content: v1, hash: computeHash(v1) });
    const overwrites = overrideFor({ x: 99 }, v1);
    const { conflict } = propagate(readonlyProxy(v2), origin, overwrites);
    expect(conflict).toBe(true);
  });
});

describe("propagate writes only what moved", () => {
  function counting(initial?: { content: JsonValue; hash: string | null }) {
    const inner = memProxy(initial);
    let writes = 0;
    return {
      ...inner,
      write: (content: JsonValue, hash: string | null) => {
        writes++;
        inner.write(content, hash);
      },
      writes: () => writes,
    };
  }

  test("an origin already holding the upstream document is not rewritten", () => {
    const v1 = { x: 1 };
    const origin = counting({ content: v1, hash: computeHash(v1) });
    propagate(readonlyProxy(v1), origin, memProxy());
    expect(origin.writes()).toBe(0);
  });

  test("a moved upstream, a missing origin, or a body edited under its header is written", () => {
    const v1 = { x: 1 };
    const v2 = { x: 2 };
    const moved = counting({ content: v1, hash: computeHash(v1) });
    propagate(readonlyProxy(v2), moved, memProxy());
    expect(moved.snapshot()).toEqual({ content: v2, hash: computeHash(v2) });

    const missing = counting();
    propagate(readonlyProxy(v1), missing, memProxy());
    expect(missing.writes()).toBe(1);

    const edited = counting({ content: { x: 7 }, hash: computeHash(v1) });
    propagate(readonlyProxy(v1), edited, memProxy());
    expect(edited.snapshot()).toEqual({ content: v1, hash: computeHash(v1) });
  });
});
