import { describe, expect, test } from "bun:test";
import {
  CollectBodySchema,
  MAX_COLLECT_BODY_BYTES,
  MAX_ENGAGED_MS,
  stripQuery,
} from "./collect-body";
import { MAX_GAPS, MAX_GAP_OFFSET_MS, appendGap, type Gap } from "./gaps";
import { MAX_LOAD_MS, loadMs } from "./load-timing";
import { MAX_PAGE_SECTIONS, MAX_SECTION_NAME_LENGTH } from "./page-sections";
import { MAX_VIEWPORT_PX } from "./viewport";

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
  test("a pageview's viewport is whole positive pixels, within a screen's bounds", () => {
    const base = { kind: "pageview", host: "a.example", path: "/" };
    const ok = (viewport: unknown) =>
      CollectBodySchema.safeParse({ ...base, viewport }).success;
    expect(ok({ w: 390, h: 844 })).toBe(true);
    expect(ok({ w: 0, h: 844 })).toBe(false);
    expect(ok({ w: 390.5, h: 844 })).toBe(false);
    expect(ok({ w: MAX_VIEWPORT_PX + 1, h: 844 })).toBe(false);
    expect(ok({ w: 390, h: 844, dpr: 3 })).toBe(false);
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
    const load = {
      ttfbMs: MAX_LOAD_MS,
      fcpMs: MAX_LOAD_MS,
      readyMs: MAX_LOAD_MS,
    };
    const sections = Array.from({ length: MAX_PAGE_SECTIONS }, (_, i) =>
      `${i}`.padEnd(MAX_SECTION_NAME_LENGTH, "x"),
    );
    const body = { ...base, engagedMs: MAX_ENGAGED_MS, gaps, load, sections };
    expect(CollectBodySchema.safeParse(body).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(
      MAX_COLLECT_BODY_BYTES,
    );
  });
});

describe("engagement load", () => {
  const base = {
    kind: "engagement",
    pageviewId: "00000000-0000-4000-8000-00000000000a",
    engagedMs: 1000,
  };
  const ok = (load: unknown) =>
    CollectBodySchema.safeParse({ ...base, load }).success;

  test("optional, every phase nullable but present", () => {
    expect(CollectBodySchema.safeParse(base).success).toBe(true);
    expect(ok({ ttfbMs: 100, fcpMs: 900, readyMs: 1200 })).toBe(true);
    expect(ok({ ttfbMs: null, fcpMs: null, readyMs: null })).toBe(true);
    expect(ok({ ttfbMs: 100, fcpMs: null })).toBe(false);
  });
  test("strict, whole positive ms, bounded: never 0", () => {
    expect(ok({ ttfbMs: 1, fcpMs: 1, readyMs: 1, lcpMs: 1 })).toBe(false);
    expect(ok({ ttfbMs: 0, fcpMs: null, readyMs: null })).toBe(false);
    expect(ok({ ttfbMs: 1.5, fcpMs: null, readyMs: null })).toBe(false);
    expect(ok({ ttfbMs: MAX_LOAD_MS + 1, fcpMs: null, readyMs: null })).toBe(
      false,
    );
  });
  test("loadMs: whole ms rounded up, null when unmeasured or implausible", () => {
    expect(loadMs(107.1)).toBe(108);
    expect(loadMs(0.2)).toBe(1);
    expect(loadMs(0)).toBeNull();
    expect(loadMs(-3)).toBeNull();
    expect(loadMs(null)).toBeNull();
    expect(loadMs(Number.NaN)).toBeNull();
    expect(loadMs(MAX_LOAD_MS)).toBe(MAX_LOAD_MS);
    expect(loadMs(MAX_LOAD_MS + 0.5)).toBeNull();
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

describe("engagement sections", () => {
  const base = {
    kind: "engagement",
    pageviewId: "00000000-0000-4000-8000-00000000000a",
    engagedMs: 1000,
  };
  const ok = (sections: unknown) =>
    CollectBodySchema.safeParse({ ...base, sections }).success;

  test("optional: an older tracker's body still parses", () => {
    expect(CollectBodySchema.safeParse(base).success).toBe(true);
    expect(ok(["landing/hero", "landing/layers"])).toBe(true);
  });
  test("distinct, short names, bounded", () => {
    expect(ok(["landing/hero", "landing/hero"])).toBe(false);
    expect(ok([""])).toBe(false);
    expect(ok(["x".repeat(MAX_SECTION_NAME_LENGTH + 1)])).toBe(false);
    const many = Array.from(
      { length: MAX_PAGE_SECTIONS + 1 },
      (_, i) => `s${i}`,
    );
    expect(ok(many)).toBe(false);
    expect(ok(many.slice(0, MAX_PAGE_SECTIONS))).toBe(true);
  });
});
