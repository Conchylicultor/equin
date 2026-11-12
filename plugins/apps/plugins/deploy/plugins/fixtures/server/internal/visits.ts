import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import { db } from "@plugins/database/server";
import { recordCollect } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/server";
import type { VisitFixture } from "../../core";

// Realistic browsers, so the collect path does not take the visitor for a bot.
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
];

/** The fixture visitor's stable fake identity: a documentation-range IP and a browser. */
function identityOf(visitor: string): { ip: string; userAgent: string } {
  const key = `visitor:${visitor}`;
  const net = hash53(key, 1) % 2 === 0 ? "203.0.113" : "198.51.100";
  return {
    ip: `${net}.${1 + (hash53(key, 2) % 253)}`,
    userAgent: USER_AGENTS[hash53(key, 3) % USER_AGENTS.length]!,
  };
}

/**
 * Write visits through collect, exactly as live traffic would: oldest first
 * (a day's salt and a visitor's links exist before a later day uses them), a
 * pageview per page at the visit's start plus the time spent on the pages
 * before it, then that page's engagement beacon.
 */
export async function writeVisits(
  host: string,
  visits: readonly VisitFixture[],
  now: Date,
): Promise<void> {
  const ordered = [...visits].sort((a, b) => b.startedAgoMs - a.startedAgoMs);
  for (const visit of ordered) {
    const identity = identityOf(visit.visitor);
    const userAgent = visit.userAgent ?? identity.userAgent;
    const lookupCountry = () =>
      Promise.resolve(
        visit.country === undefined
          ? ({ kind: "unlisted" } as const)
          : ({ kind: "found", country: visit.country } as const),
      );
    let at = now.getTime() - visit.startedAgoMs;
    for (const [i, page] of visit.pages.entries()) {
      const ctx = {
        ip: identity.ip,
        userAgent,
        acceptLanguage: "en-US,en;q=0.9",
        now: new Date(at),
      };
      const pageview = await recordCollect(
        db,
        {
          kind: "pageview",
          host,
          path: page.path,
          ...(i === 0 && visit.referrer !== undefined
            ? { referrer: visit.referrer }
            : {}),
          ...(i === 0 && visit.utm !== undefined ? { utm: visit.utm } : {}),
        },
        ctx,
        lookupCountry,
      );
      if (pageview.outcome !== "pageview")
        throw new Error(
          `[deploy fixture] a visit's pageview was not recorded (${JSON.stringify(pageview)}) — visitor ${visit.visitor}`,
        );
      at += page.engagedMs;
      const engagement = await recordCollect(
        db,
        {
          kind: "engagement",
          pageviewId: pageview.pageviewId,
          engagedMs: page.engagedMs,
        },
        { ...ctx, now: new Date(at) },
        lookupCountry,
      );
      if (engagement.outcome !== "engagement")
        throw new Error(
          `[deploy fixture] an engagement beacon was not recorded (${JSON.stringify(engagement)})`,
        );
    }
  }
}
