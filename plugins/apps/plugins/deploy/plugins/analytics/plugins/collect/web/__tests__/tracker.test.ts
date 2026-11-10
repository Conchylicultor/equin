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
import { createTracker, type TrackerDeps } from "../internal/tracker";

const PV_A = "00000000-0000-4000-8000-00000000000a";
const PV_B = "00000000-0000-4000-8000-00000000000b";

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
    h.tracker.pathChanged("/website");
    h.tracker.pathChanged("/website?x=1");
    h.tracker.pathChanged("/website");
    h.tracker.pathChanged("/website/story");
    expect(h.sent.filter((b) => b.kind === "pageview")).toEqual([
      { kind: "pageview", host: "equin.dev", path: "/website" },
      { kind: "pageview", host: "equin.dev", path: "/website/story" },
    ]);
  });

  it("sends the landing source with the first pageview only", () => {
    const landing = {
      referrer: "https://news.ycombinator.com/item?id=1",
      utm: { source: "hn" },
    };
    const h = harness({ landing });
    h.tracker.pathChanged("/website");
    h.tracker.pathChanged("/website/story");
    expect(h.sent[0]).toEqual({
      kind: "pageview",
      host: "equin.dev",
      path: "/website",
      ...landing,
    });
    expect(h.sent[1]).toEqual({
      kind: "pageview",
      host: "equin.dev",
      path: "/website/story",
    });
  });
});

describe("engagement", () => {
  it("reports cumulative visible time on hide, excluding hidden stretches", async () => {
    const h = harness();
    h.tracker.pathChanged("/website");
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
      { kind: "engagement", pageviewId: PV_A, engagedMs: 1000, gaps: [] },
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
    h.tracker.pathChanged("/website");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(700);
    h.tracker.hidden();
    h.tracker.hidden();
    expect(h.sent.filter((b) => b.kind === "engagement")).toHaveLength(1);
  });

  it("reports the previous page's time when the path changes", async () => {
    const h = harness();
    h.tracker.pathChanged("/website");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(2000);
    h.tracker.pathChanged("/website/story");
    expect(h.sent.slice(1)).toEqual([
      { kind: "engagement", pageviewId: PV_A, engagedMs: 2000, gaps: [] },
      { kind: "pageview", host: "equin.dev", path: "/website/story" },
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
    h.tracker.pathChanged("/website");
    h.advance(400);
    h.tracker.hidden();
    expect(h.sent).toHaveLength(1);
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    expect(h.sent[1]).toEqual({
      kind: "engagement",
      pageviewId: PV_A,
      engagedMs: 400,
      gaps: [],
    });
  });

  it("sends no engagement for an ignored pageview", async () => {
    const h = harness();
    h.tracker.pathChanged("/website");
    h.advance(400);
    h.tracker.hidden();
    await h.respond(0, { outcome: "ignored", reason: "bot" });
    expect(h.sent).toHaveLength(1);
  });

  it("does not count time while the page started hidden, but reports it as away", async () => {
    const h = harness();
    h.setVisible(false);
    h.tracker.pathChanged("/website");
    await h.respond(0, { outcome: "pageview", pageviewId: PV_A });
    h.advance(10_000);
    h.tracker.hidden();
    expect(h.sent.slice(1)).toEqual([
      {
        kind: "engagement",
        pageviewId: PV_A,
        engagedMs: 0,
        gaps: [{ kind: "hidden", startMs: 0, endMs: 10_000 }],
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
    h.tracker.pathChanged("/website");
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
    h.tracker.pathChanged("/website/story");
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

describe("events", () => {
  it("attributes an event to the tracked page, else the fallback path", () => {
    const h = harness();
    h.tracker.track("improve_open", undefined, "/website?q=1");
    h.tracker.pathChanged("/website/story");
    h.tracker.track("improve_show_me", { step: "1" }, "/ignored");
    expect(h.sent.filter((b) => b.kind === "event")).toEqual([
      {
        kind: "event",
        host: "equin.dev",
        path: "/website",
        name: "improve_open",
      },
      {
        kind: "event",
        host: "equin.dev",
        path: "/website/story",
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
    expect(isWithinApp("/website", "/website")).toBe(true);
    expect(isWithinApp("/website/story", "/website")).toBe(true);
    expect(isWithinApp("/websites", "/website")).toBe(false);
    expect(isWithinApp("/agents", "/website")).toBe(false);
  });
});
