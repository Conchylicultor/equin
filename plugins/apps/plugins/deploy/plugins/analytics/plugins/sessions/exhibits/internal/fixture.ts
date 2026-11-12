import type {
  Gap,
  Session,
  SessionHit,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

/**
 * Made-up visits of the equin website — the prototype's own
 * (proto-1794248902-aof7vs), so the exhibit and the mock compare. Each page:
 * path, seconds on it, sections reached `[key, at]`, actions `[name, at, props]`,
 * and its stretches away `[from, to, kind]` (page seconds); each visit its
 * first load `[server, first paint, ready]` ms. A visit without stretches or
 * load is one recorded before the tracker measured them; one with
 * `sectionsUnrecorded` predates the pages' section lists (its read % is
 * estimated).
 */
type Page = [
  path: string,
  seconds: number,
  reached: [string, number][],
  actions: [string, number, Record<string, string>?][],
  gaps?: [number, number, Gap["kind"]][],
];
interface Visit {
  minutesAgo: number;
  country: string;
  device: Session["device"];
  browser: Session["browser"];
  os: Session["os"];
  referrer: string | null;
  channel: Session["channel"];
  returning: boolean;
  pages: Page[];
  /** `[ttfb, fcp, ready]`, each ms or null; absent = not recorded. */
  load?: [number | null, number | null, number | null];
  /** Its pages did not record their section lists (an older tracker). */
  sectionsUnrecorded?: true;
}

const PAGE_KEY: Record<string, string> = {
  "/": "landing",
  "/vision": "vision",
  "/foundations": "foundations",
  "/apps": "apps",
  "/download": "download",
  "/contact": "contact",
};

/** Each page's sections in page order — the prototype's site. */
const PAGE_SECTIONS: Record<string, string[]> = {
  "/": ["hero", "layers", "film", "apps", "closing", "footer"],
  "/vision": ["hero", "idea", "ladder", "marketplace", "footer"],
  "/foundations": ["hero", "iceberg", "plugins", "footer"],
  "/apps": ["hero", "gallery", "more", "footer"],
  "/download": ["hero", "install", "requirements", "footer"],
  "/contact": ["hero", "form", "footer"],
};

const VISITS: Visit[] = [
  {
    minutesAgo: 20,
    load: [140, 620, 910],
    country: "FR",
    device: "Desktop",
    browser: "Chrome",
    os: "macOS",
    referrer: "news.ycombinator.com",
    channel: "Referral",
    returning: false,
    pages: [
      [
        "/",
        96,
        [
          ["hero", 0],
          ["layers", 9],
          ["film", 21],
          ["apps", 71],
          ["closing", 88],
        ],
        [
          ["improve_open", 24],
          ["foundations_card_open", 60, { card: "plugins" }],
          ["improve_show_me", 78],
        ],
        [[38, 58, "idle"]],
      ],
      [
        "/vision",
        74,
        [
          ["hero", 0],
          ["idea", 6],
          ["ladder", 28],
          ["marketplace", 61],
        ],
        [["improve_show_me", 34, { step: "compose" }]],
      ],
      [
        "/download",
        41,
        [
          ["hero", 0],
          ["install", 8],
        ],
        [
          ["download_copy_macos", 19],
          ["download_open_claude_code", 38],
        ],
      ],
    ],
  },
  {
    minutesAgo: 32,
    load: [380, 1650, 2900],
    country: "US",
    device: "Mobile",
    browser: "Safari",
    os: "iOS",
    referrer: "x.com",
    channel: "Social",
    returning: false,
    pages: [["/", 7, [["hero", 0]], []]],
  },
  {
    minutesAgo: 54,
    load: [95, 480, 720],
    country: "DE",
    device: "Desktop",
    browser: "Firefox",
    os: "Linux",
    referrer: null,
    channel: "Direct",
    returning: true,
    pages: [
      [
        "/foundations",
        132,
        [
          ["hero", 0],
          ["iceberg", 11],
          ["plugins", 86],
        ],
        [
          ["foundations_card_open", 15, { card: "iceberg" }],
          ["improve_open", 104],
          ["improve_element_picked", 117],
        ],
        [[24, 78, "hidden"]],
      ],
      [
        "/apps",
        48,
        [
          ["hero", 0],
          ["gallery", 7],
          ["more", 36],
        ],
        [["foundations_expand_all", 20]],
      ],
    ],
  },
  {
    minutesAgo: 71,
    load: [610, 1900, 3400],
    country: "JP",
    device: "Desktop",
    browser: "Chrome",
    os: "Windows",
    referrer: "google.com",
    channel: "Search",
    returning: false,
    pages: [
      [
        "/",
        38,
        [
          ["hero", 0],
          ["layers", 12],
          ["film", 30],
        ],
        [],
      ],
      [
        "/apps",
        25,
        [
          ["hero", 0],
          ["gallery", 9],
        ],
        [],
      ],
    ],
  },
  {
    minutesAgo: 145,
    load: [520, 1300, 1900],
    country: "KR",
    device: "Desktop",
    browser: "Chrome",
    os: "macOS",
    referrer: "github.com",
    channel: "Referral",
    returning: true,
    pages: [
      [
        "/foundations",
        1980,
        [
          ["hero", 0],
          ["iceberg", 40],
          ["plugins", 900],
        ],
        [
          ["foundations_card_open", 55],
          ["improve_open", 1200],
          ["improve_element_picked", 1260],
        ],
        [
          [130, 1150, "hidden"],
          [1290, 1700, "idle"],
        ],
      ],
      [
        "/download",
        2460,
        [
          ["hero", 0],
          ["install", 30],
          ["requirements", 1500],
        ],
        [
          ["download_copy_macos", 120],
          ["download_open_claude_app", 2400],
        ],
        [[150, 2360, "hidden"]],
      ],
    ],
  },
  {
    minutesAgo: 1500,
    load: [160, 700, 1050],
    sectionsUnrecorded: true,
    country: "FR",
    device: "Desktop",
    browser: "Chrome",
    os: "macOS",
    referrer: "linkedin.com",
    channel: "Social",
    returning: false,
    pages: [
      [
        "/",
        64,
        [
          ["hero", 0],
          ["layers", 8],
          ["film", 19],
          ["apps", 50],
        ],
        [],
        [[22, 47, "hidden"]],
      ],
      [
        "/vision",
        18,
        [
          ["hero", 0],
          ["idea", 9],
        ],
        [],
      ],
      [
        "/foundations",
        29,
        [
          ["hero", 0],
          ["iceberg", 10],
        ],
        [],
      ],
      [
        "/apps",
        33,
        [
          ["hero", 0],
          ["gallery", 5],
          ["more", 24],
        ],
        [["foundations_card_open", 12, { card: "chord" }]],
      ],
    ],
  },
  {
    minutesAgo: 1700,
    load: [820, 2700, 4600],
    country: "IN",
    device: "Mobile",
    browser: "Chrome",
    os: "Android",
    referrer: "google.com",
    channel: "Search",
    returning: false,
    pages: [["/vision", 12, [["hero", 0]], []]],
  },
];

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The visits as the box would answer them, started relative to `now`. */
export function fixtureSessions(now: number): Session[] {
  return VISITS.map((v, n): Session => {
    const start = now - v.minutesAgo * 60_000;
    const iso = (s: number) => new Date(start + s * 1000).toISOString();
    const hits: SessionHit[] = [];
    let at = 0;
    v.pages.forEach(([path, seconds, reached, actions, gaps = []], i) => {
      const hiddenS = gaps
        .filter(([, , kind]) => kind === "hidden")
        .reduce((a, [from, to]) => a + to - from, 0);
      hits.push({
        ts: iso(at),
        kind: "pageview",
        path,
        eventName: null,
        eventProps: null,
        engagedMs: (seconds - hiddenS) * 1000,
        gaps: gaps.map(([from, to, kind]) => ({
          startMs: from * 1000,
          endMs: to * 1000,
          kind,
        })),
        load:
          i === 0 && v.load
            ? { ttfbMs: v.load[0], fcpMs: v.load[1], readyMs: v.load[2] }
            : null,
        sections: v.sectionsUnrecorded
          ? null
          : PAGE_SECTIONS[path]!.map((key) => `${PAGE_KEY[path]}/${key}`),
      });
      const events: [number, SessionHit][] = [
        ...reached.map(([key, t]): [number, SessionHit] => [
          t,
          {
            ts: iso(at + t),
            kind: "event",
            path,
            eventName: "section_reach",
            eventProps: { section: `${PAGE_KEY[path]}/${key}` },
            engagedMs: 0,
            gaps: null,
            load: null,
            sections: null,
          },
        ]),
        ...actions.map(([name, t, props]): [number, SessionHit] => [
          t,
          {
            ts: iso(at + t),
            kind: "event",
            path,
            eventName: name,
            eventProps: props ?? null,
            engagedMs: 0,
            gaps: null,
            load: null,
            sections: null,
          },
        ]),
      ];
      hits.push(...events.sort((a, b) => a[0] - b[0]).map(([, h]) => h));
      at += seconds;
    });
    const last = v.pages.at(-1)!;
    const exitAt = iso(at - last[1]);
    // The exit page's visible time; with its background stretches, what the
    // report's duration counts of it — so the visit lasts its whole wall-clock.
    const exitEngagedMs = hits.findLast(
      (h) => h.kind === "pageview",
    )!.engagedMs;
    const pageviews = v.pages.length;
    return {
      id: uuid(n + 1),
      visitor: (0x1a2b3c4d + n * 7919).toString(16).slice(-8).padStart(8, "0"),
      returning: v.returning,
      owner: false,
      day: iso(0).slice(0, 10),
      startedAt: iso(0),
      lastAt: iso(at),
      live: v.minutesAgo < 30,
      host: "equin.ai",
      entryPath: v.pages[0]![0],
      exitPath: last[0],
      exitAt,
      exitEngagedMs,
      durationMs: at * 1000,
      engagedMs: at * 1000,
      pageviews,
      events: hits.length - pageviews,
      channel: v.channel,
      referrerHost: v.referrer,
      referrerPath: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      country: v.country,
      language: null,
      device: v.device,
      browser: v.browser,
      os: v.os,
      pages: [...new Set(hits.map((h) => h.path))].sort(),
      eventNames: [
        ...new Set(hits.flatMap((h) => (h.eventName ? [h.eventName] : []))),
      ].sort(),
      hits,
      hitsTruncated: false,
    };
  });
}
