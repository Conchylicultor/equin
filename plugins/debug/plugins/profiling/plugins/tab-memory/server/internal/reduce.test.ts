import { describe, expect, it } from "bun:test";
import type { OwnerSample } from "@plugins/debug/plugins/sentinel/plugins/machine-usage/core";
import { jsHeapGrowthMbPerHour, type TabMemorySample } from "../../core";
import { pagesFrom, renderersFrom } from "./reduce";

const MIN = 60_000;

function sample(over: Partial<TabMemorySample>): TabMemorySample {
  return {
    sampledAt: 0,
    tabId: "tab-a",
    pageStartedAt: 1,
    host: "equin.localhost:9000",
    route: "/agents",
    focusedAppId: "agents",
    visible: true,
    jsHeapUsedMb: 100,
    jsHeapTotalMb: 200,
    domNodes: 1000,
    canvases: 0,
    canvasMb: 0,
    imagesMb: 0,
    iframes: 0,
    media: 0,
    inAppTabs: [],
    ...over,
  };
}

describe("pagesFrom", () => {
  it("makes one page per document load, newest seen first, points in time order", () => {
    const pages = pagesFrom([
      {
        worktree: "main",
        samples: [
          sample({ sampledAt: 10 * MIN, jsHeapUsedMb: 150 }),
          sample({ sampledAt: 5 * MIN }),
          // Same browser tab, reloaded: a new heap, a new page.
          sample({ sampledAt: 20 * MIN, pageStartedAt: 15 * MIN }),
        ],
      },
      { worktree: "wt", samples: [sample({ sampledAt: 1 * MIN })] },
    ]);
    expect(pages.map((p) => p.pageId)).toEqual([
      `main:tab-a:${15 * MIN}`,
      "main:tab-a:1",
      "wt:tab-a:1",
    ]);
    const first = pages[1]!;
    expect(first.points.map((p) => p.t)).toEqual([5 * MIN, 10 * MIN]);
    expect(first.first.sampledAt).toBe(5 * MIN);
    expect(first.latest.jsHeapUsedMb).toBe(150);
  });
});

describe("jsHeapGrowthMbPerHour", () => {
  it("is the first-to-last heap change per hour, null over a short span", () => {
    const [page] = pagesFrom([
      {
        worktree: "main",
        samples: [
          sample({ sampledAt: 0, jsHeapUsedMb: 100 }),
          sample({ sampledAt: 120 * MIN, jsHeapUsedMb: 300 }),
        ],
      },
    ]);
    expect(jsHeapGrowthMbPerHour(page!)).toBe(100);
    const [short] = pagesFrom([
      {
        worktree: "main",
        samples: [sample({ sampledAt: 0 }), sample({ sampledAt: 10 * MIN })],
      },
    ]);
    expect(jsHeapGrowthMbPerHour(short!)).toBeNull();
  });
});

describe("renderersFrom", () => {
  const owner = (sampledAt: number, top: OwnerSample["top"]): OwnerSample => ({
    sampledAt,
    cores: 8,
    owners: [],
    top,
  });
  const renderer = "Google Chrome Helper (Renderer)";

  it("keeps the user's Chrome renderers with a pid, one series each, max per bucket", () => {
    const series = renderersFrom([
      owner(0, [
        { bucket: "chrome", name: renderer, pid: 7, memMb: 3000 },
        { bucket: "chrome", name: renderer, pid: 8, memMb: 500 },
        // Before pids were recorded, or not a renderer, or the agent browser's.
        { bucket: "chrome", name: renderer, memMb: 9000 },
        { bucket: "chrome", name: "Google Chrome", pid: 1, memMb: 800 },
        {
          bucket: "agent-browser",
          name: "Chromium Helper (Renderer)",
          pid: 2,
          memMb: 900,
        },
      ]),
      owner(30_000, [
        { bucket: "chrome", name: renderer, pid: 7, memMb: 3100 },
      ]),
      owner(10 * MIN, [
        { bucket: "chrome", name: renderer, pid: 7, memMb: 4000 },
      ]),
    ]);
    expect(series.map((s) => s.pid)).toEqual([7, 8]);
    expect(series[0]!.peakMb).toBe(4000);
    expect(series[0]!.points.map((p) => p.memMb)).toEqual([3100, 4000]);
  });
});
