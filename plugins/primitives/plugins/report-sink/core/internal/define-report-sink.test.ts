import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  defineReportSink,
  discardHeldReports,
  defineRequestSink,
  REPORT_SINK_HOLD_CAP,
} from "./define-report-sink";

const warn = spyOn(console, "warn").mockImplementation(() => {});

afterAll(() => {
  warn.mockRestore();
});

afterEach(() => {
  warn.mockClear();
});

describe("defineReportSink", () => {
  test("holds reports emitted before a handler registers, then replays them in order", () => {
    const sink = defineReportSink<number>("test");
    sink.emit(1);
    sink.emit(2);
    const seen: number[] = [];
    sink.register((n) => seen.push(n));
    expect(seen).toEqual([1, 2]);
  });

  test("delivers straight through once a handler is registered", () => {
    const sink = defineReportSink<number>("test");
    const seen: number[] = [];
    sink.register((n) => seen.push(n));
    sink.emit(1);
    expect(seen).toEqual([1]);
  });

  test("replays each held report once, not again to a later handler", () => {
    const sink = defineReportSink<number>("test");
    sink.emit(1);
    const first: number[] = [];
    sink.register((n) => first.push(n));
    const second: number[] = [];
    sink.register((n) => second.push(n));
    expect(first).toEqual([1]);
    expect(second).toEqual([]);
  });

  test("holds across an unregister gap and replays to the next handler", () => {
    const sink = defineReportSink<number>("test");
    sink.register(() => {});
    sink.register(null);
    sink.emit(7);
    const seen: number[] = [];
    sink.register((n) => seen.push(n));
    expect(seen).toEqual([7]);
  });

  test("register(null) discards what is held", () => {
    const sink = defineReportSink<number>("test");
    sink.emit(1);
    sink.register(null);
    const seen: number[] = [];
    sink.register((n) => seen.push(n));
    expect(seen).toEqual([]);
  });

  test("keeps the first reports past the cap, drops newer ones and warns once", () => {
    const sink = defineReportSink<number>("test");
    for (let i = 0; i < REPORT_SINK_HOLD_CAP + 5; i++) sink.emit(i);
    expect(warn).toHaveBeenCalledTimes(1);
    const seen: number[] = [];
    sink.register((n) => seen.push(n));
    expect(seen).toHaveLength(REPORT_SINK_HOLD_CAP);
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(REPORT_SINK_HOLD_CAP - 1);
  });

  test("warns again on a later overflow, after the hold was drained", () => {
    const sink = defineReportSink<number>("test");
    for (let i = 0; i <= REPORT_SINK_HOLD_CAP; i++) sink.emit(i);
    sink.register(() => {});
    sink.register(null);
    for (let i = 0; i <= REPORT_SINK_HOLD_CAP; i++) sink.emit(i);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("swallows a throwing handler, on replay and on direct delivery", () => {
    const sink = defineReportSink<number>("test");
    const seen: number[] = [];
    sink.emit(1);
    sink.emit(2);
    const handler = (n: number) => {
      seen.push(n);
      throw new Error("boom");
    };
    expect(() => sink.register(handler)).not.toThrow();
    expect(() => sink.emit(3)).not.toThrow();
    // A throw on one held report does not cost the ones after it.
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("defineRequestSink", () => {
  test("returns undefined with no handler, and never replays that request later", () => {
    const sink = defineRequestSink<number, number>("test");
    expect(sink.emit(1)).toBeUndefined();
    const seen: number[] = [];
    sink.register((n) => {
      seen.push(n);
      return n * 2;
    });
    expect(seen).toEqual([]);
    expect(sink.emit(2)).toBe(4);
  });

  test("swallows a throwing handler and answers undefined", () => {
    const sink = defineRequestSink<number, number>("test");
    sink.register(() => {
      throw new Error("boom");
    });
    expect(sink.emit(1)).toBeUndefined();
  });
});

test("discardHeldReports empties every sink's hold, so a later handler hears only what follows", () => {
  const a = defineReportSink<string>("test");
  const b = defineReportSink<string>("test");
  a.emit("stale-a");
  b.emit("stale-b");
  discardHeldReports();
  const got: string[] = [];
  a.register((s) => got.push(s));
  b.register((s) => got.push(s));
  a.emit("fresh");
  expect(got).toEqual(["fresh"]);
  a.register(null);
  b.register(null);
});
