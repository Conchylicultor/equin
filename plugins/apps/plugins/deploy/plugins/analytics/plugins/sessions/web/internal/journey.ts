import {
  SECTION_REACH_EVENT,
  SECTION_REACH_PROP,
  type Gap,
  type GapKind,
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

/** A stretch nobody was at the page, in seconds from the page's start, inside the page. */
export interface PageGap {
  kind: GapKind;
  startS: number;
  endS: number;
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
  /**
   * When the tab sat in the background or the visitor was idle, in order and
   * clipped to the page. `null` = not recorded (an older tracker) — never
   * "none", which is `[]`.
   */
  gaps: PageGap[] | null;
  /**
   * The page's full section list as the site recorded it, in page order, by
   * key (`hero`). `null` = not recorded (an older tracker, no beacon) — the
   * read is then estimated from other visits (`pageRead`).
   */
  sections: string[] | null;
}

export interface Journey {
  pages: JourneyPage[];
  durationS: number;
  /**
   * Time on the pages minus every background and idle stretch; `null` when
   * that is not known — a page without recorded stretches, or a truncated
   * visit (its unknown tail may hold some).
   */
  activeS: number | null;
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

/** A section's key: its name without the page prefix (`landing/hero` → `hero`). */
function sectionKey(full: string): string {
  return full.slice(full.lastIndexOf("/") + 1);
}

/** The section a `section_reach` hit names (its key), or `null` for another hit. */
function reachedSection(hit: SessionHit): string | null {
  if (hit.kind !== "event" || hit.eventName !== SECTION_REACH_EVENT)
    return null;
  const full = hit.eventProps?.[SECTION_REACH_PROP];
  if (full === undefined) return null;
  return sectionKey(full);
}

/**
 * A visit's hits, as its pages. A page lasts until the next pageview's `ts`;
 * the exit page until the visit's end — the report's `durationMs`, collect's
 * one definition of a visit's duration (its background stretches already in),
 * so a visit lasts as long here as in the report. Events belong to the
 * pageview before them (one before any pageview, to the first).
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
        gaps: hit.gaps === null ? null : hit.gaps.map(gapOf),
        sections: hit.sections === null ? null : hit.sections.map(sectionKey),
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
      gaps: null,
      sections: null,
    });
  }
  for (const hit of pending) attach(pages[0]!, hit);
  const lastHitS = session.hits.length
    ? (ms(session.hits.at(-1)!.ts) - start) / 1000
    : 0;
  pages.forEach((page, i) => {
    // The last shown page of a truncated visit is NOT its exit page: it lasts
    // as far as its own hits say, never the rest of the visit.
    const last = i + 1 === pages.length;
    const end = !last
      ? pages[i + 1]!.startS
      : session.hitsTruncated
        ? lastHitS
        : durationS;
    page.durationS = Math.max(0, end - page.startS);
    if (page.gaps !== null) page.gaps = clipGaps(page.gaps, page.durationS);
  });
  const actionCount = pages.reduce((n, p) => n + p.actions.length, 0);
  const totalS = Math.max(durationS, pages.at(-1)!.startS);
  const known = !session.hitsTruncated && pages.every((p) => p.gaps !== null);
  return {
    pages,
    durationS: totalS,
    activeS: known
      ? Math.max(0, totalS - pages.reduce((a, p) => a + sumS(p.gaps!), 0))
      : null,
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

function gapOf(g: Gap): PageGap {
  return { kind: g.kind, startS: g.startMs / 1000, endS: g.endMs / 1000 };
}

/** The stretches inside a page of `durationS`: clipped to it, those wholly past it dropped. */
function clipGaps(gaps: readonly PageGap[], durationS: number): PageGap[] {
  return gaps
    .map((g) => ({
      ...g,
      startS: Math.min(g.startS, durationS),
      endS: Math.min(g.endS, durationS),
    }))
    .filter((g) => g.endS > g.startS);
}

/** How long `gaps` last in all, in seconds. */
export function sumS(gaps: readonly PageGap[]): number {
  return gaps.reduce((a, g) => a + (g.endS - g.startS), 0);
}

/**
 * The sections each path is ESTIMATED to have, from the loaded visits alone:
 * every section reached on it in any of them, in the order readers reach them
 * (mean reach offset). Only for a page whose own visit did not record its
 * list (`pageRead`): a section nobody reached is missing from it, and it moves
 * as more visits load.
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

/** How far one page was read, and what that is measured against. */
export interface PageRead {
  /** The page's sections in page order: the depth bar's segments. */
  sections: readonly string[];
  /** The share of `sections` reached, 0..1; `null` when no section is known. */
  share: number | null;
  /**
   * `sections` is the estimate from other visits (`sectionsByPath`), not the
   * page's own recorded list: the share may overstate the read and may move
   * as more visits load, so it is shown as estimated.
   */
  estimated: boolean;
}

/**
 * How far `page` was read: against the page's own recorded section list when
 * it has one, else against the estimate from the loaded visits. A recorded
 * list missing a section the visitor reached (a page that changed under its
 * tracker) is not trusted — the estimate is used, marked so, rather than a
 * confident number that does not add up.
 */
export function pageRead(
  page: JourneyPage,
  estimates: ReadonlyMap<string, readonly string[]>,
): PageRead {
  const hit = new Set(page.reached.map((r) => r.section));
  const recorded = page.sections;
  const trusted =
    recorded !== null &&
    recorded.length > 0 &&
    [...hit].every((s) => recorded.includes(s));
  const sections = trusted ? recorded : (estimates.get(page.path) ?? []);
  return {
    sections,
    share:
      sections.length === 0
        ? null
        : sections.filter((s) => hit.has(s)).length / sections.length,
    estimated: !trusted,
  };
}

/** A read share as words: `60% read`, `~60% read` when estimated. */
export function readLabel(read: PageRead): string | null {
  if (read.share === null) return null;
  return `${read.estimated ? "~" : ""}${Math.round(read.share * 100)}% read`;
}
