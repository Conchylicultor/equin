import { describe, expect, it } from "bun:test";
import { describeNoopWaste } from "../../core";
import { liveStateChurnConfig } from "../../core";
import type { KeySnapshot } from "./accumulator";
import { noopReportData } from "./monitor-job";

const cfg = {
  wastedMsPerMinuteThreshold:
    liveStateChurnConfig.defaults.wastedMsPerMinuteThreshold,
  windowSeconds: 60,
};

function snap(o: Partial<KeySnapshot>): KeySnapshot {
  return {
    resourceKey: "k",
    noopCount: 0,
    totalCount: 0,
    subscribers: 1,
    noopRate: 0,
    noopOwnMs: 0,
    noopIoMs: 0,
    noopWaitMs: 0,
    unmeasuredNoops: 0,
    measuredMsPerMinute: 0,
    wastedMsPerMinute: 0,
    noopTuples: 1,
    ...o,
  };
}

describe("the monitor files on wasted work", () => {
  it("does not file today's cheap churners (main, 2026-11-14)", () => {
    // tasks.tree.v2:groups at its worst report: 3.1 no-op/s × ~3 ms own.
    const groups = snap({
      resourceKey: "tasks.tree.v2:groups",
      noopCount: 186,
      totalCount: 186,
      noopRate: 3.1,
      noopOwnMs: 558,
      wastedMsPerMinute: 558,
    });
    // tasks.tree.v2: ~1/s × ~2 ms own.
    const tree = snap({
      resourceKey: "tasks.tree.v2",
      noopCount: 61,
      noopRate: 1.02,
      noopOwnMs: 122,
      wastedMsPerMinute: 122,
    });
    expect(noopReportData(groups, cfg)).toBeNull();
    expect(noopReportData(tree, cfg)).toBeNull();
  });

  it("files an expensive one at one no-op a minute, stating the waste beside the rate", () => {
    const d = noopReportData(
      snap({
        resourceKey: "build.deployment",
        noopCount: 1,
        totalCount: 1,
        noopRate: 1 / 60,
        noopOwnMs: 300,
        noopIoMs: 1700,
        noopWaitMs: 1900,
        wastedMsPerMinute: 2000,
      }),
      cfg,
    );
    expect(d).not.toBeNull();
    expect(d!.wastedMsPerMinute).toBe(2000);
    expect(describeNoopWaste(d!)).toBe(
      "~2000 ms/min of wasted work (over 60s measured: own 300 ms, io 1700 ms; 200 ms queued/joined, not counted) · ~0.0 no-op pushes/s (×1/60s)",
    );
  });

  it("does not file a cheap churner a loaded host inflated, and says what contention added", () => {
    // tasks.tree.v2:groups, 2026-11-14 23:43 UTC: 98 no-ops measured
    // 4869 ms own, each tuple's cheapest run ~3 ms.
    const s = snap({
      resourceKey: "tasks.tree.v2:groups",
      noopCount: 98,
      totalCount: 98,
      noopRate: 98 / 60,
      noopOwnMs: 4869,
      noopWaitMs: 1180,
      measuredMsPerMinute: 4869,
      wastedMsPerMinute: 294,
    });
    expect(noopReportData(s, cfg)).toBeNull();
    const d = noopReportData(s, { ...cfg, wastedMsPerMinuteThreshold: 0 })!;
    expect(describeNoopWaste(d)).toBe(
      "~294 ms/min of wasted work (over 60s measured: own 4869 ms; 1180 ms queued/joined, not counted; ~4575 ms/min above each tuple's cheapest run, not counted (contention)) · ~1.6 no-op pushes/s (×98/60s)",
    );
  });

  it("never files no-ops whose cost was not measured", () => {
    expect(
      noopReportData(
        snap({ noopCount: 600, noopRate: 10, unmeasuredNoops: 600 }),
        cfg,
      ),
    ).toBeNull();
  });

  it("never files a resource with no no-op, even at a 0 bar", () => {
    expect(
      noopReportData(snap({ totalCount: 50 }), {
        ...cfg,
        wastedMsPerMinuteThreshold: 0,
      }),
    ).toBeNull();
  });

  it("an old report (no cost fields) reads as unmeasured", () => {
    expect(
      describeNoopWaste({
        resourceKey: "k",
        noopRate: 3.07,
        noopCount: 184,
        totalCount: 184,
        subscribers: 2,
        windowSeconds: 60,
      }),
    ).toBe("~3.1 no-op pushes/s (×184/60s), cost not measured");
  });
});
