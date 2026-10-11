// The paged read's plan, as pure data — `useLive`'s paged read
// (`web/internal/use-pages.ts`) feeds it what each page's window read holds
// and where the viewport is, and renders what it assembles; the DB oracle
// drives the same functions. See
// `plugins/network/plugins/live/CLAUDE.md` (*Paged reads*) and
// research/2026-10-09-global-live-key-range-pages-v2.md.
//
// A page is a KEY RANGE read with a limit: `(after, until]` in the order, at
// most `limit` rows. The pages tile the order (each page's `after` is the
// previous one's `until`; exactly the last has `until: null`). One structural
// operation keeps them small — SPLIT a full page at a row's key — and one
// keeps them few — MERGE two small neighbours. Liveness follows the viewport:
// a page near what is on screen is subscribed, one far from it is released
// and keeps showing the rows it last held (stale) — up to a STALE BUDGET of
// rows per reader, past which a released page drops its rows and is drawn as
// one height-keeping placeholder, subscribed again once it is near the
// viewport. Depth is unbounded; what is live is bounded by the viewport, and
// what is held by the viewport plus the budget. A read with NO viewport (a
// reader that cannot say which rows are on screen) keeps every page live
// instead, and is bounded by `maxLimit` rows (see {@link everyPageLive}).

/** One page: `(after, until]` in the order, at most `limit` rows. */
export interface Page {
  /** Exclusive lower cut (a server-minted row key); `null` = the order's start. */
  after: string | null;
  /** Inclusive upper cut; `null` = the order's end (only the last page). */
  until: string | null;
  limit: number;
}

/** A row as the plan reads it: its id and its server-minted row key. */
export interface PageEntry {
  id: string;
  /** `null` = the key is over the byte bound: no page can be cut at this row. */
  key: string | null;
}

/**
 * What one live page's window read says right now. `E` is the reader's error
 * type — the plan only carries it, so a typed error (a live read's
 * `ResourceError`) reaches what it assembles unwidened.
 */
export type PageObservation<R extends PageEntry, E extends Error = Error> =
  /** No value has landed yet. */
  | { kind: "pending" }
  /**
   * A value the server vouched for — the current one, or (with `error`) the
   * last one before its read failed. `appliedSeq` orders it against every
   * other page's value: the higher, the more recently applied.
   */
  | {
      kind: "settled";
      entries: readonly R[];
      error: E | null;
      appliedSeq: number;
    }
  /** The first read failed: no value to show. */
  | { kind: "failed"; error: E };

/**
 * The plan's bounds: `step` (the collection's default limit, H), `maxLimit`
 * (M ≥ 2H), and `staleRows` — how many rows the released pages of one reader
 * keep between them (nearest the viewport first); a released page past it is
 * a placeholder.
 */
export interface PageLimits {
  step: number;
  maxLimit: number;
  staleRows: number;
}

/** Rows a page shows while its own read has none to show: released, or not landed yet. */
export interface HeldRows<R> {
  kind: "rows";
  entries: readonly R[];
  /**
   * The page's OWN read held them (it was released) — so what the page holds
   * is known. `false`: handed over by the page(s) it replaced, shown until its
   * own read lands, and no claim about what its range holds.
   */
  own: boolean;
  appliedSeq: number;
}

/**
 * A released page past the stale budget: its rows dropped, how many it held
 * kept — the height it stands in for. Subscribed again, it stays a
 * placeholder until its own read lands.
 */
export interface HeldPlaceholder {
  kind: "placeholder";
  size: number;
}

export type Held<R> = HeldRows<R> | HeldPlaceholder;

/**
 * How a page a split or merge minted may be SEEDED from rows the plan already
 * holds, instead of read whole (the runtime's seeded derivation): its rows
 * are, in order, a slice of each `from` page's settled rows — those after the
 * row `after` (exclusive; `null` = from its first row) through the row `until`
 * (inclusive; `null` = through the end of its range, which only a page that is
 * not full holds whole) — as that page's read stood at `appliedSeq`. Set only
 * where that IS the new page's whole range: the known part of a split (`(a,
 * k]` of `loadMore`, the half of an overflow up to its cut) and a merge of two
 * pages neither full. Read when the page is first subscribed; a page released
 * drops it.
 */
export interface PageSeed {
  from: readonly {
    page: Page;
    appliedSeq: number;
    after: string | null;
    until: string | null;
  }[];
}

export interface PlanPage<R> {
  page: Page;
  /** Subscribed: its read is live. Released, it shows `held`. */
  live: boolean;
  held: Held<R> | null;
  /** How its first read may be seeded — `null`: read whole. */
  seed: PageSeed | null;
}

export interface PagePlan<R> {
  /** Tiling the order, never empty: contiguous, and only the last has `until: null`. */
  pages: readonly PlanPage<R>[];
  /** The last page a `loadMore()` minted — the footer's spinner while it loads. */
  grown: Page | null;
}

/**
 * Where the viewport is, as the plan reads it: keyed by row id (a view's
 * indices are not the reader's once grouping or folding apply) — or, for a
 * page drawn as a placeholder, by its {@link placeholderKey}. `measuring`:
 * not known yet — nothing changes liveness. `none`: no row of this read is on
 * screen — every page releases.
 */
export type PageViewport =
  | { kind: "measuring" }
  | { kind: "none" }
  | { kind: "rows"; first: string; last: string };

/**
 * Why a full last page cannot be paged past: no row of it has a key short
 * enough to cut at. A KIND, not a sentence: the surface says it in its own
 * words.
 */
export type PagesTruncation = "long-sort-key";

/** A truncation in the plan's own terms — for a log line, never the UI. */
export const TRUNCATION_DETAIL: Readonly<Record<PagesTruncation, string>> = {
  "long-sort-key": "sort key too long to page past",
};

/** A new plan: one page over the whole order, at one step (the default window). */
export function startPages<R>(limits: PageLimits): PagePlan<R> {
  return {
    pages: [
      {
        page: { after: null, until: null, limit: limits.step },
        live: true,
        held: null,
        seed: null,
      },
    ],
    grown: null,
  };
}

export function samePage(a: Page, b: Page): boolean {
  return a.after === b.after && a.until === b.until && a.limit === b.limit;
}

/** A page's identity within one plan. */
export function pageKey(page: Page): string {
  return `${page.after ?? ""}\u0000${page.until ?? ""}\u0000${page.limit}`;
}

/**
 * The mark a page drawn as a placeholder is measured by — what a viewport
 * names it by, beside the row ids of the pages drawn as rows. Stable while
 * the page is one (a structural step only ever touches a page whose read
 * landed).
 */
export function placeholderKey(page: Page): string {
  return JSON.stringify(["page", page.after, page.until, page.limit]);
}

type Observe<R extends PageEntry, E extends Error> = (
  page: Page,
) => PageObservation<R, E>;

/** What a page shows right now, and how much it can be trusted. */
interface Shown<R> {
  entries: readonly R[];
  /** Its live read's own value (not held rows). */
  live: boolean;
  appliedSeq: number;
}

function observed<R extends PageEntry, E extends Error>(
  p: PlanPage<R>,
  observe: Observe<R, E>,
): PageObservation<R, E> | null {
  return p.live ? observe(p.page) : null;
}

function shownOf<R extends PageEntry, E extends Error>(
  p: PlanPage<R>,
  o: PageObservation<R, E> | null,
): Shown<R> | null {
  if (o !== null && o.kind === "settled") {
    return { entries: o.entries, live: true, appliedSeq: o.appliedSeq };
  }
  return p.held?.kind === "rows"
    ? { entries: p.held.entries, live: false, appliedSeq: p.held.appliedSeq }
    : null;
}

/**
 * The page is drawn as a placeholder: it shows no rows and holds a
 * placeholder's count. Read from what it SHOWS, never from `held` alone — a
 * page subscribed again from a placeholder keeps `held: placeholder` until it
 * is released, also once its own read has landed and it is drawn as rows.
 */
function isPlaceholderOf<R extends PageEntry, E extends Error>(
  p: PlanPage<R>,
  o: PageObservation<R, E> | null,
): boolean {
  return shownOf(p, o) === null && p.held?.kind === "placeholder";
}

/** The page's own rows, as last known: its live value, or what it held when released. */
function ownOf<R extends PageEntry, E extends Error>(
  p: PlanPage<R>,
  o: PageObservation<R, E> | null,
): readonly R[] | null {
  if (o !== null && o.kind === "settled") return o.entries;
  return p.held?.kind === "rows" && p.held.own ? p.held.entries : null;
}

/** A live value the server currently vouches for. */
function cleanOf<R extends PageEntry, E extends Error>(
  o: PageObservation<R, E> | null,
): readonly R[] | null {
  return o !== null && o.kind === "settled" && o.error === null
    ? o.entries
    : null;
}

function errorOf<R extends PageEntry, E extends Error>(
  o: PageObservation<R, E> | null,
): E | null {
  if (o === null || o.kind === "pending") return null;
  return o.error;
}

const first = (limits: PageLimits) =>
  Math.min(limits.maxLimit, 2 * limits.step);

/**
 * Where a full page that is not last splits: the cuttable row nearest the
 * median, leaving the first half short of its new limit (so it has headroom)
 * and never at the page's own upper cut (which would not shrink it). `null`:
 * no row can be cut at.
 */
function overflowCut<R extends PageEntry>(
  entries: readonly R[],
  page: Page,
  limits: PageLimits,
): number | null {
  const n = entries.length;
  const target = Math.max(0, Math.ceil(n / 2) - 1);
  const ok = (j: number) =>
    j >= 0 &&
    j < n &&
    j + 1 < first(limits) &&
    entries[j]!.key !== null &&
    entries[j]!.key !== page.until;
  for (let d = 0; d < n; d++) {
    if (ok(target - d)) return target - d;
    if (ok(target + d)) return target + d;
  }
  return null;
}

/** Where `loadMore()` splits the full last page: at its last cuttable row. */
function tailCut<R extends PageEntry>(entries: readonly R[]): number | null {
  for (let j = entries.length - 1; j >= 0; j--) {
    if (entries[j]!.key !== null) return j;
  }
  return null;
}

/** `pages[i]` cut after row `j`: two pages, each starting from its slice of the rows. */
function split<R extends PageEntry>(
  pages: readonly PlanPage<R>[],
  i: number,
  entries: readonly R[],
  appliedSeq: number,
  j: number,
  limits: PageLimits,
): PlanPage<R>[] {
  const source = pages[i]!.page;
  const { after, until } = source;
  const cut = entries[j]!.key!;
  const head: PlanPage<R> = {
    page: { after, until: cut, limit: first(limits) },
    live: true,
    held: {
      kind: "rows",
      entries: entries.slice(0, j + 1),
      own: false,
      appliedSeq,
    },
    // Known: the source's rows through the cut row are all of `(after, cut]`
    // (a window is a prefix of its range).
    seed: {
      from: [{ page: source, appliedSeq, after: null, until: entries[j]!.id }],
    },
  };
  const rest: PlanPage<R> = {
    page: {
      after: cut,
      until,
      limit: until === null ? limits.step : first(limits),
    },
    live: true,
    held: {
      kind: "rows",
      entries: entries.slice(j + 1),
      own: false,
      appliedSeq,
    },
    // Unknown: the source was full, so it may hide rows past its last.
    seed: null,
  };
  return [...pages.slice(0, i), head, rest, ...pages.slice(i + 1)];
}

/** `pages[i]` and `pages[i + 1]` as one page: the cut between them dropped. */
function merge<R extends PageEntry>(
  pages: readonly PlanPage<R>[],
  i: number,
  a: { entries: readonly R[]; appliedSeq: number },
  b: { entries: readonly R[]; appliedSeq: number },
  limits: PageLimits,
): PlanPage<R>[] {
  const rows = a.entries.length + b.entries.length;
  const seen = new Set(a.entries.map((e) => e.id));
  const pa = pages[i]!.page;
  const pb = pages[i + 1]!.page;
  // Known when neither is full (each holds its whole range) and no row is in
  // both (two values a sort-key move straddles): their rows, in order.
  const known =
    a.entries.length < pa.limit &&
    b.entries.length < pb.limit &&
    b.entries.every((e) => !seen.has(e.id));
  const merged: PlanPage<R> = {
    page: {
      after: pages[i]!.page.after,
      until: pages[i + 1]!.page.until,
      // Headroom: short of full by at least one step (never past maxLimit,
      // which a page that was not full already is short of).
      limit: Math.min(
        limits.maxLimit,
        Math.max(2 * limits.step, rows + limits.step),
      ),
    },
    live: true,
    held: {
      kind: "rows",
      entries: [...a.entries, ...b.entries.filter((e) => !seen.has(e.id))],
      own: false,
      appliedSeq: Math.max(a.appliedSeq, b.appliedSeq),
    },
    seed: known
      ? {
          from: [
            { page: pa, appliedSeq: a.appliedSeq, after: null, until: null },
            { page: pb, appliedSeq: b.appliedSeq, after: null, until: null },
          ],
        }
      : null,
  };
  return [...pages.slice(0, i), merged, ...pages.slice(i + 2)];
}

/** What `reconcile` did that a caller owes a report for: a full page that could not split. */
export interface ReconcileOutcome<R> {
  plan: PagePlan<R>;
  collapsed?: { at: number; reason: string };
}

/**
 * Advance the plan against what its live pages observe and where the
 * viewport is — `null`: the read has none, and {@link everyPageLive} applies
 * instead of {@link liveSet}. Pure, and the identity once nothing applies: fed its own
 * output while the reads it subscribed have not answered yet, it returns that
 * output unchanged — so a caller may run it on every render.
 *
 * First the structural steps, each over live pages whose read cleanly
 * settled (a page still loading, failing or released is left as it is), until
 * none applies:
 *
 * 1. **empty merge** — a page with no rows merges into its predecessor (its
 *    successor if it is the head);
 * 2. **overflow split** — a full page that is not last (it may be hiding rows)
 *    splits at its median cuttable key: `(a, m]` and `(m, b]`, each at `2·step`.
 *    One with no cuttable key COLLAPSES instead: the pages after it are
 *    dropped and it becomes the last page, so no row is hidden between pages
 *    (and the last page then says it cannot be paged past);
 * 3. **merge** — two adjacent pages holding ≤ `step` rows between them become
 *    one.
 *
 * Every page a step mints starts from its slice of the rows it replaces
 * (`held`, not its own), so nothing on screen flashes away; it is live until
 * its own read lands. Then {@link liveSet} applies the viewport.
 */
export function reconcile<R extends PageEntry, E extends Error>(
  plan: PagePlan<R>,
  observe: Observe<R, E>,
  viewport: PageViewport | null,
  limits: PageLimits,
): ReconcileOutcome<R> {
  let next = plan;
  let collapsed: { at: number; reason: string } | undefined;
  // Each step turns settled pages into pages not read yet, which no step
  // touches: the loop ends within one pass over the pages.
  for (let guard = 0; ; guard++) {
    if (guard > 2 * next.pages.length + 2) {
      throw new Error(
        `page plan: the structural steps did not settle over ${next.pages.length} pages`,
      );
    }
    const step = structuralStep(next, observe, limits);
    if (step === null) break;
    next = step.plan;
    collapsed ??= step.collapsed;
  }
  next =
    viewport === null
      ? everyPageLive(next, observe, limits)
      : liveSet(next, observe, viewport, limits);
  return collapsed ? { plan: next, collapsed } : { plan: next };
}

/**
 * The live set of a read with no viewport: nothing says which rows are on
 * screen, so no page can be released — every page is live — and what the
 * read holds is bounded by `maxLimit` instead (the bound a reader with no
 * viewport always had). `loadMore()` stops short of it (the caller's check:
 * a new page must fit), and pages a live insert pushed past it go: once the
 * pages before the last hold `maxLimit` rows between them, the last is
 * dropped and the one before it becomes the last (`until: null`), showing
 * its rows until its own read lands. So the pages before the last hold fewer
 * than `maxLimit` rows, and the read at most that plus its last page's.
 */
export function everyPageLive<R extends PageEntry, E extends Error>(
  plan: PagePlan<R>,
  observe: Observe<R, E>,
  limits: PageLimits,
): PagePlan<R> {
  const all = plan.pages.every((p) => p.live)
    ? plan.pages
    : plan.pages.map((p) => (p.live ? p : { ...p, live: true }));
  const obs = all.map((p) => observed(p, observe));
  const sizes = all.map((p, i) => shownOf(p, obs[i]!)?.entries.length ?? 0);
  // `held`: the rows of the pages before the last of the first `kept`.
  let kept = all.length;
  let held = sizes.slice(0, kept - 1).reduce((n, s) => n + s, 0);
  while (kept > 1 && held >= limits.maxLimit) {
    kept--;
    held -= sizes[kept - 1]!;
  }
  if (kept === all.length) {
    return all === plan.pages ? plan : { ...plan, pages: all };
  }
  const last = all[kept - 1]!;
  const shown = shownOf(last, obs[kept - 1]!);
  return {
    pages: [
      ...all.slice(0, kept - 1),
      {
        page: { after: last.page.after, until: null, limit: last.page.limit },
        live: true,
        held:
          shown === null
            ? last.held
            : {
                kind: "rows",
                entries: shown.entries,
                own: false,
                appliedSeq: shown.appliedSeq,
              },
        // Its range grew past its old cut: read whole.
        seed: null,
      },
    ],
    grown: null,
  };
}

function structuralStep<R extends PageEntry, E extends Error>(
  plan: PagePlan<R>,
  observe: Observe<R, E>,
  limits: PageLimits,
): ReconcileOutcome<R> | null {
  const { pages } = plan;
  const K = pages.length;
  const obs = pages.map((p) => observed(p, observe));
  const clean = obs.map(cleanOf);
  const seqOf = (i: number) => {
    const o = obs[i]!;
    return o !== null && o.kind === "settled" ? o.appliedSeq : 0;
  };
  const at = (i: number) => ({ entries: clean[i]!, appliedSeq: seqOf(i) });
  const with_ = (next: PlanPage<R>[]): PagePlan<R> => ({
    ...plan,
    pages: next,
  });

  // 1. Empty merge.
  if (K > 1) {
    for (let i = 0; i < K; i++) {
      if (clean[i]?.length !== 0) continue;
      const j = i === 0 ? 1 : i - 1;
      if (clean[j] === null) continue;
      const lo = Math.min(i, j);
      return { plan: with_(merge(pages, lo, at(lo), at(lo + 1), limits)) };
    }
  }

  // 2. Overflow split — or collapse.
  for (let i = 0; i + 1 < K; i++) {
    const entries = clean[i];
    const page = pages[i]!.page;
    if (entries == null || entries.length < page.limit) continue;
    const j = overflowCut(entries, page, limits);
    if (j !== null) {
      return {
        plan: with_(split(pages, i, entries, seqOf(i), j, limits)),
      };
    }
    return {
      plan: {
        pages: [
          ...pages.slice(0, i),
          {
            page: { after: page.after, until: null, limit: page.limit },
            live: true,
            held: {
              kind: "rows",
              entries,
              own: false,
              appliedSeq: seqOf(i),
            },
            // The page was full: it may hide rows past its last.
            seed: null,
          },
        ],
        grown: null,
      },
      collapsed: { at: i, reason: TRUNCATION_DETAIL["long-sort-key"] },
    };
  }

  // 3. Merge two small neighbours.
  for (let i = 0; i + 1 < K; i++) {
    const a = clean[i];
    const b = clean[i + 1];
    if (a == null || b == null) continue;
    if (a.length + b.length <= limits.step) {
      return { plan: with_(merge(pages, i, at(i), at(i + 1), limits)) };
    }
  }
  return null;
}

/**
 * Which pages are subscribed, given the viewport: a page within one page of
 * what is on screen is live, one three or more pages away is released
 * (keeping what it holds as stale rows), and one two pages away stays as it
 * is — the band that keeps a scroll back and forth from churning
 * subscriptions. `measuring` changes nothing; `none` releases every page.
 * Whatever the viewport, a live page whose read has not answered yet (just
 * minted: it shows rows handed over) stays live until it does, and a plan
 * showing no row at all stays live (an empty list has no row to be seen by).
 * A page whose read FAILED has answered: it follows its band like any other
 * (released, it keeps what it shows and retries when it comes back), so no
 * page is live outside the band but for one in flight.
 *
 * Then the STALE BUDGET ({@link applyStaleBudget}): the released pages keep
 * at most `staleRows` rows between them, nearest the viewport first; the
 * rest become placeholders.
 */
export function liveSet<R extends PageEntry, E extends Error>(
  plan: PagePlan<R>,
  observe: Observe<R, E>,
  viewport: PageViewport,
  limits: PageLimits,
): PagePlan<R> {
  const { pages } = plan;
  const obs = pages.map((p) => observed(p, observe));
  const layout = layoutOf(pages, obs);
  // Every row the plan stands for — drawn as a row or inside a placeholder.
  const total = pages.reduce((n, p, i) => {
    const s = shownOf(p, obs[i]!);
    if (s !== null) return n + s.entries.length;
    return n + (p.held?.kind === "placeholder" ? p.held.size : 0);
  }, 0);
  // The visible pages, as an index range — `null` keeps every page as it is.
  let band: Band = null;
  if (viewport.kind === "none") band = "none";
  if (viewport.kind === "rows") {
    const winners = winningPages(layout.shown);
    const marks = new Map<string, number>();
    layout.placeholder.forEach((size, i) => {
      if (size !== null) marks.set(placeholderKey(pages[i]!.page), i);
    });
    const indexOf = (key: string) => winners.get(key) ?? marks.get(key);
    const a = indexOf(viewport.first);
    const b = indexOf(viewport.last);
    // A key no page shows (it left since the viewport was measured): wait
    // for the next measurement.
    if (a !== undefined && b !== undefined) {
      band = { lo: Math.min(a, b), hi: Math.max(a, b) };
    }
  }
  let changed = false;
  const next = pages.map((p, i): PlanPage<R> => {
    const o = obs[i]!;
    let want: boolean;
    if ((o !== null && o.kind === "pending") || total === 0) want = true;
    else if (band === null) want = p.live;
    else if (band === "none") want = false;
    else {
      const d = i < band.lo ? band.lo - i : i > band.hi ? i - band.hi : 0;
      want = d <= 1 ? true : d >= 3 ? false : p.live;
    }
    if (want === p.live) return p;
    changed = true;
    if (want) return { ...p, live: true };
    // Released: what it showed last is what it holds (and its seed, read
    // only on a first subscribe, goes).
    return {
      page: p.page,
      live: false,
      seed: null,
      held:
        o !== null && o.kind === "settled"
          ? {
              kind: "rows",
              entries: o.entries,
              own: true,
              appliedSeq: o.appliedSeq,
            }
          : p.held,
    };
  });
  const budgeted =
    band === null ? next : applyStaleBudget(next, obs, band, limits.staleRows);
  if (budgeted !== next) changed = true;
  return changed ? { ...plan, pages: budgeted } : plan;
}

/** The visible pages: an index range, none on screen, or not known. */
type Band = { lo: number; hi: number } | "none" | null;

/**
 * The stale budget: walking out from the visible pages — one page further
 * on each side at a time (from the head when nothing is on screen) — the
 * released pages keep their rows while their total stays within
 * `staleRows`; the first that would pass it, and every page beyond it on
 * that side, becomes a placeholder of the rows it held. A page DRAWN as a
 * placeholder ends its side the same way: past it the rows could not be
 * drawn anyway (they would not join the rows on screen). A page subscribed
 * again from a placeholder whose read has landed is drawn as rows, so it
 * ends nothing. Live pages cost nothing — their rows are the viewport's.
 * `obs` is what each page observed before this pass changed its liveness: a
 * page it just subscribed again has observed nothing yet (`null`).
 */
function applyStaleBudget<R extends PageEntry, E extends Error>(
  pages: readonly PlanPage<R>[],
  obs: readonly (PageObservation<R, E> | null)[],
  band: Exclude<Band, null>,
  staleRows: number,
): readonly PlanPage<R>[] {
  const K = pages.length;
  const lo = band === "none" ? -1 : band.lo;
  const hi = band === "none" ? -1 : band.hi;
  let out: PlanPage<R>[] | null = null;
  let used = 0;
  const ended = { up: false, down: false };
  for (let d = 1; lo - d >= 0 || hi + d < K; d++) {
    for (const [i, side] of [
      [lo - d, "up"],
      [hi + d, "down"],
    ] as const) {
      if (i < 0 || i >= K) continue;
      const p = pages[i]!;
      if (isPlaceholderOf(p, p.live ? obs[i]! : null)) {
        ended[side] = true;
        continue;
      }
      if (p.live || p.held === null || p.held.kind !== "rows") continue;
      const size = p.held.entries.length;
      if (!ended[side] && used + size <= staleRows) {
        used += size;
        continue;
      }
      ended[side] = true;
      out ??= [...pages];
      out[i] = { ...p, held: { kind: "placeholder", size } };
    }
  }
  return out ?? pages;
}

/**
 * How the pages are drawn: the pages drawn as ROWS are one contiguous run
 * (the CORE), and every page outside it is drawn as one placeholder — so a
 * placeholder only ever sits before the rows or after them, never between
 * two rows (which no view has an entry kind for). A page outside the core
 * that still holds rows (a straggler a read landed on past a placeholder)
 * is drawn as a placeholder of their count.
 *
 * The core is the run of pages that show no placeholder holding the most
 * live pages — around the viewport — then the most rows, then the first.
 */
interface Layout<R> {
  /** What each page shows as rows; `null` for a page drawn as a placeholder (or showing nothing yet). */
  shown: (Shown<R> | null)[];
  /** Per page drawn as a placeholder, the rows it stands in for; `null` for a page drawn as rows. */
  placeholder: (number | null)[];
  /** The pages drawn as rows, `[lo, hi]`; `null` when every page is a placeholder. */
  core: { lo: number; hi: number } | null;
}

function layoutOf<R extends PageEntry, E extends Error>(
  pages: readonly PlanPage<R>[],
  obs: readonly (PageObservation<R, E> | null)[],
): Layout<R> {
  const raw = pages.map((p, i) => shownOf(p, obs[i]!));
  const isPlaceholder = (i: number) => isPlaceholderOf(pages[i]!, obs[i]!);
  let core: { lo: number; hi: number } | null = null;
  let best = { live: -1, rows: -1 };
  for (let lo = 0; lo < pages.length;) {
    if (isPlaceholder(lo)) {
      lo++;
      continue;
    }
    let hi = lo;
    while (hi + 1 < pages.length && !isPlaceholder(hi + 1)) hi++;
    let live = 0;
    let rows = 0;
    for (let i = lo; i <= hi; i++) {
      if (raw[i]?.live) live++;
      rows += raw[i]?.entries.length ?? 0;
    }
    if (live > best.live || (live === best.live && rows > best.rows)) {
      best = { live, rows };
      core = { lo, hi };
    }
    lo = hi + 1;
  }
  const inCore = (i: number) => core !== null && i >= core.lo && i <= core.hi;
  return {
    shown: raw.map((s, i) => (inCore(i) ? s : null)),
    placeholder: pages.map((p, i) => {
      if (inCore(i)) return null;
      if (raw[i] !== null) return raw[i]!.entries.length;
      return p.held?.kind === "placeholder" ? p.held.size : 0;
    }),
    core,
  };
}

/**
 * Each row's page: where it is shown when several pages hold it (a row whose
 * sort key moved, between the frames of the two pages it left and entered).
 * A live copy beats a stale one; between two of the same kind, the more
 * recently applied value wins — never "the later page", since a sort key can
 * move a row backwards — and a tie goes to the later page.
 */
function winningPages<R extends PageEntry>(
  shown: readonly (Shown<R> | null)[],
): Map<string, number> {
  const best = new Map<string, number>();
  const beats = (i: number, j: number): boolean => {
    const a = shown[i]!;
    const b = shown[j]!;
    if (a.live !== b.live) return a.live;
    if (a.appliedSeq !== b.appliedSeq) return a.appliedSeq > b.appliedSeq;
    return i > j;
  };
  shown.forEach((s, i) => {
    if (s === null) return;
    for (const e of s.entries) {
      const j = best.get(e.id);
      if (j === undefined || (j !== i && beats(i, j))) best.set(e.id, i);
    }
  });
  return best;
}

/**
 * Page past the last page (`loadMore()`): split the full last page at its
 * last cuttable row — `(a, k]` keeps the rows it showed (with headroom), and
 * `(k, ∞)` at one step is the new page. A released last page is re-subscribed
 * first (a stale page never pages: what it holds may be out of date). Nothing
 * otherwise, unless the last page is live, cleanly settled and full, and has
 * a row to cut at.
 */
export function loadMore<R extends PageEntry, E extends Error>(
  plan: PagePlan<R>,
  observe: Observe<R, E>,
  limits: PageLimits,
): PagePlan<R> {
  const K = plan.pages.length;
  const last = plan.pages[K - 1]!;
  if (!last.live) {
    return {
      ...plan,
      pages: [...plan.pages.slice(0, K - 1), { ...last, live: true }],
    };
  }
  const o = observe(last.page);
  const entries = cleanOf(o);
  if (entries === null || entries.length < last.page.limit) return plan;
  const j = tailCut(entries);
  if (j === null) return plan;
  const appliedSeq = o.kind === "settled" ? o.appliedSeq : 0;
  const pages = split(plan.pages, K - 1, entries, appliedSeq, j, limits);
  return { pages, grown: pages[pages.length - 1]!.page };
}

/** A read failing under rows that stay on screen. */
export interface PageFailure<E extends Error = Error> {
  /** The page whose read failed. */
  index: number;
  page: Page;
  error: E;
  /**
   * Paging is stopped on it: the last page's own read, or — when the plan can
   * neither grow nor is exhausted, nothing is loading and no page is a
   * placeholder — every failure (one of them is what holds it).
   */
  blocksPaging: boolean;
}

/** A page drawn as one placeholder, standing in for `size` rows. */
export interface PagePlaceholder {
  index: number;
  page: Page;
  /** Its {@link placeholderKey}: what a viewport names it by. */
  key: string;
  size: number;
}

/** What the pages assemble into. */
export interface Assembly<R extends PageEntry, E extends Error = Error> {
  /** The rows of the pages drawn as rows, in order, a row shown once (see {@link winningPages}). */
  entries: readonly R[];
  /** Per page, the index in `entries` of its first row (where a notice about it sits). */
  firstOf: readonly number[];
  /**
   * The pages drawn as placeholders: those before the rows, and those after
   * them — never between two rows (see {@link layoutOf}). Every page is in
   * `before` when none is drawn as rows.
   */
  before: readonly PagePlaceholder[];
  after: readonly PagePlaceholder[];
  /** The head has something to show (rows, its own or handed over — or a placeholder). */
  loaded: boolean;
  /**
   * No row past those shown: every page knows its rows, none is a
   * placeholder, and the last is not full.
   */
  exhausted: boolean;
  /** `loadMore()` would add rows: the last page is live, settled, full, cuttable and drawn as rows. */
  canGrow: boolean;
  /** A `loadMore()`'s page is loading and has not failed. */
  growing: boolean;
  truncated: PagesTruncation | null;
  failures: readonly PageFailure<E>[];
  /** The head's first read failed with nothing to show. */
  headError: E | null;
}

export function assemble<R extends PageEntry, E extends Error>(
  plan: PagePlan<R>,
  observe: Observe<R, E>,
): Assembly<R, E> {
  const { pages } = plan;
  const K = pages.length;
  const obs = pages.map((p) => observed(p, observe));
  const layout = layoutOf(pages, obs);
  const { shown, core } = layout;
  const winners = winningPages(shown);
  const entries: R[] = [];
  const firstOf: number[] = [];
  const before: PagePlaceholder[] = [];
  const after: PagePlaceholder[] = [];
  const emitted = new Set<string>();
  pages.forEach((p, i) => {
    firstOf.push(entries.length);
    const size = layout.placeholder[i]!;
    if (size !== null) {
      const placeholder = {
        index: i,
        page: p.page,
        key: placeholderKey(p.page),
        size,
      };
      if (core === null || i < core.lo) before.push(placeholder);
      else after.push(placeholder);
      return;
    }
    const s = shown[i]!;
    if (s === null) return;
    for (const e of s.entries) {
      if (winners.get(e.id) !== i || emitted.has(e.id)) continue;
      emitted.add(e.id);
      entries.push(e);
    }
  });

  const last = pages[K - 1]!;
  const lastObs = obs[K - 1]!;
  const lastDrawn = core !== null && core.hi === K - 1;
  const lastClean = cleanOf(lastObs);
  const lastFull = lastClean !== null && lastClean.length >= last.page.limit;
  const truncated: PagesTruncation | null =
    lastFull && tailCut(lastClean) === null ? "long-sort-key" : null;
  const canGrow = lastFull && lastDrawn && truncated === null;
  const lastOwn = ownOf(last, lastObs);
  const exhausted =
    before.length === 0 &&
    after.length === 0 &&
    pages.every((p, i) => ownOf(p, obs[i]!) !== null) &&
    lastOwn !== null &&
    lastOwn.length < last.page.limit;
  const growing =
    plan.grown !== null &&
    samePage(plan.grown, last.page) &&
    lastDrawn &&
    lastObs !== null &&
    lastObs.kind === "pending";
  const loaded =
    shownOf(pages[0]!, obs[0]!) !== null ||
    pages[0]!.held?.kind === "placeholder";
  const inFlight = obs.some((o) => o !== null && o.kind === "pending");
  // Nothing loading, nothing more to page, not the end, not truncated and no
  // placeholder: a failing read is what holds the plan where it is. A read
  // with placeholders is held short by the viewport, not by a failure — they
  // resolve once scrolled into view — so a failure there is a notice over
  // the rows it could not refresh, never "paging stopped".
  const stuck =
    loaded &&
    !inFlight &&
    !exhausted &&
    !canGrow &&
    truncated === null &&
    before.length === 0 &&
    after.length === 0;
  const failures: PageFailure<E>[] = [];
  obs.forEach((o, index) => {
    const error = errorOf(o);
    if (error === null) return;
    failures.push({
      index,
      page: pages[index]!.page,
      error,
      blocksPaging: stuck || index === K - 1,
    });
  });
  const head = obs[0]!;
  return {
    entries,
    firstOf,
    before,
    after,
    loaded,
    exhausted,
    canGrow,
    growing,
    truncated,
    failures,
    headError:
      !loaded && head !== null && head.kind === "failed" ? head.error : null,
  };
}

/** The pages whose reads are subscribed. */
export function livePagesOf<R>(plan: PagePlan<R>): readonly Page[] {
  return plan.pages.filter((p) => p.live).map((p) => p.page);
}
