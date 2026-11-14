import { describe, expect, test } from "bun:test";
import type { Span } from "@plugins/framework/plugins/server-core/core";
import { budgetForSpan, stepsUnder } from "./budget";

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

describe("stepsUnder", () => {
  test("a hook's steps, nested depth-first in start order, offsets from the hook", () => {
    const hook = span({ id: "onReady:p", plugin: "p", startMs: 100 });
    const spans = [
      hook,
      span({
        id: "onReady:p/b",
        phase: "step",
        label: "b",
        parent: "onReady:p",
        startMs: 150,
        durationMs: 5,
      }),
      span({
        id: "onReady:p/a",
        phase: "step",
        label: "a",
        parent: "onReady:p",
        startMs: 100,
        durationMs: 40,
      }),
      span({
        id: "onReady:p/a/x",
        phase: "step",
        label: "x",
        parent: "onReady:p/a",
        startMs: 110,
        durationMs: 30,
      }),
      span({
        id: "onReady:q/c",
        phase: "step",
        label: "c",
        parent: "onReady:q",
        startMs: 100,
        durationMs: 1,
      }),
    ];
    expect(stepsUnder(hook, spans)).toEqual([
      { name: "a", depth: 1, atMs: 0, durationMs: 40 },
      { name: "x", depth: 2, atMs: 10, durationMs: 30 },
      { name: "b", depth: 1, atMs: 50, durationMs: 5 },
    ]);
  });

  test("a step span is never budgeted on its own", () => {
    expect(
      budgetForSpan(span({ phase: "step", plugin: "p", durationMs: 1e6 }), cfg),
    ).toBeNull();
  });
});
