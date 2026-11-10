import {
  SECTION_REACH_EVENT,
  SECTION_REACH_PROP,
  type Session,
  type SessionHit,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

/** A section the visitor reached on a page, `atS` seconds into the page. */
export interface SectionReach {
  /** The section's key as the site names it (`hero`), without its page prefix. */
  section: string;
  atS: number;
}

/** A custom event the visitor fired on a page, `atS` seconds into the page. */
export interface PageAction {
  name: string;
  atS: number;
  props: Readonly<Record<string, string>> | null;
}

/** One pageview of a visit, with what happened on it. */
export interface JourneyPage {
  path: string;
  /** Seconds from the visit's start to this pageview. */
  startS: number;
  /** How long the visit stayed on it: until the next pageview, the exit page until the visit's end. */
  durationS: number;
  /** In reach order; the first reach of each section only. */
  reached: SectionReach[];
  /** In order; section reaches excluded. */
  actions: PageAction[];
}

export interface Journey {
  pages: JourneyPage[];
  durationS: number;
  actionCount: number;
  /** One pageview — collect's bounce (the Bounced shape). */
  bounced: boolean;
  /**
   * The box sent only the visit's first hits (`hitsTruncated`): the pages
   * cover the start of the visit, the last shown one ending at its last hit —
   * the rest of the visit (until `durationS`) is time with no page known.
   */
  truncated: boolean;
}

const ms = (iso: string) => Date.parse(iso);

/** The section a `section_reach` hit names (the key after the page prefix), or `null` for another hit. */
function reachedSection(hit: SessionHit): string | null {
  if (hit.kind !== "event" || hit.eventName !== SECTION_REACH_EVENT)
    return null;
  const full = hit.eventProps?.[SECTION_REACH_PROP];
  if (full === undefined) return null;
  return full.slice(full.lastIndexOf("/") + 1);
}

/**
 * A visit's hits, as its pages. A page lasts until the next pageview's `ts`;
 * the exit page until the visit's end (the report's `durationMs`: exit −
 * start + the exit page's visible time). Events belong to the pageview before
 * them (one before any pageview, to the first).
 */
export function journeyOf(session: Session): Journey {
  const start = ms(session.startedAt);
  const durationS = session.durationMs / 1000;
  const pages: JourneyPage[] = [];
  const pending: SessionHit[] = [];
  for (const hit of session.hits) {
    if (hit.kind === "pageview") {
      pages.push({
        path: hit.path,
        startS: Math.max(0, (ms(hit.ts) - start) / 1000),
        durationS: 0,
        reached: [],
        actions: [],
      });
    }
    if (pages.length === 0) pending.push(hit);
    else attach(pages.at(-1)!, hit);
  }
  if (pages.length === 0) {
    // A visit whose shown hits hold no pageview: its entry path is the page.
    pages.push({
      path: session.entryPath,
      startS: 0,
      durationS: 0,
      reached: [],
      actions: [],
    });
  }
  for (const hit of pending) attach(pages[0]!, hit);
  const lastHitS = session.hits.length
    ? (ms(session.hits.at(-1)!.ts) - start) / 1000
    : 0;
  pages.forEach((page, i) => {
    // The last shown page of a truncated visit is NOT its exit page: it lasts
    // as far as its own hits say, never the rest of the visit.
    const end =
      i + 1 < pages.length
        ? pages[i + 1]!.startS
        : session.hitsTruncated
          ? lastHitS
          : durationS;
    page.durationS = Math.max(0, end - page.startS);
  });
  const actionCount = pages.reduce((n, p) => n + p.actions.length, 0);
  return {
    pages,
    durationS: Math.max(durationS, pages.at(-1)!.startS),
    actionCount,
    bounced: session.pageviews <= 1,
    truncated: session.hitsTruncated,
  };

  function attach(page: JourneyPage, hit: SessionHit): void {
    if (hit.kind === "pageview") return;
    const atS = Math.max(0, (ms(hit.ts) - start) / 1000 - page.startS);
    const section = reachedSection(hit);
    if (section !== null) {
      if (!page.reached.some((r) => r.section === section))
        page.reached.push({ section, atS });
      return;
    }
    page.actions.push({
      name: hit.eventName ?? "event",
      atS,
      props: hit.eventProps,
    });
  }
}

/**
 * The sections each path is known to have, as far as the loaded visits say:
 * every section reached on it in any of them, in the order readers reach them
 * (mean reach offset). The box does not know a page's full section list, so a
 * page's "read %" is reached ÷ this — exact once someone has read it all.
 */
export function sectionsByPath(
  journeys: readonly Journey[],
): ReadonlyMap<string, readonly string[]> {
  const sums = new Map<string, Map<string, { total: number; n: number }>>();
  for (const j of journeys)
    for (const p of j.pages) {
      let byPath = sums.get(p.path);
      if (!byPath) sums.set(p.path, (byPath = new Map()));
      for (const r of p.reached) {
        const acc = byPath.get(r.section) ?? { total: 0, n: 0 };
        acc.total += r.atS;
        acc.n += 1;
        byPath.set(r.section, acc);
      }
    }
  const out = new Map<string, readonly string[]>();
  for (const [path, byPath] of sums)
    out.set(
      path,
      [...byPath.entries()]
        .sort(
          ([a, x], [b, y]) =>
            x.total / x.n - y.total / y.n || a.localeCompare(b),
        )
        .map(([s]) => s),
    );
  return out;
}

/** The share of `known` sections `page` reached, 0..1; `null` when none are known. */
export function readShare(
  page: JourneyPage,
  known: readonly string[] | undefined,
): number | null {
  if (!known || known.length === 0) return null;
  const hit = new Set(page.reached.map((r) => r.section));
  return known.filter((s) => hit.has(s)).length / known.length;
}
