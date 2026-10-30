import { describe, expect, test } from "bun:test";
import type { Span } from "@plugins/framework/plugins/server-core/core";
import { budgetForSpan } from "./budget";

const cfg = {
  enabled: true,
  onReadyBlockingBudgetMs: 500,
  onReadyBudgetMs: 400,
  onAllReadyBudgetMs: 300,
  warmupBudgetMs: 2000,
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
  test("a warm-up's declared budget wins over the config default", () => {
    expect(
      budgetForSpan(
        span({
          id: "warmup:plugin-tree.trees",
          phase: "warmup",
          budgetMs: 15_000,
        }),
        cfg,
      ),
    ).toEqual({ budgetMs: 15_000, source: "declared" });
  });

  test("a warm-up without one is judged on the config default", () => {
    expect(
      budgetForSpan(span({ id: "warmup:other", phase: "warmup" }), cfg),
    ).toEqual({ budgetMs: 2000, source: "config" });
  });

  test("per-plugin boot hooks keep their per-phase budget", () => {
    expect(budgetForSpan(span({ plugin: "p", phase: "onReady" }), cfg)).toEqual(
      {
        budgetMs: 400,
        source: "config",
      },
    );
  });

  test("an unmonitored span stays unmonitored even if it carries a budget", () => {
    expect(
      budgetForSpan(span({ phase: "onReady", budgetMs: 1 }), cfg),
    ).toBeNull();
  });
});
