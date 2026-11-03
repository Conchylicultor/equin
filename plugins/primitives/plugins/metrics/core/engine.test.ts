import { describe, expect, test } from "bun:test";
import {
  defineBreakdown,
  defineMetric,
  defineMetricSource,
} from "./define-metric";
import {
  cumulative,
  delta,
  displayError,
  evaluateBreakdown,
  evaluateMetric,
  type EvaluateCtx,
  type EvaluatedRow,
} from "./engine";
import type { Interval } from "./intervals";

// A fake source over an in-memory event list. Every rule under test is the
// engine's; the fake only answers "what is the value over this interval".

const NOW = new Date("2026-09-30T15:00:00Z");
const src = defineMetricSource({ id: "fake", label: "Fake" });

interface Event {
  at: string;
  user: string;
  kind: "a" | "b";
  value: number;
}

// Two events a day for the last week, by two users, alternating kinds.
const EVENTS: Event[] = Array.from({ length: 7 }, (_, d) => [
  {
    at: `2026-09-${24 + d}T08:00:00Z`,
    user: "ann",
    kind: "a" as const,
    value: d + 1,
  },
  {
    at: `2026-09-${24 + d}T09:00:00Z`,
    user: "bob",
    kind: "b" as const,
    value: 10 * (d + 1),
  },
]).flat();

function inside(e: Event, iv: Interval): boolean {
  return e.at >= iv.start && e.at < iv.end;
}

type Calls = EvaluateCtx<Record<string, never>>[];

function fake(
  value: (events: Event[], iv: Interval) => number | null,
  calls: Calls = [],
) {
  return async (
    ctx: EvaluateCtx<Record<string, never>>,
  ): Promise<EvaluatedRow[]> => {
    calls.push(ctx);
    const at = (events: Event[]) =>
      ctx.intervals.map((iv) => value(events, iv));
    if (ctx.split === null)
      return [{ key: "total", label: "Total", values: at(EVENTS) }];
    return (["a", "b"] as const).map((k) => ({
      key: k,
      label: k.toUpperCase(),
      values: at(EVENTS.filter((e) => e.kind === k)),
    }));
  };
}

const count = (events: Event[], iv: Interval) =>
  events.filter((e) => inside(e, iv)).length;
const distinctUsers = (events: Event[], iv: Interval) =>
  new Set(events.filter((e) => inside(e, iv)).map((e) => e.user)).size;
const median = (events: Event[], iv: Interval) => {
  const v = events
    .filter((e) => inside(e, iv))
    .map((e) => e.value)
    .sort((x, y) => x - y);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
};

const flow = defineMetric(src, {
  id: "users",
  label: "Active users",
  unit: "count",
  polarity: "up",
  measure: "flow",
  splits: [{ id: "kind", label: "Kind" }],
});
const rate = defineMetric(src, {
  id: "median",
  label: "Median",
  unit: "seconds",
  polarity: "down",
  measure: "rate",
});
const level = defineMetric(src, {
  id: "open",
  label: "Open",
  unit: "count",
  polarity: "neutral",
  measure: "level",
});

const week = { range: { preset: "7d" as const }, tz: "UTC", params: {} };

describe("evaluateMetric", () => {
  test("makes one evaluate call over buckets, previous buckets, range and previous range", async () => {
    const calls: Calls = [];
    await evaluateMetric(
      flow,
      { ...week, compare: true },
      fake(count, calls),
      NOW,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.intervals).toHaveLength(7 + 7 + 2);
    expect(calls[0]!.split).toBeNull();
  });

  test("a flow total is the range evaluated as one interval, not a sum of buckets", async () => {
    const r = await evaluateMetric(
      flow,
      { ...week, compare: false },
      fake(distinctUsers),
      NOW,
    );
    expect(r.series[0]!.values).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(r.total).toBe(2);
  });

  test("a level tile is the value at the range's end", async () => {
    // A provider whose range value differs from its last bucket: the tile must
    // read the last bucket.
    const lastBucketOrNine = async (
      ctx: EvaluateCtx<Record<string, never>>,
    ) => [
      {
        key: "total",
        label: "Total",
        values: ctx.intervals.map((_, i) =>
          i === ctx.intervals.length - 1 ? 9 : i + 1,
        ),
      },
    ];
    const r = await evaluateMetric(
      level,
      { ...week, compare: false },
      lastBucketOrNine,
      NOW,
    );
    expect(r.series[0]!.values).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.total).toBe(7);
  });

  test("a rate tile is the range evaluated as one interval", async () => {
    const r = await evaluateMetric(
      rate,
      { ...week, compare: false },
      fake(median),
      NOW,
    );
    // Per day the median of {d+1, 10(d+1)}; over the week the median of all 14 values.
    expect(r.series[0]!.values).toEqual([5.5, 11, 16.5, 22, 27.5, 33, 38.5]);
    expect(r.total).toBe(8.5);
    const sumOfBuckets = r.series[0]!.values.reduce((a, b) => a! + b!, 0);
    expect(r.total).not.toBe(sumOfBuckets);
  });

  test("null coverage is a gap and a null total", async () => {
    const coveredFrom = "2026-09-27T00:00:00.000Z";
    const r = await evaluateMetric(
      flow,
      { ...week, compare: false },
      fake((events, iv) => (iv.start < coveredFrom ? null : count(events, iv))),
      NOW,
    );
    expect(r.series[0]!.values).toEqual([null, null, null, 2, 2, 2, 2]);
    expect(r.total).toBeNull();
    expect(cumulative(r.series[0]!.values)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test("previous is present only when comparing (and so unsplit)", async () => {
    const compared = await evaluateMetric(
      flow,
      { ...week, compare: true },
      fake(count),
      NOW,
    );
    expect(compared.previous).toBeDefined();
    expect(compared.previous!.values).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(compared.previous!.total).toBe(0);
    expect(compared.previous!.buckets).toHaveLength(7);
    expect(compared.previous!.label).toBe("Previous 7 days");

    const plain = await evaluateMetric(
      flow,
      { ...week, compare: false },
      fake(count),
      NOW,
    );
    expect(plain.previous).toBeUndefined();
    const split = await evaluateMetric(
      flow,
      { ...week, split: "kind" },
      fake(count),
      NOW,
    );
    expect(split.previous).toBeUndefined();
  });

  test("a split query's total comes from an unsplit evaluation of the range", async () => {
    // Split rows of 1 each, and an unsplit answer of 5: a sum of the series
    // would say 2.
    const calls: Calls = [];
    const evaluate = async (ctx: EvaluateCtx<Record<string, never>>) => {
      calls.push(ctx);
      const fill = (v: number) => ctx.intervals.map(() => v);
      return ctx.split === null
        ? [{ key: "total", label: "Total", values: fill(5) }]
        : [
            { key: "a", label: "A", values: fill(1) },
            { key: "b", label: "B", values: fill(1) },
          ];
    };
    const r = await evaluateMetric(
      flow,
      { ...week, split: "kind" },
      evaluate,
      NOW,
    );
    expect(r.series.map((s) => [s.key, s.total])).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.split).toBeNull();
    expect(calls[1]!.intervals).toEqual([calls[0]!.intervals.at(-1)!]);
    expect(r.total).toBe(5);
  });

  test("split series are ordered by total, largest first", async () => {
    const r = await evaluateMetric(
      flow,
      { ...week, split: "kind" },
      fake((events, iv) =>
        events.filter((e) => inside(e, iv)).reduce((s, e) => s + e.value, 0),
      ),
      NOW,
    );
    expect(r.series.map((s) => s.key)).toEqual(["b", "a"]);
  });

  test("an unknown split throws", async () => {
    expect(
      evaluateMetric(flow, { ...week, split: "nope" }, fake(count), NOW),
    ).rejects.toThrow(/no split "nope"/);
  });

  test("a result of the wrong length throws", async () => {
    const short = async () => [
      { key: "total", label: "Total", values: [1, 2] },
    ];
    expect(
      evaluateMetric(flow, { ...week, compare: false }, short, NOW),
    ).rejects.toThrow(/2 values for 8 intervals/);
  });

  test("an unsplit evaluation returning several rows throws", async () => {
    const two = async (ctx: EvaluateCtx<Record<string, never>>) =>
      ["x", "y"].map((key) => ({
        key,
        label: key,
        values: ctx.intervals.map(() => 0),
      }));
    expect(
      evaluateMetric(flow, { ...week, compare: false }, two, NOW),
    ).rejects.toThrow(/exactly one/);
  });

  test("a non-finite value throws", async () => {
    const nan = async (ctx: EvaluateCtx<Record<string, never>>) => [
      {
        key: "total",
        label: "Total",
        values: ctx.intervals.map(() => Number.NaN),
      },
    ];
    expect(
      evaluateMetric(flow, { ...week, compare: false }, nan, NOW),
    ).rejects.toThrow(/non-finite/);
  });
});

describe("evaluateBreakdown", () => {
  test("evaluates the range as one interval and orders rows as declared", async () => {
    const top = defineBreakdown(src, {
      id: "top",
      label: "Top",
      unit: "count",
      order: "value-desc",
    });
    let seen: Interval | undefined;
    const r = await evaluateBreakdown(
      top,
      week,
      async ({ interval }) => {
        seen = interval;
        return [
          { key: "x", label: "X", value: 1 },
          { key: "y", label: "Y", value: 3 },
          { key: "z", label: "Z", value: 2 },
        ];
      },
      NOW,
    );
    expect(seen).toEqual({
      start: "2026-09-24T00:00:00.000Z",
      end: NOW.toISOString(),
    });
    expect(r.rows.map((row) => row.key)).toEqual(["y", "z", "x"]);
  });
});

describe("delta", () => {
  test("pct", () => {
    expect(delta(15, 10)).toEqual({ kind: "pct", value: 0.5 });
    expect(delta(5, -10)).toEqual({ kind: "pct", value: 1.5 });
  });
  test("new when the previous period had nothing", () => {
    expect(delta(3, 0)).toEqual({ kind: "new" });
  });
  test("no change from nothing to nothing", () => {
    expect(delta(0, 0)).toEqual({ kind: "pct", value: 0 });
  });
  test("none when either side is not covered", () => {
    expect(delta(null, 3)).toEqual({ kind: "none" });
    expect(delta(3, null)).toEqual({ kind: "none" });
  });
});

describe("cumulative", () => {
  test("running sum", () => {
    expect(cumulative([1, 2, 0, 4])).toEqual([1, 3, 3, 7]);
  });
  test("null from the first gap on", () => {
    expect(cumulative([1, null, 2])).toEqual([1, null, null]);
  });
});

describe("displayError", () => {
  test("cumulative is legal on a flow only", () => {
    expect(displayError(flow, { chart: "area", cumulative: true })).toBeNull();
    expect(displayError(level, { chart: "area", cumulative: true })?.kind).toBe(
      "cumulative-needs-flow",
    );
    expect(displayError(rate, { chart: "line", cumulative: true })?.kind).toBe(
      "cumulative-needs-flow",
    );
  });
  test("stacking or netting a rate is illegal", () => {
    expect(
      displayError(rate, { chart: "stack", cumulative: false })?.kind,
    ).toBe("sum-across-splits-on-rate");
    expect(displayError(rate, { chart: "net", cumulative: false })?.kind).toBe(
      "sum-across-splits-on-rate",
    );
    expect(displayError(rate, { chart: "line", cumulative: false })).toBeNull();
    expect(
      displayError(level, { chart: "stack", cumulative: false }),
    ).toBeNull();
  });
});
