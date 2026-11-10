import { describe, expect, test } from "bun:test";
import {
  CollectBodySchema,
  MAX_COLLECT_BODY_BYTES,
  MAX_ENGAGED_MS,
  stripQuery,
} from "./collect-body";
import { MAX_GAPS, MAX_GAP_OFFSET_MS, appendGap, type Gap } from "./gaps";

describe("stripQuery", () => {
  test("removes query and fragment", () => {
    expect(stripQuery("/a/b?x=1#top")).toBe("/a/b");
    expect(stripQuery("/a#x?y")).toBe("/a");
    expect(stripQuery("/plain")).toBe("/plain");
  });
});

describe("CollectBodySchema", () => {
  test("a pageview path loses its query string server-side too", () => {
    const body = CollectBodySchema.parse({
      kind: "pageview",
      host: "Equin.dev",
      path: "/harness?token=secret",
    });
    expect(body).toEqual({
      kind: "pageview",
      host: "equin.dev",
      path: "/harness",
    });
  });
  test("event names are lowercase snake", () => {
    const base = { kind: "event", host: "a.example", path: "/" };
    expect(
      CollectBodySchema.safeParse({ ...base, name: "improve_open" }).success,
    ).toBe(true);
    expect(
      CollectBodySchema.safeParse({ ...base, name: "Improve-Open" }).success,
    ).toBe(false);
  });
  test("at most ten props", () => {
    const props = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(
      CollectBodySchema.safeParse({
        kind: "event",
        host: "a.example",
        path: "/",
        name: "x",
        props,
      }).success,
    ).toBe(false);
  });
  test("unknown fields are refused", () => {
    expect(
      CollectBodySchema.safeParse({
        kind: "pageview",
        host: "a.example",
        path: "/",
        ip: "1.2.3.4",
      }).success,
    ).toBe(false);
  });
});

describe("engagement gaps", () => {
  const base = {
    kind: "engagement",
    pageviewId: "00000000-0000-4000-8000-00000000000a",
    engagedMs: 1000,
  };
  const ok = (gaps: unknown) =>
    CollectBodySchema.safeParse({ ...base, gaps }).success;

  test("optional: an older tracker's body still parses", () => {
    expect(CollectBodySchema.safeParse(base).success).toBe(true);
    expect(ok([])).toBe(true);
    expect(ok([{ kind: "idle", startMs: 0, endMs: 30_000 }])).toBe(true);
  });
  test("strict, ordered, non-overlapping, known kinds, bounded", () => {
    expect(ok([{ kind: "idle", startMs: 0, endMs: 1, extra: 1 }])).toBe(false);
    expect(ok([{ kind: "away", startMs: 0, endMs: 1 }])).toBe(false);
    expect(ok([{ kind: "idle", startMs: 5, endMs: 1 }])).toBe(false);
    expect(
      ok([
        { kind: "idle", startMs: 0, endMs: 10 },
        { kind: "hidden", startMs: 5, endMs: 20 },
      ]),
    ).toBe(false);
    expect(
      ok([{ kind: "hidden", startMs: 0, endMs: MAX_GAP_OFFSET_MS + 1 }]),
    ).toBe(false);
    const many = Array.from({ length: MAX_GAPS + 1 }, (_, i) => ({
      kind: "hidden",
      startMs: i * 10,
      endMs: i * 10 + 5,
    }));
    expect(ok(many)).toBe(false);
    expect(ok(many.slice(0, MAX_GAPS))).toBe(true);
  });
  test("a body at the cap, with the widest numbers, stays under the size limit", () => {
    const gaps = Array.from({ length: MAX_GAPS }, (_, i) => ({
      kind: "hidden",
      startMs: MAX_GAP_OFFSET_MS - 100 + i * 2,
      endMs: MAX_GAP_OFFSET_MS - 100 + i * 2 + 1,
    }));
    const body = { ...base, engagedMs: MAX_ENGAGED_MS, gaps };
    expect(CollectBodySchema.safeParse(body).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(
      MAX_COLLECT_BODY_BYTES,
    );
  });
});

describe("appendGap", () => {
  const g = (startMs: number, endMs: number, kind: Gap["kind"] = "hidden") => ({
    kind,
    startMs,
    endMs,
  });
  test("drops a stretch under 5 s and clamps offsets", () => {
    expect(appendGap([], g(0, 4_999))).toEqual([]);
    expect(appendGap([], g(-3, 10_000.4))).toEqual([g(0, 10_000)]);
    expect(appendGap([], g(0, MAX_GAP_OFFSET_MS + 9))).toEqual([
      g(0, MAX_GAP_OFFSET_MS),
    ]);
  });
  test("past the cap, merges the neighbours with the least time between them, keeping the longer's kind", () => {
    const gaps = Array.from({ length: MAX_GAPS }, (_, i) =>
      g(i * 100_000, i * 100_000 + 10_000),
    );
    // Only 1 s after the last one: that pair merges.
    const next = appendGap(
      gaps,
      g(MAX_GAPS * 100_000 - 89_000, MAX_GAPS * 100_000, "idle"),
    );
    expect(next).toHaveLength(MAX_GAPS);
    expect(next.slice(0, -1)).toEqual(gaps.slice(0, -1));
    expect(next.at(-1)).toEqual(
      g((MAX_GAPS - 1) * 100_000, MAX_GAPS * 100_000, "idle"),
    );
    expect(gaps).toHaveLength(MAX_GAPS); // not mutated
  });
});
