import { describe, expect, test } from "bun:test";
import { SPAN_KINDS } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  FLIGHT_WINDOW_MS_DEFAULT,
  FLIGHT_WINDOW_MS_MAX,
  FLIGHT_WINDOW_MS_MIN,
  flightWindowQuerySchema,
  flightWindowResponseSchema,
  runtimeProfileSchema,
} from "./endpoints";

// Query params arrive as raw strings (implement() feeds searchParams entries
// straight into safeParse), so every case below parses from a string.
describe("flightWindowQuerySchema", () => {
  test("defaults when windowMs is absent", () => {
    expect(flightWindowQuerySchema.parse({})).toEqual({
      windowMs: FLIGHT_WINDOW_MS_DEFAULT,
    });
  });

  test("coerces a numeric string", () => {
    expect(flightWindowQuerySchema.parse({ windowMs: "30000" })).toEqual({
      windowMs: 30_000,
    });
  });

  test("clamps below the minimum", () => {
    expect(flightWindowQuerySchema.parse({ windowMs: "5" })).toEqual({
      windowMs: FLIGHT_WINDOW_MS_MIN,
    });
  });

  test("clamps above the maximum", () => {
    expect(flightWindowQuerySchema.parse({ windowMs: "999999999" })).toEqual({
      windowMs: FLIGHT_WINDOW_MS_MAX,
    });
  });

  test("keeps in-range bounds untouched", () => {
    expect(
      flightWindowQuerySchema.parse({ windowMs: String(FLIGHT_WINDOW_MS_MIN) })
        .windowMs,
    ).toBe(FLIGHT_WINDOW_MS_MIN);
    expect(
      flightWindowQuerySchema.parse({ windowMs: String(FLIGHT_WINDOW_MS_MAX) })
        .windowMs,
    ).toBe(FLIGHT_WINDOW_MS_MAX);
  });

  test("rejects non-numeric input", () => {
    expect(flightWindowQuerySchema.safeParse({ windowMs: "abc" }).success).toBe(
      false,
    );
    expect(
      flightWindowQuerySchema.safeParse({ windowMs: "Infinity" }).success,
    ).toBe(false);
  });
});

// Every worktree runs its own commit and these replies are read across them
// (the get_runtime_profile tool, sentinel's fleet fan-out): a reply from a
// backend predating a field or span kind must still parse, as recorded-nothing.
describe("an older backend's reply", () => {
  test("runtime profile: missing decomposition fields and span kinds default", () => {
    const parsed = runtimeProfileSchema.parse({
      aggregates: {
        http: [
          {
            label: "GET /x",
            count: 1,
            totalMs: 5,
            maxMs: 5,
            lastMs: 5,
            byParent: [],
          },
        ],
      },
      slowest: {
        http: [
          {
            id: 1,
            parentId: null,
            kind: "http",
            label: "GET /x",
            durationMs: 5,
            atMs: 0,
            parent: null,
          },
        ],
      },
      sinceMs: 0,
      windowMs: 10,
    });
    const agg = parsed.aggregates.http[0]!;
    expect([agg.waitTotalMs, agg.selfTotalMs, agg.recentMaxMs]).toEqual([
      0, 0, 0,
    ]);
    expect(parsed.slowest.http[0]!.selfMs).toBe(0);
    for (const kind of SPAN_KINDS) {
      if (kind !== "http") expect(parsed.aggregates[kind]).toEqual([]);
    }
  });

  test("flight window: spans without the decomposition fields default", () => {
    const span = {
      id: 1,
      parentId: null,
      kind: "http",
      label: "GET /x",
      t0: 0,
      t1: null,
      ageMs: 3,
    };
    const parsed = flightWindowResponseSchema.parse({
      wallAnchor: { atMs: 0, wallTime: "2026-10-22T00:00:00.000Z" },
      window: { atMs: 0, open: [span], completed: [] },
    });
    expect(parsed.window.open[0]!.waitMs).toBe(0);
  });

  test("a retyped field still fails loudly", () => {
    expect(() =>
      runtimeProfileSchema.parse({
        aggregates: {},
        slowest: {},
        sinceMs: "0",
        windowMs: 10,
      }),
    ).toThrow();
  });
});
