import { describe, expect, it } from "bun:test";
import type { Journey, JourneyPage } from "./journey";
import {
  currentStep,
  frameStateAt,
  recentActions,
  replayScriptOf,
  skipAway,
  viewportAt,
} from "./replay";

const page = (
  over: Partial<JourneyPage> &
    Pick<JourneyPage, "path" | "startS" | "durationS">,
): JourneyPage => ({
  reached: [],
  actions: [],
  gaps: [],
  sections: null,
  viewport: null,
  ...over,
});

const journey: Journey = {
  pages: [
    page({
      path: "/about",
      startS: 0,
      durationS: 60,
      reached: [
        { section: "hero", name: "landing/hero", atS: 0 },
        { section: "layers", name: "landing/layers", atS: 12 },
      ],
      actions: [{ name: "film_play", atS: 20, props: null }],
      gaps: [{ kind: "hidden", startS: 30, endS: 50 }],
      viewport: { w: 390, h: 664 },
    }),
    page({ path: "/about/vision", startS: 60, durationS: 40 }),
  ],
  durationS: 100,
  activeS: 80,
  actionCount: 1,
  bounced: false,
  truncated: false,
};

const LOAD = { ttfbMs: 100, fcpMs: 600, readyMs: 2000 };

describe("replayScriptOf", () => {
  const script = replayScriptOf(journey, LOAD);

  it("puts the recorded load first: the visit starts when the app was ready", () => {
    expect(script.loadS).toBe(2);
    expect(script.totalS).toBe(102);
    expect(script.pages.map((p) => [p.path, p.startS, p.endS])).toEqual([
      ["/about", 2, 62],
      ["/about/vision", 62, 102],
    ]);
  });

  it("lists every step in time order, a page before what happens on it, the end last", () => {
    expect(script.steps.map((s) => [s.kind, s.atS])).toEqual([
      ["page", 2],
      ["section", 2],
      ["section", 14],
      ["action", 22],
      ["away", 32],
      ["page", 62],
      ["end", 102],
    ]);
  });

  it("runs until its last step, even one past the visit's duration", () => {
    const late = replayScriptOf(
      {
        ...journey,
        pages: [
          journey.pages[0]!,
          page({
            path: "/about/vision",
            startS: 60,
            durationS: 40,
            actions: [{ name: "late", atS: 45, props: null }],
          }),
        ],
      },
      LOAD,
    );
    expect(late.totalS).toBe(107);
    expect(late.steps.at(-1)).toMatchObject({ kind: "end", atS: 107 });
  });

  it("falls back to first paint, then no load at all", () => {
    expect(
      replayScriptOf(journey, { ttfbMs: 100, fcpMs: 600, readyMs: null }).loadS,
    ).toBe(0.6);
    expect(replayScriptOf(journey, null).loadS).toBe(0);
  });
});

describe("frameStateAt", () => {
  const script = replayScriptOf(journey, LOAD);

  it("is loading until the recorded ready time, on the first page", () => {
    expect(frameStateAt(script, 1)).toEqual({
      loading: true,
      page: 0,
      section: null,
      away: null,
    });
  });

  it("follows the last section reached, then resets at a new page", () => {
    expect(frameStateAt(script, 20).section).toBe("landing/layers");
    expect(frameStateAt(script, 70)).toMatchObject({
      page: 1,
      section: null,
    });
  });

  it("is away inside a stretch, and skipping lands at its end", () => {
    expect(frameStateAt(script, 40).away?.gap).toBe("hidden");
    expect(frameStateAt(script, 55).away).toBeNull();
    expect(skipAway(script, 40)).toBe(52);
    expect(skipAway(script, 20)).toBe(20);
  });

  it("shows an action for a moment after it fired", () => {
    expect(recentActions(script, 23).map((a) => a.action.name)).toEqual([
      "film_play",
    ]);
    expect(recentActions(script, 30)).toEqual([]);
  });

  it("names the current step", () => {
    expect(currentStep(script, 0)).toBe(-1);
    expect(currentStep(script, 15)).toBe(2);
  });
});

describe("viewportAt", () => {
  const script = replayScriptOf(journey, LOAD);
  it("uses the page's own, else the nearest recorded, else a typical screen", () => {
    expect(viewportAt(script, 0, "Mobile")).toEqual({
      w: 390,
      h: 664,
      estimated: false,
    });
    expect(viewportAt(script, 1, "Mobile")).toEqual({
      w: 390,
      h: 664,
      estimated: false,
    });
    expect(
      viewportAt(
        replayScriptOf({ ...journey, pages: [journey.pages[1]!] }, null),
        0,
        "Desktop",
      ),
    ).toEqual({ w: 1440, h: 900, estimated: true });
  });
});
