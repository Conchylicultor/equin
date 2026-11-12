import type {
  DeployFixture,
  SiteMessageFixture,
  VisitFixture,
} from "@plugins/apps/plugins/deploy/plugins/fixtures/core";

// The film's Deploy state: one small server serving the public website, and a
// fortnight of updates to it, one of which failed and was fixed the next day.
// The address is in TEST-NET-3 (RFC 5737), which routes nowhere. The writer
// gives the server a real key (as Generate key does), stored under its id.
//
// The server's box is THIS instance (`box: "this-instance"`), so the Overview
// cards read the traffic and messages written below instead of reaching for
// SSH. Its runs are real commits of this repository (resolved at seed time
// from main), the running one a good way behind main so the page offers a
// deploy; the visits are generated from a fixed seed, so a reseed paints the
// same page.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;
const SEC = 1_000;

/** Commits the seed reads from main: enough for the oldest run below. */
export const FILM_MAIN_COMMITS_NEEDED = 400;

const HOSTNAME = "piano-notes.example.com";

// ── traffic ──────────────────────────────────────────────────────────────

/** mulberry32: a small seeded PRNG, so a reseed paints the same traffic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Weighted<T> = readonly (readonly [T, number])[];

const LANDING_PAGES: Weighted<string> = [
  ["/", 55],
  ["/apps", 15],
  ["/vision", 10],
  ["/download", 8],
  ["/story", 6],
  ["/guide", 6],
];
const NEXT_PAGES: Weighted<string> = [
  ["/apps", 28],
  ["/vision", 20],
  ["/download", 20],
  ["/foundations", 12],
  ["/story", 10],
  ["/guide", 10],
];
const REFERRERS: Weighted<string | undefined> = [
  [undefined, 30],
  ["https://www.google.com/", 30],
  ["https://news.ycombinator.com/", 12],
  ["https://github.com/", 12],
  ["https://www.reddit.com/r/selfhosted/", 9],
  ["https://t.co/", 7],
];
const COUNTRIES: Weighted<string> = [
  ["US", 28],
  ["FR", 18],
  ["DE", 14],
  ["GB", 11],
  ["NO", 6],
  ["JP", 7],
  ["CA", 6],
  ["NL", 5],
  ["BR", 5],
];

function pick<T>(rand: () => number, table: Weighted<T>): T {
  const total = table.reduce((n, [, w]) => n + w, 0);
  let at = rand() * total;
  for (const [value, w] of table) {
    at -= w;
    if (at < 0) return value;
  }
  return table[table.length - 1]![0];
}

function visitOf(
  rand: () => number,
  visitor: string,
  startedAgoMs: number,
  country: string,
): VisitFixture {
  const pageCount = 1 + Math.floor(rand() * rand() * 4.5);
  const pages: { path: string; engagedMs: number }[] = [];
  for (let i = 0; i < pageCount; i++) {
    const path = pick(rand, i === 0 ? LANDING_PAGES : NEXT_PAGES);
    if (pages.some((p) => p.path === path)) continue;
    // 10 s to 4 min, skewed short.
    const engagedMs =
      Math.round((10 * SEC + rand() * rand() * 230 * SEC) / SEC) * SEC;
    pages.push({ path, engagedMs });
  }
  const referrer = pick(rand, REFERRERS);
  return {
    startedAgoMs,
    visitor,
    country,
    ...(referrer !== undefined ? { referrer } : {}),
    pages,
  };
}

/**
 * Sixty days of traffic: about 25 visitors in the earlier thirty, about 60 in
 * the latest thirty (eight of the earlier ones among them, and a few who come
 * back a second time) — growth the chart's previous-period line shows.
 */
function filmVisits(): VisitFixture[] {
  const rand = prng(20261106);
  const visits: VisitFixture[] = [];
  const countryOf = new Map<string, string>();
  const country = (visitor: string) => {
    let c = countryOf.get(visitor);
    if (c === undefined) {
      c = pick(rand, COUNTRIES);
      countryOf.set(visitor, c);
    }
    return c;
  };
  // A moment in a window, a day-time bias towards the afternoon.
  const within = (fromDays: number, toDays: number) =>
    Math.round(
      (fromDays + rand() * (toDays - fromDays)) * DAY - rand() * 8 * HOUR,
    );
  const earlier: string[] = [];
  for (let i = 0; i < 25; i++) {
    const visitor = `earlier-${i}`;
    earlier.push(visitor);
    visits.push(visitOf(rand, visitor, within(30.2, 59.8), country(visitor)));
  }
  for (let i = 0; i < 52; i++) {
    const visitor = `recent-${i}`;
    visits.push(visitOf(rand, visitor, within(0.1, 29.8), country(visitor)));
  }
  for (const visitor of earlier.slice(0, 8))
    visits.push(visitOf(rand, visitor, within(0.1, 29.8), country(visitor)));
  // A few come back a second time, days later.
  for (let i = 0; i < 6; i++) {
    const visitor = `recent-${i * 7}`;
    const first = visits.find((v) => v.visitor === visitor)!;
    const back = first.startedAgoMs - (3 + Math.floor(rand() * 5)) * DAY;
    if (back > HOUR)
      visits.push(visitOf(rand, visitor, back, country(visitor)));
  }
  return visits;
}

const FILM_MESSAGES: SiteMessageFixture[] = [
  {
    agoMs: 2 * DAY + 3 * HOUR,
    from: "marta.lindqvist@example.com",
    message:
      "Hi! Does the Download page work on Linux too? I would like to try it on my old ThinkPad before I commit to a Mac.",
    page: "/download",
  },
  {
    agoMs: 5 * DAY + 9 * HOUR,
    from: "kenji.arai@example.org",
    message:
      "Thank you for the piano trainer, my daughter practises chords with it every evening now. Would love a way to slow a loop down.",
    page: "/apps",
  },
  {
    agoMs: 9 * DAY + 5 * HOUR,
    from: "jo.bellamy@example.net",
    message:
      "Idea: let me pin the apps I use most to the top of the home screen. Great site by the way.",
    page: "/",
  },
];

// ── the fixture ──────────────────────────────────────────────────────────

/**
 * The film's Deploy state over main's newest commits (newest first, at least
 * 120 of them: the oldest run sits 110 commits back).
 */
export function filmDeploy(mainCommits: readonly string[]): DeployFixture {
  const at = (behind: number): string => {
    const sha = mainCommits[behind];
    if (sha === undefined)
      throw new Error(
        `[promo-film seed] main has only ${mainCommits.length} commits; the film's deploy history needs ${behind + 1}`,
      );
    return sha;
  };
  return {
    servers: [
      {
        id: "srv-1792800000-film01",
        name: "web-1",
        host: "203.0.113.24",
        box: "this-instance",
        health: { platform: "linux-x64", checkedAgoMs: 2 * HOUR },
        deployments: [
          {
            compositionId: "website",
            hostnames: [HOSTNAME],
            secrets: { RESEND_API_KEY: "re_film_seeded_not_a_real_key" },
            visits: filmVisits(),
            messages: FILM_MESSAGES,
            runs: [
              {
                verb: "update",
                status: "succeeded",
                startedAgoMs: 3 * HOUR,
                durationMs: 4 * MIN,
                commitSha: at(64),
              },
              {
                verb: "update",
                status: "succeeded",
                startedAgoMs: 2 * DAY,
                durationMs: 5 * MIN,
                commitSha: at(78),
              },
              {
                verb: "update",
                status: "failed",
                phaseFailed: "build",
                exitCode: 1,
                message:
                  "build: type-check failed in the gallery page (1 error)",
                startedAgoMs: 3 * DAY,
                durationMs: 2 * MIN,
                commitSha: at(85),
              },
              {
                verb: "update",
                status: "succeeded",
                startedAgoMs: 7 * DAY,
                durationMs: 5 * MIN,
                commitSha: at(110),
              },
              {
                verb: "converge",
                status: "succeeded",
                startedAgoMs: 14 * DAY,
                durationMs: 9 * MIN,
                commitSha: null,
              },
            ],
          },
        ],
      },
    ],
  };
}
