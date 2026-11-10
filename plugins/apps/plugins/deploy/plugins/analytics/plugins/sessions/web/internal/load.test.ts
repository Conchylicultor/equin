import { describe, expect, it } from "bun:test";
import type {
  Session,
  SessionHit,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { loadPhases, loadSummary, loadTone, seconds, visitLoad } from "./load";

const hit = (
  kind: SessionHit["kind"],
  load: SessionHit["load"],
): SessionHit => ({
  ts: "2026-11-10T14:32:00.000Z",
  kind,
  path: "/",
  eventName: null,
  eventProps: null,
  engagedMs: 0,
  gaps: null,
  load,
  sections: null,
});
const visit = (hits: SessionHit[]) => ({ hits }) as unknown as Session;

describe("visitLoad", () => {
  it("is the first hard load among the visit's pageviews", () => {
    const first = { ttfbMs: 100, fcpMs: 500, readyMs: 800 };
    const reload = { ttfbMs: 90, fcpMs: 300, readyMs: 400 };
    expect(
      visitLoad(
        visit([
          hit("pageview", null),
          hit("pageview", first),
          hit("pageview", reload),
        ]),
      ),
    ).toBe(first);
  });
  it("skips a load that measured nothing", () => {
    const later = { ttfbMs: 90, fcpMs: null, readyMs: null };
    const none = { ttfbMs: null, fcpMs: null, readyMs: null };
    expect(
      visitLoad(visit([hit("pageview", none), hit("pageview", later)])),
    ).toBe(later);
  });
  it("is null when none was recorded", () => {
    expect(
      visitLoad(visit([hit("pageview", null), hit("event", null)])),
    ).toBeNull();
  });
});

describe("loadTone", () => {
  it("green under 1.5 s, amber under 3 s, red past it", () => {
    expect(loadTone(1499)).toBe("ok");
    expect(loadTone(1500)).toBe("warn");
    expect(loadTone(2999)).toBe("warn");
    expect(loadTone(3000)).toBe("bad");
  });
});

describe("loadPhases", () => {
  it("splits the load into server → first paint → ready", () => {
    expect(loadPhases({ ttfbMs: 140, fcpMs: 620, readyMs: 910 })).toEqual([
      { key: "server", endMs: 140, startMs: 0, spanMs: 140 },
      { key: "paint", endMs: 620, startMs: 140, spanMs: 480 },
      { key: "ready", endMs: 910, startMs: 620, spanMs: 290 },
    ]);
  });
  it("keeps only the measured phases — a background-tab load is its server time alone", () => {
    expect(loadPhases({ ttfbMs: 140, fcpMs: null, readyMs: null })).toEqual([
      { key: "server", endMs: 140, startMs: 0, spanMs: 140 },
    ]);
    expect(loadPhases({ ttfbMs: null, fcpMs: null, readyMs: null })).toEqual(
      [],
    );
  });
  it("never draws a negative span", () => {
    expect(
      loadPhases({ ttfbMs: 700, fcpMs: 600, readyMs: 900 }).map(
        (p) => p.spanMs,
      ),
    ).toEqual([700, 0, 200]);
  });
});

describe("words", () => {
  it("names each measured phase", () => {
    expect(loadSummary({ ttfbMs: 140, fcpMs: 620, readyMs: 910 })).toBe(
      "Server 140 ms · first paint 0.62 s · ready 0.91 s",
    );
    expect(loadSummary({ ttfbMs: null, fcpMs: null, readyMs: 2400 })).toBe(
      "Ready 2.40 s",
    );
    expect(seconds(910, 1)).toBe("0.9 s");
  });
});
