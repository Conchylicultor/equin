import { describe, expect, test } from "bun:test";
import type {
  SlowSpan,
  SpanKind,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { resolveSlowThreshold, type Thresholds } from "./resolve-threshold";

const thresholds: Thresholds = {
  pageLoadMs: 2000,
  elementMs: 1000,
  updateMs: 1000,
  confirmMs: 2000,
  loaderMs: 2000,
  httpMs: 2000,
  dbMs: 500,
  jobMs: 3000,
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
});
