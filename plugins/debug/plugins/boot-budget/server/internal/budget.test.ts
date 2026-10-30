import { describe, expect, test } from "bun:test";
import type { Span } from "@plugins/framework/plugins/server-core/core";
import { budgetForSpan } from "./budget";

const cfg = {
  enabled: true,
  onReadyBlockingBudgetMs: 500,
  onReadyBudgetMs: 400,
  onAllReadyBudgetMs: 300,
};

function span(over: Partial<Span>): Span {
  return {
    id: "x",
    phase: "onReady",
    label: "x",
    startMs: 0,
    durationMs: 0,
    ...over,
  };
}

describe("budgetForSpan", () => {
  test("per-plugin boot hooks keep their per-phase budget", () => {
    expect(budgetForSpan(span({ plugin: "p", phase: "onReady" }), cfg)).toBe(
      400,
    );
    expect(
      budgetForSpan(span({ plugin: "p", phase: "onReadyBlocking" }), cfg),
    ).toBe(500);
  });

  test("a warm-up is not judged here — slow-ops judges its bg span", () => {
    expect(
      budgetForSpan(
        span({ id: "warmup:plugin-tree.trees", phase: "warmup", plugin: "p" }),
        cfg,
      ),
    ).toBeNull();
    expect(
      budgetForSpan(span({ id: "warmup:other", phase: "warmup" }), cfg),
    ).toBeNull();
  });

  test("a whole-phase wrapper span (no plugin) is unmonitored", () => {
    expect(budgetForSpan(span({ phase: "onReady" }), cfg)).toBeNull();
  });
});
