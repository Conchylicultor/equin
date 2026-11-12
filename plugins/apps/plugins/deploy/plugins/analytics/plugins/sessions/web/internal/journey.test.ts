import { describe, expect, it } from "bun:test";
import type {
  Session,
  SessionHit,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { sourceOf } from "./facts";
import { journeyOf, pageRead, readLabel, sectionsByPath } from "./journey";

const T0 = Date.parse("2026-11-10T14:32:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function pv(
  s: number,
  path: string,
  engagedMs = 0,
  sections: string[] | null = null,
): SessionHit {
  return {
    ts: at(s),
    kind: "pageview",
    path,
    eventName: null,
    eventProps: null,
    engagedMs,
    gaps: null,
    load: null,
    sections,
  };
}
function ev(
  s: number,
  path: string,
  name: string,
  props: Record<string, string> | null = null,
): SessionHit {
  return {
    ts: at(s),
    kind: "event",
    path,
    eventName: name,
    eventProps: props,
    engagedMs: 0,
    gaps: null,
    load: null,
    sections: null,
  };
}
const reach = (s: number, path: string, section: string) =>
  ev(s, path, "section_reach", { section });

function session(hits: SessionHit[], durationMs: number): Session {
  const pageviews = hits.filter((h) => h.kind === "pageview").length;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    visitor: "0a1b2c3d",
    returning: false,
    owner: false,
    day: "2026-11-10",
    startedAt: at(0),
    lastAt: hits.at(-1)!.ts,
    live: false,
    host: "equin.ai",
    entryPath: hits[0]!.path,
    exitPath: hits.filter((h) => h.kind === "pageview").at(-1)!.path,
    exitAt: hits.filter((h) => h.kind === "pageview").at(-1)!.ts,
    exitEngagedMs: 0,
    durationMs,
    engagedMs: durationMs,
    pageviews,
    events: hits.length - pageviews,
    channel: "Referral",
    referrerHost: "news.ycombinator.com",
    referrerPath: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    country: "FR",
    language: "fr",
    device: "Desktop",
    browser: "Chrome",
    os: "macOS",
    pages: [...new Set(hits.map((h) => h.path))].sort(),
    eventNames: [],
    hits,
    hitsTruncated: false,
  };
}

describe("journeyOf", () => {
  const visit = session(
    [
      pv(0, "/"),
      reach(0, "/", "landing/hero"),
      reach(9, "/", "landing/layers"),
      ev(24, "/", "film_play", { film: "promo" }),
      reach(30, "/", "landing/layers"), // a second reach of one section counts once
      pv(96, "/vision"),
      ev(130, "/vision", "improve_show_me"),
      pv(170, "/download", 41_000),
    ],
    211_000,
  );
  const j = journeyOf(visit);

  it("cuts the visit into pages: each until the next pageview, the exit until the visit's end", () => {
    expect(j.pages.map((p) => [p.path, p.startS, p.durationS])).toEqual([
      ["/", 0, 96],
      ["/vision", 96, 74],
      ["/download", 170, 41],
    ]);
    expect(j.durationS).toBe(211);
  });

  it("puts reaches and actions on their page, timed from the page's start", () => {
    expect(j.pages[0]!.reached).toEqual([
      { section: "hero", atS: 0 },
      { section: "layers", atS: 9 },
    ]);
    expect(j.pages[0]!.actions).toEqual([
      { name: "film_play", atS: 24, props: { film: "promo" } },
    ]);
    expect(j.pages[1]!.actions.map((a) => [a.name, a.atS])).toEqual([
      ["improve_show_me", 34],
    ]);
    expect(j.actionCount).toBe(2);
    expect(j.bounced).toBe(false);
  });

  it("a one-page visit is a bounce, whatever it did", () => {
    const one = journeyOf(
      session([pv(0, "/"), ev(3, "/", "improve_open")], 7000),
    );
    expect(one.pages).toHaveLength(1);
    expect(one.pages[0]!.durationS).toBe(7);
    expect(one.bounced).toBe(true);
  });
});

describe("read share", () => {
  const a = journeyOf(
    session(
      [
        pv(0, "/"),
        reach(0, "/", "landing/hero"),
        reach(20, "/", "landing/film"),
      ],
      60_000,
    ),
  );
  const b = journeyOf(
    session(
      [
        pv(0, "/"),
        reach(0, "/", "landing/hero"),
        reach(8, "/", "landing/layers"),
        reach(25, "/", "landing/film"),
      ],
      90_000,
    ),
  );
  const known = sectionsByPath([a, b]);

  it("knows a path's sections from every loaded visit, in reach order", () => {
    expect(known.get("/")).toEqual(["hero", "layers", "film"]);
  });
  it("without a recorded list: reached ÷ estimated, marked estimated", () => {
    const ra = pageRead(a.pages[0]!, known);
    expect(ra.share).toBeCloseTo(2 / 3, 12);
    expect(ra.estimated).toBe(true);
    expect(readLabel(ra)).toBe("~67% read");
    expect(pageRead(b.pages[0]!, known).share).toBe(1);
    expect(pageRead(a.pages[0]!, new Map()).share).toBeNull();
    expect(readLabel(pageRead(a.pages[0]!, new Map()))).toBeNull();
  });
});

describe("a page that recorded its sections", () => {
  const recorded = [
    "landing/hero",
    "landing/layers",
    "landing/film",
    "landing/contact",
    "landing/footer",
  ];
  const j = journeyOf(
    session(
      [
        pv(0, "/", 0, recorded),
        reach(0, "/", "landing/hero"),
        reach(8, "/", "landing/layers"),
        reach(25, "/", "landing/film"),
        reach(30, "/", "landing/contact"),
      ],
      90_000,
    ),
  );
  // Every loaded visit stopped short of the footer: the estimate never sees it.
  const estimates = sectionsByPath([j]);

  it("reads against the page's own list, unreached sections included, in page order", () => {
    const r = pageRead(j.pages[0]!, estimates);
    expect(r.sections).toEqual(["hero", "layers", "film", "contact", "footer"]);
    expect(r.share).toBe(4 / 5);
    expect(r.estimated).toBe(false);
    expect(readLabel(r)).toBe("80% read");
  });
  it("does not trust a list missing a section the visitor reached", () => {
    const odd = journeyOf(
      session(
        [
          pv(0, "/", 0, ["landing/hero"]),
          reach(0, "/", "landing/hero"),
          reach(5, "/", "landing/other"),
        ],
        60_000,
      ),
    );
    const r = pageRead(odd.pages[0]!, sectionsByPath([odd]));
    expect(r.estimated).toBe(true);
    expect(r.sections).toEqual(["hero", "other"]);
  });
});

describe("a truncated visit", () => {
  const v = session(
    [
      pv(0, "/"),
      ev(10, "/", "improve_open"),
      pv(30, "/vision"),
      ev(50, "/vision", "improve_show_me"),
    ],
    600_000,
  );
  const j = journeyOf({ ...v, hitsTruncated: true, exitPath: "/download" });

  it("ends its last shown page at that page's last hit, never at the visit's end", () => {
    expect(j.pages.map((p) => [p.path, p.durationS])).toEqual([
      ["/", 30],
      ["/vision", 20],
    ]);
    expect(j.durationS).toBe(600);
    expect(j.truncated).toBe(true);
  });
});

describe("stretches away", () => {
  const gap = (from: number, to: number, kind: "hidden" | "idle") => ({
    startMs: from * 1000,
    endMs: to * 1000,
    kind,
  });
  const withGaps = (hit: SessionHit, gaps: SessionHit["gaps"]): SessionHit => ({
    ...hit,
    gaps,
  });

  it("puts each page's stretches on it, and active = time on the pages minus every stretch", () => {
    // Exit page: 20 s visible, 30 s in the background between — the box's
    // duration (collect's one definition) already holds both: 100 + 20 + 30.
    const j = journeyOf(
      session(
        [
          withGaps(pv(0, "/"), [gap(10, 40, "idle")]),
          withGaps(pv(100, "/vision", 20_000), [gap(5, 35, "hidden")]),
        ],
        150_000,
      ),
    );
    expect(j.pages[0]!.gaps).toEqual([{ kind: "idle", startS: 10, endS: 40 }]);
    // The visit lasts what the report says; the page is never stretched past it.
    expect(j.pages[1]!.durationS).toBe(50);
    expect(j.durationS).toBe(150);
    expect(j.activeS).toBe(150 - 30 - 30);
  });

  it("clips a stretch to its page, and drops one wholly past it", () => {
    const j = journeyOf(
      session(
        [
          withGaps(pv(0, "/"), [gap(50, 120, "hidden"), gap(130, 140, "idle")]),
          withGaps(pv(100, "/vision", 10_000), []),
        ],
        110_000,
      ),
    );
    expect(j.pages[0]!.gaps).toEqual([
      { kind: "hidden", startS: 50, endS: 100 },
    ]);
    expect(j.activeS).toBe(110 - 50);
  });

  it("recorded with none: active is the whole time", () => {
    const j = journeyOf(session([withGaps(pv(0, "/", 30_000), [])], 30_000));
    expect(j.pages[0]!.gaps).toEqual([]);
    expect(j.activeS).toBe(30);
  });

  it("not recorded on any page: no stretches, no active time — never 0 s away", () => {
    const j = journeyOf(
      session(
        [withGaps(pv(0, "/"), [gap(0, 10, "idle")]), pv(60, "/vision", 5000)],
        65_000,
      ),
    );
    expect(j.pages[1]!.gaps).toBeNull();
    expect(j.activeS).toBeNull();
    expect(j.durationS).toBe(65);
  });

  it("a truncated visit's active time is unknown (its unseen tail may hold stretches)", () => {
    const v = session([withGaps(pv(0, "/"), []), ev(20, "/", "x")], 600_000);
    expect(journeyOf({ ...v, hitsTruncated: true }).activeS).toBeNull();
  });
});

describe("sourceOf", () => {
  const base = session([pv(0, "/")], 1000);
  it("shows the referring page when the referrer sent a path", () => {
    expect(sourceOf({ ...base, referrerPath: "/item" })).toBe(
      "news.ycombinator.com/item",
    );
  });
  it("shows the bare host when the referrer sent only its root", () => {
    expect(sourceOf({ ...base, referrerPath: "/" })).toBe(
      "news.ycombinator.com",
    );
    expect(sourceOf({ ...base, referrerPath: null })).toBe(
      "news.ycombinator.com",
    );
  });
  it("falls back to the campaign source, then Direct", () => {
    expect(
      sourceOf({ ...base, referrerHost: null, utmSource: "newsletter" }),
    ).toBe("newsletter");
    expect(sourceOf({ ...base, referrerHost: null })).toBe("Direct");
  });
});
