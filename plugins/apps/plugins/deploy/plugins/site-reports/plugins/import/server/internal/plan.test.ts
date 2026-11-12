import { describe, expect, test } from "bun:test";
import type { SiteReportRecord } from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";
import { planImport } from "./plan";

function row(fingerprint: string, lastSeenAt: string): SiteReportRecord {
  return {
    fingerprint,
    kind: "crash",
    source: "browser-error",
    message: "m",
    data: {},
    path: "/",
    buildId: null,
    commit: null,
    count: 1,
    firstSeenAt: "2026-11-12T00:00:00.000Z",
    lastSeenAt,
  };
}

const PAGE = [
  row("c", "2026-11-12T03:00:00.000Z"),
  row("a", "2026-11-12T01:00:00.000Z"),
  row("b", "2026-11-12T02:00:00.000Z"),
];

describe("planImport", () => {
  test("a first pull takes every row, oldest first, and stands at the newest", () => {
    const plan = planImport(PAGE, null, 50);
    expect(plan.take.map((r) => r.fingerprint)).toEqual(["a", "b", "c"]);
    expect(plan.watermark?.toISOString()).toBe("2026-11-12T03:00:00.000Z");
  });

  test("takes only rows seen after the watermark", () => {
    const plan = planImport(PAGE, new Date("2026-11-12T02:00:00.000Z"), 50);
    expect(plan.take.map((r) => r.fingerprint)).toEqual(["c"]);
  });

  test("caps a run, and the watermark stands at the last row taken so the rest come next run", () => {
    const first = planImport(PAGE, null, 2);
    expect(first.take.map((r) => r.fingerprint)).toEqual(["a", "b"]);
    expect(first.watermark?.toISOString()).toBe("2026-11-12T02:00:00.000Z");
    const next = planImport(PAGE, first.watermark, 2);
    expect(next.take.map((r) => r.fingerprint)).toEqual(["c"]);
  });

  test("nothing new leaves the watermark where it was", () => {
    const at = new Date("2026-11-12T05:00:00.000Z");
    const plan = planImport(PAGE, at, 50);
    expect(plan.take).toEqual([]);
    expect(plan.watermark).toBe(at);
  });

  test("a flood on the site is bounded per run", () => {
    const flood = Array.from({ length: 200 }, (_, i) =>
      row(`f${i}`, new Date(Date.UTC(2026, 10, 12, 0, 0, i)).toISOString()),
    );
    expect(planImport(flood, null, 50).take).toHaveLength(50);
  });

  test("never cuts through rows seen at the same instant: the group waits whole for the next run", () => {
    const tied = [
      row("a", "2026-11-12T01:00:00.000Z"),
      row("b", "2026-11-12T02:00:00.000Z"),
      row("c", "2026-11-12T02:00:00.000Z"),
    ];
    const first = planImport(tied, null, 2);
    expect(first.take.map((r) => r.fingerprint)).toEqual(["a"]);
    const next = planImport(tied, first.watermark, 2);
    expect(next.take.map((r) => r.fingerprint)).toEqual(["b", "c"]);
  });

  test("a first tie group larger than the cap is taken whole", () => {
    const tied = ["a", "b", "c"].map((f) => row(f, "2026-11-12T02:00:00.000Z"));
    expect(planImport(tied, null, 2).take).toHaveLength(3);
  });
});
