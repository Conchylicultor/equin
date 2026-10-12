// The cross-page gap detector behind the `live-pages` log's `cross-page gap`
// line. A row whose sort key moves it from one live page to another reaches
// the tab as two frames — the page it left and the page it entered — and in
// between it may be in NO page (shown nowhere) when the leaving frame lands
// first. The duplicate (the entering frame first) is resolved by the plan's
// dedup; the gap is only measured, to decide whether a client-side departure
// hold is worth building (research/2026-10-12-global-live-paging-followups.md).
//
// Cost is per CHANGED page, never per row of the read: a page whose rows array
// is the same object as last time (live-state keeps an unchanged value's
// identity) is skipped, and a changed one is diffed against the id set kept for
// it — the order of work the hook already does mapping that page's rows.

/** One live page as the detector sees it: its identity and its current rows. */
export interface GapPage<Row> {
  /** Unique among the pages of one observation (the page's tuple key). */
  key: string;
  rows: readonly Row[];
}

/** A row that left one live page and reappeared in another, shown in neither between. */
export interface CrossPageGap {
  id: string;
  from: string;
  to: string;
  /** How long it was in no live page. */
  ms: number;
}

export interface CrossPageGaps<Row> {
  /**
   * Feed what the read's settled live pages hold now (`at` in ms, a monotonic
   * clock); returns the gaps that closed since the last call. A page absent
   * from the previous call (just minted, or live again) is first seen: its rows
   * are arrivals, never departures, and a page that leaves (released, replaced
   * by a split or merge) departs none of its rows — they are handed on, not
   * gone.
   */
  observe(at: number, pages: readonly GapPage<Row>[]): CrossPageGap[];
}

/** A row out of every live page since `at`, last seen in `from`. */
interface Departure {
  from: string;
  at: number;
}

/**
 * A detector over rows identified by `idOf`. A departure counts only once the
 * row is in NO live page (a row two pages hold — the duplicate — leaving one of
 * them is no gap), and expires after `windowMs` (a deleted row never comes
 * back); its reappearance in the SAME page is a flip, not a move, and closes
 * nothing.
 */
export function createCrossPageGaps<Row>(
  idOf: (row: Row) => string,
  windowMs = 1000,
): CrossPageGaps<Row> {
  /** Each tracked page's rows array and the ids it holds. */
  const held = new Map<string, { rows: readonly Row[]; ids: Set<string> }>();
  /** How many tracked pages hold each id. */
  const holders = new Map<string, number>();
  const departed = new Map<string, Departure>();

  const hold = (id: string) => holders.set(id, (holders.get(id) ?? 0) + 1);
  /** One page fewer holds `id`; `true` when none does any more. */
  const release = (id: string): boolean => {
    const n = (holders.get(id) ?? 0) - 1;
    if (n > 0) {
      holders.set(id, n);
      return false;
    }
    holders.delete(id);
    return true;
  };

  return {
    observe(at, pages) {
      for (const [id, d] of departed) {
        if (at - d.at > windowMs) departed.delete(id);
      }
      // Diff every changed page first, then apply arrivals before departures:
      // a move both of whose frames are in this one observation was never in
      // no page.
      const arrivals: { id: string; to: string }[] = [];
      const departures: { id: string; from: string }[] = [];
      const seen = new Set<string>();
      for (const { key, rows } of pages) {
        seen.add(key);
        const prev = held.get(key);
        if (prev !== undefined && prev.rows === rows) continue;
        const ids = new Set(rows.map(idOf));
        for (const id of ids) {
          if (prev === undefined || !prev.ids.has(id)) {
            arrivals.push({ id, to: key });
          }
        }
        if (prev !== undefined) {
          for (const id of prev.ids) {
            if (!ids.has(id)) departures.push({ id, from: key });
          }
        }
        held.set(key, { rows, ids });
      }
      const gaps: CrossPageGap[] = [];
      for (const { id, to } of arrivals) {
        hold(id);
        const d = departed.get(id);
        if (d === undefined) continue;
        departed.delete(id);
        if (d.from !== to) gaps.push({ id, from: d.from, to, ms: at - d.at });
      }
      for (const { id, from } of departures) {
        if (release(id)) departed.set(id, { from, at });
      }
      // A page no longer observed hands its rows on: untracked, no departure.
      for (const [key, page] of held) {
        if (seen.has(key)) continue;
        for (const id of page.ids) release(id);
        held.delete(key);
      }
      return gaps;
    },
  };
}
