import type {
  Session,
  SessionHit,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

/**
 * Made-up visits of the equin website — the prototype's own
 * (proto-1794248902-aof7vs), so the exhibit and the mock compare. Each page:
 * path, seconds on it, sections reached `[key, at]`, actions `[name, at, props]`.
 */
type Page = [
  path: string,
  seconds: number,
  reached: [string, number][],
  actions: [string, number, Record<string, string>?][],
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
}

const PAGE_KEY: Record<string, string> = {
  "/": "landing",
  "/vision": "vision",
  "/foundations": "foundations",
  "/apps": "apps",
  "/download": "download",
  "/contact": "contact",
};

const VISITS: Visit[] = [
  {
    minutesAgo: 20,
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
      ],
    ],
  },
  {
    minutesAgo: 1500,
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
    for (const [path, seconds, reached, actions] of v.pages) {
      hits.push({
        ts: iso(at),
        kind: "pageview",
        path,
        eventName: null,
        eventProps: null,
        engagedMs: seconds * 1000,
        gaps: null,
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
          },
        ]),
      ];
      hits.push(...events.sort((a, b) => a[0] - b[0]).map(([, h]) => h));
      at += seconds;
    }
    const last = v.pages.at(-1)!;
    const exitAt = iso(at - last[1]);
    const pageviews = v.pages.length;
    return {
      id: uuid(n + 1),
      visitor: (0x1a2b3c4d + n * 7919).toString(16).slice(-8).padStart(8, "0"),
      returning: v.returning,
      day: iso(0).slice(0, 10),
      startedAt: iso(0),
      lastAt: iso(at),
      live: v.minutesAgo < 30,
      host: "equin.ai",
      entryPath: v.pages[0]![0],
      exitPath: last[0],
      exitAt,
      exitEngagedMs: last[1] * 1000,
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
      hits,
      hitsTruncated: false,
    };
  });
}
