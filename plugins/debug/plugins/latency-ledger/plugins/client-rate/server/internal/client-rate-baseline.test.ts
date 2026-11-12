import { describe, expect, test } from "bun:test";
import type { ClientHour } from "@plugins/debug/plugins/latency-ledger/server";
import {
  appOfRoute,
  baselineOf,
  currentHour,
  historyRange,
  judgeClientHours,
  MIN_HISTORY_CLIENT_HOURS,
  quantile,
} from "./client-rate-baseline";

const hour = (
  clientId: string,
  count: number,
  kind: ClientHour["kind"] = "page-load",
  automated = false,
): ClientHour => ({
  clientId,
  kind,
  route: "/demo",
  hourStart: 0,
  count,
  automated,
});

// The shape of main's real client-hours (live-state log, 3 days, 513
// client-hours: documents per tab per hour, all routes together — an upper
// bound on one route's): mostly 1, a tail to 12.
const REAL_SHAPE: [count: number, times: number][] = [
  [1, 394],
  [2, 66],
  [3, 25],
  [4, 14],
  [5, 2],
  [6, 4],
  [7, 4],
  [8, 1],
  [10, 2],
  [12, 1],
];
const realHistory = (): ClientHour[] =>
  REAL_SHAPE.flatMap(([count, times], i) =>
    Array.from({ length: times }, (_, j) => hour(`c${i}-${j}`, count)),
  );

describe("quantile", () => {
  test("nearest rank", () => {
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.99)).toBe(10);
    expect(quantile([5, 1, 3], 0.5)).toBe(3);
  });
  test("refuses an empty set", () => {
    expect(() => quantile([], 0.99)).toThrow();
  });
});

describe("ranges", () => {
  test("history is the 7 whole UTC days before today; the hour is the clock hour so far", () => {
    const now = Date.parse("2026-11-12T08:42:00Z");
    expect(historyRange(now).from.toISOString()).toBe(
      "2026-11-05T00:00:00.000Z",
    );
    expect(historyRange(now).to.toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(currentHour(now).from.toISOString()).toBe(
      "2026-11-12T08:00:00.000Z",
    );
  });
});

describe("judgeClientHours", () => {
  test("a tab reloading 34×/hour trips against real browsing; real browsing does not", () => {
    const history = realHistory();
    const base = baselineOf(history);
    expect(base["page-load"]).toEqual({
      kind: "judged",
      clientHours: 513,
      usual: 7,
    });
    // Every real client-hour, replayed as the current hour: none trips.
    expect(judgeClientHours(history, base, 3)).toEqual([]);
    const trips = judgeClientHours(
      [hour("loop", 34, "page-load", true), hour("person", 12)],
      base,
      3,
    );
    expect(trips).toEqual([
      {
        clientId: "loop",
        interaction: "page-load",
        route: "/demo",
        count: 34,
        automated: true,
        usual: 7,
        threshold: 21,
        historyClientHours: 513,
      },
    ]);
  });

  test("an automated client is judged like any other, not skipped", () => {
    const base = baselineOf(realHistory());
    expect(
      judgeClientHours([hour("bot", 22, "page-load", true)], base, 3),
    ).toHaveLength(1);
    expect(
      judgeClientHours([hour("bot", 21, "page-load", true)], base, 3),
    ).toHaveLength(0);
  });

  test("each kind is judged against its own history; a kind in warm-up judges nothing", () => {
    const history = [
      ...realHistory(),
      ...Array.from({ length: MIN_HISTORY_CLIENT_HOURS - 1 }, (_, i) =>
        hour(`n${i}`, 40, "navigate"),
      ),
    ];
    const base = baselineOf(history);
    expect(base.navigate).toEqual({
      kind: "warm-up",
      clientHours: MIN_HISTORY_CLIENT_HOURS - 1,
    });
    expect(judgeClientHours([hour("x", 10_000, "navigate")], base, 3)).toEqual(
      [],
    );
  });

  test("trips are ordered furthest past their bar first", () => {
    const base = baselineOf(realHistory());
    const trips = judgeClientHours([hour("a", 40), hour("b", 300)], base, 3);
    expect(trips.map((t) => t.clientId)).toEqual(["b", "a"]);
  });
});

describe("appOfRoute", () => {
  test("first path segment", () => {
    expect(appOfRoute("/demo/at/desktop/sonata;full=1")).toBe("/demo");
    expect(appOfRoute("/agents?x=1")).toBe("/agents");
    expect(appOfRoute("/")).toBe("/");
  });
});
