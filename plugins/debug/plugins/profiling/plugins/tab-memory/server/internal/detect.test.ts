import { describe, expect, it } from "bun:test";
import type { OwnerSample } from "@plugins/debug/plugins/sentinel/plugins/machine-usage/core";
import type { TabMemorySample } from "../../core";
import { detectClimbs } from "./detect";
import { pagesFrom } from "./reduce";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 100 * HOUR;
const BARS = { highFloorMb: 3000, climbFloorMb: 2500, climbRiseMb: 1000 };
const RENDERER = "Google Chrome Helper (Aperitif Renderer)";

/** One owner sample per 30 s over `hours` up to NOW, the renderer at mb(t). */
function owners(
  hours: number,
  mb: (t: number) => number,
  pid = 42,
  name = RENDERER,
): OwnerSample[] {
  const out: OwnerSample[] = [];
  for (let t = NOW - hours * HOUR; t <= NOW; t += 30_000)
    out.push({
      sampledAt: t,
      cores: 8,
      owners: [],
      top: [{ bucket: "chrome", name, pid, memMb: mb(t) }],
    });
  return out;
}

/** GC sawtooth: rises `amp` MB over 10 min, then drops back. */
const saw = (t: number, amp: number): number =>
  ((t % (10 * MIN)) / (10 * MIN)) * amp;

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

/** A page sampling every 5 min over the last `hours`, its heap at heap(t). */
function page(
  hours: number,
  over: (t: number) => Partial<TabMemorySample>,
  tabId = "tab-a",
): TabMemorySample[] {
  const out: TabMemorySample[] = [];
  for (let t = NOW - hours * HOUR; t <= NOW; t += 5 * MIN)
    out.push(sample({ sampledAt: t, tabId, ...over(t) }));
  return out;
}

describe("detectClimbs", () => {
  it("stays silent on a normal level with a wide GC sawtooth", () => {
    const climbs = detectClimbs(
      owners(6, (t) => 1200 + saw(t, 1500)),
      [],
      NOW,
      BARS,
    );
    expect(climbs).toEqual([]);
  });

  it("stays silent on a climb that has not reached the bar yet", () => {
    // 600 → 2000 MB over 3 h: rising, but the floor is under 2.5 GB.
    const climbs = detectClimbs(
      owners(3, (t) => 600 + ((t - (NOW - 3 * HOUR)) / HOUR) * 470),
      [],
      NOW,
      BARS,
    );
    expect(climbs).toEqual([]);
  });

  it("names a climbing renderer through its sawtooth, with its rate", () => {
    // The 2026-11-10 shape: ~1.4 GB/h from 1 GB, ±600 MB sawtooth on top.
    const start = NOW - 3 * HOUR;
    const climbs = detectClimbs(
      owners(3, (t) => 1000 + ((t - start) / HOUR) * 1400 + saw(t, 600)),
      [],
      NOW,
      BARS,
    );
    expect(climbs).toHaveLength(1);
    const c = climbs[0]!;
    expect(c.pid).toBe(42);
    expect(c.trigger).toBe("climbing");
    expect(c.floorNowMb).toBeGreaterThan(4000);
    expect(c.riseMb!).toBeGreaterThan(3000);
    expect(c.riseMbPerHour!).toBeGreaterThan(1000);
    expect(c.growth).toBe("unattributed");
    expect(c.curve.length).toBeGreaterThan(5);
  });

  it("names a renderer sitting high without climbing", () => {
    const climbs = detectClimbs(
      owners(6, () => 3300),
      [],
      NOW,
      BARS,
    );
    expect(climbs.map((c) => c.trigger)).toEqual(["high"]);
    expect(climbs[0]!.riseMb).toBe(0);
  });

  it("ignores the user's Chrome's other processes and the agent browser", () => {
    const big = (t: number) => 5000 + t * 0;
    const climbs = detectClimbs(
      [
        ...owners(3, big, 1, "Google Chrome Helper (GPU)"),
        ...owners(3, big, 2, "Google Chrome"),
      ],
      [],
      NOW,
      BARS,
    );
    expect(climbs).toEqual([]);
  });

  it("joins the pages by time and says the JS heap grew", () => {
    const start = NOW - 3 * HOUR;
    const pages = pagesFrom([
      {
        worktree: "main",
        samples: [
          // The leaking page: its heap climbs with the renderer.
          ...page(3, (t) => ({
            jsHeapUsedMb: 200 + ((t - start) / HOUR) * 900,
            route: "/sonata",
            focusedAppId: "sonata",
            inAppTabs: [
              { set: "page", appId: "sonata", path: "/sonata", focused: true },
            ],
          })),
          // A quiet page in the same window.
          ...page(3, () => ({ jsHeapUsedMb: 150 }), "tab-b"),
          // A page closed long before the window: not a candidate.
          sample({ sampledAt: NOW - 8 * HOUR, tabId: "tab-c" }),
        ],
      },
    ]);
    const climbs = detectClimbs(
      owners(3, (t) => 1000 + ((t - start) / HOUR) * 1200),
      pages,
      NOW,
      BARS,
    );
    const c = climbs[0]!;
    expect(c.growth).toBe("js-heap");
    expect(c.pages.map((p) => p.route)).toEqual(["/sonata", "/agents"]);
    expect(c.pages[0]!.alive).toBe(true);
    expect(c.pages[0]!.inAppTabs[0]!.appId).toBe("sonata");
  });

  it("calls it native when the pages' own figures stay flat", () => {
    const start = NOW - 3 * HOUR;
    const pages = pagesFrom([
      { worktree: "main", samples: page(3, () => ({})) },
    ]);
    const climbs = detectClimbs(
      owners(3, (t) => 1000 + ((t - start) / HOUR) * 1200),
      pages,
      NOW,
      BARS,
    );
    expect(climbs[0]!.growth).toBe("native");
  });

  it("says canvas / images when they grew", () => {
    const start = NOW - 3 * HOUR;
    const pages = pagesFrom([
      {
        worktree: "main",
        samples: page(3, (t) => ({
          canvasMb: ((t - start) / HOUR) * 500,
        })),
      },
    ]);
    const climbs = detectClimbs(
      owners(3, (t) => 1000 + ((t - start) / HOUR) * 1200),
      pages,
      NOW,
      BARS,
    );
    expect(climbs[0]!.growth).toBe("canvas-images");
  });

  it("bounds a renderer named only at its peaks by the sample's smallest named process", () => {
    // Swings 1200 → 3400 MB; named only above 3000 MB (it falls out of the top
    // list below that, where the smallest named process is 2000 MB).
    const swing = (t: number) => 1200 + saw(t, 2200);
    const samples = owners(3, swing).map((s) => {
      const r = s.top[0]!;
      const others = Array.from({ length: 6 }, (_, i) => ({
        bucket: "agent-ops" as const,
        name: `bun ${i}`,
        pid: 1000 + i,
        memMb: 2000 + i * 500,
      }));
      return {
        ...s,
        top: r.memMb >= 3000 ? [r, ...others.slice(1)] : others,
      };
    });
    expect(detectClimbs(samples, [], NOW, BARS)).toEqual([]);
  });

  it("classifies over every page before listing six, the explaining one first", () => {
    const start = NOW - 3 * HOUR;
    const samples: TabMemorySample[] = [];
    // Eight open pages whose JS heap grew a little (more than the DOM page's 0).
    for (let i = 0; i < 8; i++)
      samples.push(
        ...page(
          3,
          (t) => ({ jsHeapUsedMb: 100 + ((t - start) / HOUR) * 10 }),
          `quiet-${i}`,
        ),
      );
    // The leak: DOM nodes 2,000 → 40,000, heap flat.
    samples.push(
      ...page(
        3,
        (t) => ({
          route: "/logs",
          domNodes: Math.round(2000 + ((t - start) / (3 * HOUR)) * 38_000),
        }),
        "leaky",
      ),
    );
    const climbs = detectClimbs(
      owners(3, (t) => 1000 + ((t - start) / HOUR) * 1200),
      pagesFrom([{ worktree: "main", samples }]),
      NOW,
      BARS,
    );
    const c = climbs[0]!;
    expect(c.growth).toBe("dom");
    expect(c.pages).toHaveLength(6);
    expect(c.pages[0]!.route).toBe("/logs");
  });

  it("judges a high renderer's growth only on open pages", () => {
    const pages = pagesFrom([
      {
        worktree: "main",
        samples: [
          // Closed 2 h ago with a big heap.
          ...page(1, () => ({ jsHeapUsedMb: 2000 }), "closed").map((s) => ({
            ...s,
            sampledAt: s.sampledAt - 2 * HOUR,
          })),
          ...page(6, () => ({}), "open"),
        ],
      },
    ]);
    const climbs = detectClimbs(
      owners(6, () => 3300),
      pages,
      NOW,
      BARS,
    );
    expect(climbs[0]!.trigger).toBe("high");
    expect(climbs[0]!.growth).toBe("native");
  });
});
