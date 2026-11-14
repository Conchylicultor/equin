import { describe, expect, test } from "bun:test";
import type {
  SlowSpan,
  SpanKind,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  resolveSlowThreshold,
  resolveWaitThreshold,
  type Thresholds,
} from "./resolve-threshold";

const thresholds: Thresholds = {
  pageLoadMs: 2000,
  elementMs: 1000,
  updateMs: 1000,
  confirmMs: 2000,
  loaderMs: 2000,
  httpMs: 2000,
  dbMs: 500,
  jobMs: 3000,
  browserHostBootMs: 5000,
};

function span(kind: SpanKind, budgetMs?: number): SlowSpan {
  return {
    id: 1,
    parentId: null,
    kind,
    label: "resolve-threshold-test",
    durationMs: 5000,
    atMs: 0,
    parent: null,
    waitMs: 0,
    childMs: 0,
    selfMs: 5000,
    excludedMs: 0,
    ...(budgetMs !== undefined && { budgetMs }),
  };
}

describe("resolveSlowThreshold", () => {
  test("a declared budget wins over the kind default", () => {
    expect(resolveSlowThreshold(span("bg", 15_000), thresholds)).toBe(15_000);
    expect(resolveSlowThreshold(span("loader", 7000), thresholds)).toBe(7000);
    expect(resolveSlowThreshold(span("job", 9000), thresholds)).toBe(9000);
  });

  test("without a declared budget, the kind default applies", () => {
    expect(resolveSlowThreshold(span("bg"), thresholds)).toBe(2000);
    expect(resolveSlowThreshold(span("db"), thresholds)).toBe(500);
    // An unregistered job name falls back to the global `jobMs`.
    expect(resolveSlowThreshold(span("job"), thresholds)).toBe(3000);
  });

  test("a latency leaf (a delivery) is held to the update bar", () => {
    expect(
      resolveSlowThreshold({ ...span("push"), latency: true }, thresholds),
    ).toBe(thresholds.updateMs);
  });
});

describe("resolveWaitThreshold", () => {
  const caller = { kind: "push" as const, label: "deliver:x" };
  test("a gate's queue holds work back: the loader bar", () => {
    expect(
      resolveWaitThreshold({ layer: "read-admit", ms: 0, caller }, thresholds),
    ).toBe(2000);
  });
  test("a latency leaf's queue is staleness a tab shows: the update bar", () => {
    expect(
      resolveWaitThreshold(
        { layer: "flush-queue", ms: 0, caller, latency: true },
        { ...thresholds, updateMs: 800 },
      ),
    ).toBe(800);
  });
  test("one request's waits summed are still judged per request: the loader bar", () => {
    expect(
      resolveWaitThreshold(
        { layer: "read-admit", ms: 0, caller, waits: 300 },
        thresholds,
      ),
    ).toBe(2000);
  });
  test("a gate's busy stretch is a latency: the loader bar, whatever the waits", () => {
    // 250 reads that queued together for 0.5 s are judged on the 0.5 s.
    const stretch = {
      layer: "read-admit",
      caller,
      busy: true as const,
      longestWaitMs: 300,
    };
    expect(
      resolveWaitThreshold({ ...stretch, ms: 500, waits: 250 }, thresholds),
    ).toBe(2000);
  });
});
