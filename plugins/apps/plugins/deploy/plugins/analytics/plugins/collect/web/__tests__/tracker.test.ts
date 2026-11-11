import { describe, expect, it } from "vitest";
import {
  IDLE_AFTER_MS,
  MAX_COLLECT_BODY_BYTES,
  type CollectBody,
  type CollectResponse,
} from "../../core";
import { MAX_GAPS } from "../../core/internal/gaps";
import { landingSource } from "../internal/landing";
import { isWithinApp } from "../internal/scope";
import {
  createTracker,
  type LoadMilestones,
  type TrackerDeps,
} from "../internal/tracker";

const PV_A = "00000000-0000-4000-8000-00000000000a";
const PV_B = "00000000-0000-4000-8000-00000000000b";
/** The load of a page whose browser measured nothing: still sent, every phase null. */
const NO_LOAD = { ttfbMs: null, fcpMs: null, readyMs: null };

/** A tracker over a fake clock and a recording send whose responses the test releases. */
function harness(opts: { landing?: TrackerDeps["landing"] } = {}) {
  let clock = 0;
  let visible = true;
  let mediaPlaying = false;
  /** The armed deadline: when it fires, and what it runs. One at a time. */
  let deadline: { at: number; fire: () => void } | null = null;
  let armed = 0;
  const sent: CollectBody[] = [];
  const pending: ((r: CollectResponse) => void)[] = [];
  const sections = new Map<string, string[]>();
  let milestones: LoadMilestones = {
    firstByteAt: null,
    firstContentfulPaintAt: null,
    readyAt: null,
  };
  const tracker = createTracker({
    host: "equin.dev",
    landing: opts.landing ?? {},
    send: (body) => {
      sent.push(body);
      return new Promise((resolve) => pending.push(resolve));
    },
    now: () => clock,
    isVisible: () => visible,
    setDeadline: (delayMs, fire) => {
      if (deadline) throw new Error("a second deadline was armed");
      armed++;
      const mine = { at: clock + delayMs, fire };
      deadline = mine;
      return () => {
        if (deadline === mine) deadline = null;
      };
    },
    isMediaPlaying: () => mediaPlaying,
    loadMilestones: () => milestones,
    pageSections: (path) => sections.get(path) ?? [],
  });
  return {
    tracker,
    sent,
    /** Moves the clock, firing the deadline when its instant is passed (at that instant). */
    advance: (ms: number) => {
      const end = clock + ms;
      while (deadline && deadline.at <= end) {
        const due = deadline;
        deadline = null;
        clock = due.at;
        due.fire();
      }
      clock = end;
    },
    setMediaPlaying: (v: boolean) => {
      mediaPlaying = v;
    },
    armedCount: () => armed,
    setMilestones: (m: LoadMilestones) => {
      milestones = m;
    },
    /** Sets the sections registered on `path` so far. */
    setSections: (path: string, names: string[]) => {
      sections.set(path, names);
    },
    setVisible: (v: boolean) => {
      visible = v;
    },
    /** Answers the `index`-th send, then lets its `.then` run. */
    respond: async (index: number, response: CollectResponse) => {
      const resolve = pending[index];
      if (!resolve) throw new Error(`no send #${index}`);
      resolve(response);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("pageviews", () => {
  it("records one pageview per distinct path, query stripped", () => {
    const h = harness();
    h.tracker.pathChanged("/about");
    h.tracker.pathChanged("/about?x=1");
    h.tracker.pathChanged("/about");
    h.tracker.pathChanged("/about/story");
    expect(h.sent.filter((b) => b.kind === "pageview")).toEqual([
      { kind: "pageview", host: "equin.dev", path: "/about" },
      { kind: "pageview", host: "equin.dev", path: "/about/story" },
    ]);
  });

  it("sends the landing source with the first pageview only", () => {
    const landing = {
      referrer: "https://news.ycombinator.com/item?id=1",
      utm: { source: "hn" },
    };
    const h = harness({ landing });
    h.tracker.pathChanged("/about");
    h.tracker.pathChanged("/about/story");
    expect(h.sent[0]).toEqual({
      kind: "pageview",
      host: "equin.dev",
      path: "/about",
      ...landing,
    });
    expect(h.sent[1]).toEqual({
      kind: "pageview",
      host: "equin.dev",
      path: "/about/story",
    });
  });
});

describe("engagement", () => {
  it("reports cumulative visible time on hide, excluding hidden stretches", async () => {
    const h = harness();
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(1000);
    h.tracker.hidden();
    h.setVisible(false);
    h.advance(50_000);
    h.setVisible(true);
    h.tracker.visible();
    h.advance(500);
    h.tracker.hidden();
    expect(h.sent.slice(1)).toEqual([
      {
        kind: "engagement",
        pageviewId: PV_A,
        engagedMs: 1000,
        gaps: [],
        load: NO_LOAD,
      },
      {
        kind: "engagement",
        pageviewId: PV_A,
        engagedMs: 1500,
        gaps: [{ kind: "hidden", startMs: 1000, endMs: 51_000 }],
      },
    ]);
  });

  it("does not re-send an unchanged total (visibilitychange then pagehide)", async () => {
    const h = harness();
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(700);
    h.tracker.hidden();
    h.tracker.hidden();
    expect(h.sent.filter((b) => b.kind === "engagement")).toHaveLength(1);
  });

  it("reports the previous page's time when the path changes", async () => {
    const h = harness();
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(2000);
    h.tracker.pathChanged("/about/story");
    expect(h.sent.slice(1)).toEqual([
      {
        kind: "engagement",
        pageviewId: PV_A,
        engagedMs: 2000,
        gaps: [],
        load: NO_LOAD,
      },
      { kind: "pageview", host: "equin.dev", path: "/about/story" },
    ]);
    await h.respond(2, { outcome: "pageview", pageviewId: PV_B });
    h.advance(300);
    h.tracker.hidden();
    expect(h.sent[3]).toEqual({
      kind: "engagement",
      pageviewId: PV_B,
      engagedMs: 300,
      gaps: [],
    });
  });

  it("holds an engagement until the pageview id arrives", async () => {
    const h = harness();
    h.tracker.pathChanged("/about");
    h.advance(400);
    h.tracker.hidden();
    expect(h.sent).toHaveLength(1);
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    expect(h.sent[1]).toEqual({
      kind: "engagement",
      pageviewId: PV_A,
      engagedMs: 400,
      gaps: [],
      load: NO_LOAD,
    });
  });

  it("sends no engagement for an ignored pageview", async () => {
    const h = harness();
    h.tracker.pathChanged("/about");
    h.advance(400);
    h.tracker.hidden();
    await h.respond(0, { outcome: "ignored", reason: "bot" });
    expect(h.sent).toHaveLength(1);
  });

  it("does not count time while the page started hidden, but reports it as away", async () => {
    const h = harness();
    h.setVisible(false);
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(10_000);
    h.tracker.hidden();
    expect(h.sent.slice(1)).toEqual([
      {
        kind: "engagement",
        pageviewId: PV_A,
        engagedMs: 0,
        gaps: [{ kind: "hidden", startMs: 0, endMs: 10_000 }],
        load: NO_LOAD,
      },
    ]);
  });
});

/** The gaps of the last engagement sent. */
function lastGaps(sent: CollectBody[]) {
  const last = sent.filter((b) => b.kind === "engagement").at(-1);
  if (!last) throw new Error("no engagement sent");
  return last.gaps;
}

describe("away stretches", () => {
  async function started() {
    const h = harness();
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    return h;
  }

  it("a hidden stretch runs from the hide to the next show", async () => {
    const h = await started();
    h.advance(2_000);
    h.tracker.hidden();
    h.setVisible(false);
    h.advance(3_600_000);
    h.setVisible(true);
    h.tracker.visible();
    h.advance(1_000);
    h.tracker.hidden();
    expect(lastGaps(h.sent)).toEqual([
      { kind: "hidden", startMs: 2_000, endMs: 3_602_000 },
    ]);
  });

  it("a tab closed while in the background reports the stretch up to the close", async () => {
    const h = await started();
    h.advance(1_000);
    h.tracker.hidden(); // visibilitychange
    h.setVisible(false);
    h.advance(600_000);
    h.tracker.hidden(); // pagehide, still in the background
    expect(lastGaps(h.sent)).toEqual([
      { kind: "hidden", startMs: 1_000, endMs: 601_000 },
    ]);
  });

  it("idle starts at the last input once 30 s pass, and ends at the next input", async () => {
    const h = await started();
    h.advance(10_000);
    h.tracker.activity();
    h.advance(IDLE_AFTER_MS + 50_000);
    h.tracker.activity();
    h.advance(1_000);
    h.tracker.hidden();
    expect(lastGaps(h.sent)).toEqual([
      { kind: "idle", startMs: 10_000, endMs: 90_000 },
    ]);
  });

  it("steady input keeps the visitor present, with one timer per idle window", async () => {
    const h = await started();
    for (let i = 0; i < 100; i++) {
      h.advance(1_000);
      h.tracker.activity();
    }
    h.tracker.hidden();
    expect(lastGaps(h.sent)).toEqual([]);
    // Re-armed only when it fired early (every ~30 s), not on each input.
    expect(h.armedCount()).toBeLessThanOrEqual(5);
  });

  it("playing media is not idle; its pause restarts the idle clock", async () => {
    const h = await started();
    h.setMediaPlaying(true);
    h.advance(300_000);
    h.setMediaPlaying(false);
    h.tracker.activity(); // the media's pause event
    h.advance(IDLE_AFTER_MS + 10_000);
    h.tracker.hidden();
    expect(lastGaps(h.sent)).toEqual([
      { kind: "idle", startMs: 300_000, endMs: 340_000 },
    ]);
  });

  it("an idle stretch ends where a hide begins, and idle resumes counting from the show", async () => {
    const h = await started();
    h.advance(IDLE_AFTER_MS + 20_000); // idle from 0
    h.tracker.hidden();
    h.setVisible(false);
    h.advance(100_000);
    h.setVisible(true);
    h.tracker.visible();
    h.advance(IDLE_AFTER_MS + 5_000);
    h.tracker.hidden();
    expect(lastGaps(h.sent)).toEqual([
      { kind: "idle", startMs: 0, endMs: 50_000 },
      { kind: "hidden", startMs: 50_000, endMs: 150_000 },
      { kind: "idle", startMs: 150_000, endMs: 185_000 },
    ]);
  });

  it("drops stretches under 5 s", async () => {
    const h = await started();
    h.advance(1_000);
    h.tracker.hidden();
    h.advance(4_000);
    h.tracker.visible();
    h.advance(1_000);
    h.tracker.hidden();
    // The second hide only adds visible time; the 4 s background stretch is dropped.
    expect(lastGaps(h.sent)).toEqual([]);
  });

  it("a path change closes the old page's stretch and starts the new page's offsets", async () => {
    const h = await started();
    h.advance(IDLE_AFTER_MS + 10_000);
    h.tracker.pathChanged("/about/story");
    expect(lastGaps(h.sent)).toEqual([
      { kind: "idle", startMs: 0, endMs: 40_000 },
    ]);
    await h.respond(2, { outcome: "pageview", pageviewId: PV_B });
    h.advance(2_000);
    h.tracker.hidden();
    h.advance(20_000);
    h.tracker.visible();
    h.tracker.hidden();
    expect(lastGaps(h.sent)).toEqual([
      { kind: "hidden", startMs: 2_000, endMs: 22_000 },
    ]);
  });

  it("caps the list, merging the closest neighbours, and the body stays small", async () => {
    const h = await started();
    for (let i = 0; i < 60; i++) {
      h.advance(1_000 + (i % 7) * 100); // varied active time between stretches
      h.tracker.hidden();
      h.advance(10_000);
      h.tracker.visible();
    }
    h.advance(500);
    h.tracker.hidden();
    const gaps = lastGaps(h.sent) ?? [];
    expect(gaps).toHaveLength(MAX_GAPS);
    for (let i = 1; i < gaps.length; i++)
      expect(gaps[i]!.startMs).toBeGreaterThanOrEqual(gaps[i - 1]!.endMs);
    // Every hidden instant is still inside some stretch: merging only widens.
    expect(gaps[0]!.startMs).toBe(1_000);
    const last = h.sent.at(-1)!;
    expect(new TextEncoder().encode(JSON.stringify(last)).length).toBeLessThan(
      MAX_COLLECT_BODY_BYTES,
    );
  });
});

describe("load timing", () => {
  const MILESTONES: LoadMilestones = {
    firstByteAt: 107.1,
    firstContentfulPaintAt: 1640.2,
    readyAt: 1700,
  };
  const engagements = (sent: CollectBody[]) =>
    sent.filter((b) => b.kind === "engagement");

  it("rides the first beacon of the page load's first pageview, once", async () => {
    const h = harness();
    h.setMilestones(MILESTONES);
    h.advance(2000);
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(1000);
    h.tracker.hidden();
    h.setVisible(false);
    h.advance(1000);
    h.setVisible(true);
    h.tracker.visible();
    h.advance(1000);
    h.tracker.pathChanged("/about/story");
    await h.respond(3, { outcome: "pageview", pageviewId: PV_B });
    h.advance(1000);
    h.tracker.hidden();
    const sent = engagements(h.sent);
    expect(sent).toHaveLength(3);
    // Whole ms, rounded up: a phase is never 0.
    expect(sent[0]).toMatchObject({
      pageviewId: PV_A,
      load: { ttfbMs: 108, fcpMs: 1641, readyMs: 1700 },
    });
    expect(sent[1]).not.toHaveProperty("load");
    // An in-app navigation has no load of its own.
    expect(sent[2]).toMatchObject({ pageviewId: PV_B });
    expect(sent[2]).not.toHaveProperty("load");
  });

  it("is sent even when nothing else changed (left at once, no visible time)", async () => {
    const h = harness();
    h.setMilestones(MILESTONES);
    h.advance(2000);
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.tracker.hidden();
    expect(engagements(h.sent)).toEqual([
      {
        kind: "engagement",
        pageviewId: PV_A,
        engagedMs: 0,
        gaps: [],
        load: { ttfbMs: 108, fcpMs: 1641, readyMs: 1700 },
      },
    ]);
  });

  it("waits with the beacon for the pageview id, then reads the load", async () => {
    const h = harness();
    h.tracker.pathChanged("/about");
    h.tracker.hidden();
    // Paint lands while the pageview's response is in flight.
    h.setMilestones({ ...MILESTONES, firstContentfulPaintAt: null });
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    expect(engagements(h.sent)[0]).toMatchObject({
      load: { ttfbMs: 108, fcpMs: null, readyMs: null },
    });
  });

  it("a page loaded in a background tab keeps its first byte, not its paint", async () => {
    const h = harness();
    h.setVisible(false);
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(60_000);
    // Shown a minute later: that is when it painted.
    h.setMilestones({
      firstByteAt: 90,
      firstContentfulPaintAt: 60_050,
      readyAt: 60_100,
    });
    h.setVisible(true);
    h.tracker.visible();
    h.advance(1000);
    h.tracker.hidden();
    expect(engagements(h.sent)[0]).toMatchObject({
      load: { ttfbMs: 90, fcpMs: null, readyMs: null },
    });
  });

  it("a paint after the tab was first hidden is not load time", async () => {
    const h = harness();
    h.advance(500);
    // Hidden before anything was tracked: the hide still counts.
    h.tracker.hidden();
    h.setVisible(false);
    h.advance(10_000);
    h.setVisible(true);
    h.tracker.visible();
    h.setMilestones({
      firstByteAt: 90,
      firstContentfulPaintAt: 300,
      readyAt: 10_600,
    });
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.tracker.hidden();
    expect(engagements(h.sent)[0]).toMatchObject({
      load: { ttfbMs: 90, fcpMs: 300, readyMs: null },
    });
  });

  it("an unmeasured or implausible phase is null, never 0", async () => {
    const h = harness();
    h.setMilestones({
      firstByteAt: 0,
      firstContentfulPaintAt: 11 * 60 * 1000,
      readyAt: null,
    });
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.tracker.hidden();
    expect(engagements(h.sent)[0]).toMatchObject({ load: NO_LOAD });
  });
});

describe("events", () => {
  it("attributes an event to the tracked page, else the fallback path", () => {
    const h = harness();
    h.tracker.track("improve_open", undefined, "/about?q=1");
    h.tracker.pathChanged("/about/story");
    h.tracker.track("improve_show_me", { step: "1" }, "/ignored");
    expect(h.sent.filter((b) => b.kind === "event")).toEqual([
      {
        kind: "event",
        host: "equin.dev",
        path: "/about",
        name: "improve_open",
      },
      {
        kind: "event",
        host: "equin.dev",
        path: "/about/story",
        name: "improve_show_me",
        props: { step: "1" },
      },
    ]);
  });
});

describe("landingSource", () => {
  it("keeps an external referrer and the utm tags", () => {
    expect(
      landingSource({
        referrer: "https://www.google.com/",
        search: "?utm_source=news&utm_campaign=%20launch%20&other=1",
        siteHost: "equin.dev",
      }),
    ).toEqual({
      referrer: "https://www.google.com/",
      utm: { source: "news", campaign: "launch" },
    });
  });

  it("drops a same-site, empty or unparseable referrer", () => {
    for (const referrer of ["", "https://equin.dev/website", "not a url"]) {
      expect(
        landingSource({ referrer, search: "", siteHost: "equin.dev" }),
      ).toEqual({});
    }
  });
});

describe("isWithinApp", () => {
  it("matches the base path and its sub-paths only", () => {
    expect(isWithinApp("/about", "/about")).toBe(true);
    expect(isWithinApp("/about/story", "/about")).toBe(true);
    expect(isWithinApp("/websites", "/about")).toBe(false);
    expect(isWithinApp("/agents", "/about")).toBe(false);
  });
});

describe("page sections", () => {
  const engagements = (sent: CollectBody[]) =>
    sent.filter((b) => b.kind === "engagement");

  it("ride the beacons whenever the list grew, never the pageview", async () => {
    const h = harness();
    h.setSections("/about", ["landing/hero", "landing/layers"]);
    h.tracker.pathChanged("/about");
    expect(h.sent[0]).not.toHaveProperty("sections");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(1000);
    h.tracker.hidden();
    expect(engagements(h.sent)[0]).toMatchObject({
      sections: ["landing/hero", "landing/layers"],
    });
    // Unchanged: a later beacon leaves it out.
    h.tracker.visible();
    h.advance(1000);
    h.tracker.hidden();
    expect(engagements(h.sent)).toHaveLength(2);
    expect(engagements(h.sent)[1]).not.toHaveProperty("sections");
    // A section mounted late: sent again, whole, even with nothing else new.
    h.setSections("/about", [
      "landing/hero",
      "landing/layers",
      "landing/footer",
    ]);
    h.tracker.hidden();
    expect(engagements(h.sent)).toHaveLength(3);
    expect(engagements(h.sent)[2]).toMatchObject({
      sections: ["landing/hero", "landing/layers", "landing/footer"],
    });
  });

  it("are the left page's own on the beacon sent when leaving it", async () => {
    const h = harness();
    h.setSections("/about", ["landing/hero"]);
    h.setSections("/about/vision", ["vision/idea"]);
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(1000);
    h.tracker.pathChanged("/about/vision");
    expect(engagements(h.sent)[0]).toMatchObject({
      pageviewId: PV_A,
      sections: ["landing/hero"],
    });
  });

  it("a revisit is a new pageview that sends the list again", async () => {
    const h = harness();
    h.setSections("/about", ["landing/hero"]);
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(1000);
    h.tracker.pathChanged("/about/vision");
    h.tracker.pathChanged("/about");
    await h.respond(3, { outcome: "pageview", pageviewId: PV_B });
    h.advance(1000);
    h.tracker.hidden();
    expect(engagements(h.sent).at(-1)).toMatchObject({
      pageviewId: PV_B,
      sections: ["landing/hero"],
    });
  });

  it("a page with no sections sends none", async () => {
    const h = harness();
    h.tracker.pathChanged("/about");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(1000);
    h.tracker.hidden();
    expect(engagements(h.sent)[0]).not.toHaveProperty("sections");
  });
});
