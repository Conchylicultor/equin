import { afterEach, describe, expect, test } from "bun:test";
import {
  onSlowSpan,
  resetRuntimeProfile,
  type SlowSpan,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { routeWithSpan } from "./route-span";

afterEach(() => resetRuntimeProfile());

function capture(run: () => void): SlowSpan[] {
  const seen: SlowSpan[] = [];
  const sub = onSlowSpan((s) => seen.push(s), { thresholdMs: 0 });
  try {
    run();
  } finally {
    sub.dispose();
  }
  return seen.filter((s) => s.kind === "route");
}

describe("routeWithSpan", () => {
  test("routes the change and records a route span labelled by table, with ids and time since the change", () => {
    const routed: string[] = [];
    const spans = capture(() =>
      routeWithSpan(
        {
          source: "feed",
          table: "tasks",
          op: "U",
          ids: ["1", "2"],
          xid: "9",
          changedAt: Date.now() - 50,
          keys: null,
          unchanged: null,
        },
        (c) => routed.push(c.table),
      ),
    );
    expect(routed).toEqual(["tasks"]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.label).toBe("tasks");
    expect(spans[0]!.parent).toBeNull();
    expect(spans[0]!.detail?.measures?.ids).toBe(2);
    expect(spans[0]!.detail?.measures?.sinceChangeMs).toBeGreaterThanOrEqual(
      50,
    );
  });

  test("a FULL change with no timestamp carries no measures", () => {
    const spans = capture(() =>
      routeWithSpan(
        {
          table: "tasks",
          op: "U",
          ids: null,
          source: "feed",
          keys: null,
          unchanged: null,
        },
        () => {},
      ),
    );
    expect(spans[0]!.detail).toBeUndefined();
  });

  test("a throwing route still throws synchronously", () => {
    expect(() =>
      routeWithSpan(
        {
          table: "t",
          op: "I",
          ids: [],
          source: "feed",
          keys: null,
          unchanged: null,
        },
        () => {
          throw new Error("boom");
        },
      ),
    ).toThrow("boom");
  });
});
