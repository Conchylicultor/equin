import { describe, expect, test } from "bun:test";
import {
  defineBreakdown,
  defineMetric,
  defineMetricSource,
} from "../../core/define-metric";
import { bool } from "../../core/params";
import type { MetricQuery } from "../../core";
import { serveBreakdown, serveMetric, type SourceImpl } from "./contribution";
import { buildMetricRegistry } from "./registry";
import { MetricQueryError, runDetails, runDetailsTotal, runQuery } from "./run";

const NOW = new Date("2026-09-30T15:00:00Z");
const src = defineMetricSource({
  id: "fake",
  label: "Fake",
  params: { onlyMine: bool(false) },
});
const done = defineMetric(src, {
  id: "done",
  label: "Done",
  unit: "count",
  polarity: "up",
  measure: "flow",
  splits: [{ id: "kind", label: "Kind" }],
  params: ["onlyMine"],
  drill: { label: "Tasks" },
});
const plain = defineMetric(src, {
  id: "plain",
  label: "Plain",
  unit: "count",
  polarity: "up",
  measure: "flow",
});
const top = defineBreakdown(src, {
  id: "top",
  label: "Top",
  unit: "count",
  order: "value-desc",
});

const seenParams: unknown[] = [];
const source: SourceImpl = {
  source: src,
  metrics: [
    serveMetric(done, {
      evaluate: async ({ intervals, split, params }) => {
        seenParams.push(params);
        return split === null
          ? [{ key: "total", label: "Total", values: intervals.map(() => 1) }]
          : [{ key: "x", label: "X", values: intervals.map(() => 1) }];
      },
      details: async ({ params }) => [
        { id: "t1", title: `mine=${params.onlyMine}`, at: NOW.toISOString() },
      ],
      detailsTotal: async ({ params }) => (params.onlyMine ? 1 : 2),
    }),
    serveMetric(plain, {
      evaluate: async ({ intervals }) => [
        { key: "total", label: "Total", values: intervals.map(() => 0) },
      ],
    }),
  ],
  breakdowns: [
    serveBreakdown(top, {
      evaluate: async () => [
        { key: "a", label: "A", value: 1 },
        { key: "b", label: "B", value: 2 },
      ],
    }),
  ],
};
const registry = buildMetricRegistry([source]);

const base = { range: { preset: "7d" as const }, tz: "UTC", params: {} };

/** Whether `p` is refused as a question the registry cannot answer. */
async function refused(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
  } catch (err) {
    if (err instanceof MetricQueryError) return true;
    throw err;
  }
  return false;
}

describe("catalog", () => {
  test("lists sources, metrics and breakdowns", () => {
    expect(registry.catalog.sources).toEqual([
      {
        id: "fake",
        label: "Fake",
        params: [{ id: "onlyMine", kind: "bool", default: false }],
      },
    ]);
    expect(registry.catalog.metrics.map((m) => m.id)).toEqual([
      "fake.done",
      "fake.plain",
    ]);
    expect(registry.catalog.metrics[0]!.drill).toEqual({ label: "Tasks" });
    expect(registry.catalog.breakdowns.map((b) => b.id)).toEqual(["fake.top"]);
  });

  test("an empty registry has an empty catalog", () => {
    expect(buildMetricRegistry([]).catalog).toEqual({
      sources: [],
      metrics: [],
      breakdowns: [],
    });
  });
});

describe("registry build", () => {
  test("a duplicate source throws", () => {
    expect(() => buildMetricRegistry([source, source])).toThrow(
      /contributed twice/,
    );
  });
  test("a duplicate metric id throws", () => {
    expect(() =>
      buildMetricRegistry([
        { ...source, metrics: [...source.metrics, source.metrics[0]!] },
      ]),
    ).toThrow(/"fake.done" is declared twice/);
  });
  test("a metric contributed under another source throws", () => {
    const other = defineMetricSource({ id: "other", label: "Other" });
    expect(() => buildMetricRegistry([{ ...source, source: other }])).toThrow(
      /declared on source "fake" but contributed under "other"/,
    );
  });
  test("drill without details throws", () => {
    expect(() =>
      buildMetricRegistry([
        {
          source: src,
          metrics: [serveMetric(done, { evaluate: async () => [] })],
        },
      ]),
    ).toThrow(/drill/);
  });
});

describe("runQuery", () => {
  test("evaluates a metric with its params parsed", async () => {
    seenParams.length = 0;
    const r = await runQuery(
      registry,
      {
        ...base,
        metric: "fake.done",
        compare: true,
        params: { onlyMine: true },
      },
      NOW,
    );
    expect(r.kind).toBe("series");
    expect(seenParams).toEqual([{ onlyMine: true }]);
  });

  test("a missing param takes its default", async () => {
    seenParams.length = 0;
    await runQuery(
      registry,
      { ...base, metric: "fake.done", compare: false },
      NOW,
    );
    expect(seenParams).toEqual([{ onlyMine: false }]);
  });

  test("evaluates a breakdown", async () => {
    const r = await runQuery(
      registry,
      { ...base, metric: "fake.top", compare: false },
      NOW,
    );
    expect(r).toEqual({
      kind: "breakdown",
      rows: [
        { key: "b", label: "B", value: 2 },
        { key: "a", label: "A", value: 1 },
      ],
    });
  });

  test.each<[string, MetricQuery]>([
    ["an unknown metric", { ...base, metric: "fake.nope", compare: false }],
    ["an unknown split", { ...base, metric: "fake.done", split: "nope" }],
    [
      "an unknown param",
      { ...base, metric: "fake.done", compare: false, params: { x: 1 } },
    ],
    [
      "a param the metric does not read",
      {
        ...base,
        metric: "fake.plain",
        compare: false,
        params: { onlyMine: true },
      },
    ],
    [
      "a badly typed param",
      { ...base, metric: "fake.done", compare: false, params: { onlyMine: 1 } },
    ],
    ["a split breakdown", { ...base, metric: "fake.top", split: "kind" }],
    [
      "an empty interval",
      {
        ...base,
        metric: "fake.done",
        compare: false,
        range: {
          interval: {
            start: "2026-01-02T00:00:00Z",
            end: "2026-01-01T00:00:00Z",
          },
          bucket: "day",
        },
      },
    ],
  ])("%s is a MetricQueryError", async (_name, query) => {
    expect(await refused(runQuery(registry, query, NOW))).toBe(true);
  });
});

describe("runDetails", () => {
  const interval = {
    start: "2026-09-29T00:00:00Z",
    end: "2026-09-30T00:00:00Z",
  };
  const q = {
    metric: "fake.done",
    interval,
    split: null,
    params: {},
  };
  const page = { after: null, until: null, limit: 5 };

  test("calls the metric's details with parsed params", async () => {
    const drill = await runDetails(
      registry,
      { ...q, params: { onlyMine: true } },
      page,
    );
    expect(drill[0]!.title).toBe("mine=true");
  });

  test("the total is the metric's detailsTotal over the parsed params", async () => {
    expect(
      await runDetailsTotal(registry, { ...q, params: { onlyMine: true } }),
    ).toBe(1);
    expect(await runDetailsTotal(registry, q)).toBe(2);
  });

  test.each([
    ["an unknown metric", { ...q, metric: "fake.nope" }],
    ["a breakdown", { ...q, metric: "fake.top" }],
    ["a metric without details", { ...q, metric: "fake.plain" }],
    ["an unknown split", { ...q, split: { id: "nope", key: "x" } }],
    ["a bad param", { ...q, params: { onlyMine: "x" } }],
    [
      "an empty interval",
      { ...q, interval: { start: interval.end, end: interval.start } },
    ],
  ])("%s is a MetricQueryError", async (_name, query) => {
    expect(await refused(runDetails(registry, query, page))).toBe(true);
    expect(await refused(runDetailsTotal(registry, query))).toBe(true);
  });
});
