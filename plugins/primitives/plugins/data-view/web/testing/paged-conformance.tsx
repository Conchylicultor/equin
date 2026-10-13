import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import type {
  DataViewPagePlaceholder,
  DataViewPaging,
  DataViewVisibleRows,
  FieldDef,
} from "../../core";
import {
  consumerPaging,
  mountPagedDataView,
  type PagedDataView,
  type PagedLayout,
  type PagedViewUnderTest,
} from "./paged-data-view";

interface Card {
  id: string;
  name: string;
}

const FIELDS: FieldDef<Card>[] = [
  {
    id: "name",
    label: "Name",
    type: "plain",
    value: (r) => r.name,
    primary: true,
  },
];

const cards = (from: number, to: number): Card[] =>
  Array.from({ length: to - from }, (_, i) => ({
    id: `c${from + i}`,
    name: `card ${from + i}`,
  }));
const keys = (from: number, to: number) => cards(from, to).map((c) => c.id);

/**
 * One paged read over cards `c0 … c<total − 1>`, a page of `page` cards
 * released (and landed back) at its head, mounted through the real body
 * (`mountPagedDataView`).
 */
function pagedRead(
  view: PagedViewUnderTest,
  layout: PagedLayout,
  total: number,
) {
  const reports: DataViewVisibleRows[] = [];
  let rows = cards(0, total);
  let paging: DataViewPaging<Card> = consumerPaging<Card>([], [], reports);
  const dv = mountPagedDataView<Card>({
    view,
    layout,
    bundle: () => ({ fields: FIELDS, rows, rowKey: (r) => r.id, paging }),
  });
  const set = (from: number, before: DataViewPagePlaceholder[]) => {
    rows = cards(from, total);
    paging = consumerPaging(before, [], reports);
    dv.rerender();
  };
  return {
    dv,
    reports,
    /** The first `page` cards released: one placeholder stands above the rest. */
    release: (page: number) => set(page, [{ key: "page-0", rows: page }]),
    /** The page lands back: every card drawn again. */
    land: () => set(0, []),
    ready: () => waitFor(() => expect(dv.drawnRows()).toHaveLength(total)),
  };
}

/** Each card's column, keyed by row key. */
const columns = (dv: PagedDataView, ks: string[]) =>
  ks.map((k) => dv.layoutOf(k).column);

/**
 * The paged-view contract every DataView view honours, run against `view`
 * mounted through the real body on a laid-out page (`mountPagedDataView`):
 *
 * - a released page is drawn as ONE placeholder carrying `data-row-key` (its
 *   key) and `data-page-placeholder`, through the loading primitive;
 * - the placeholder is exactly the room the released rows took, so nothing
 *   after it moves;
 * - a release writes no scroll (the layout holds the reader by itself);
 * - a landing whose rows changed size above the reader is anchored: the row
 *   being read stays where it is.
 *
 * Under a grid layout (`{ columns, linePx }`) two more:
 *
 * - a page that does not fill whole lines (`columns` not dividing it) keeps
 *   every surviving card in its column across the release and the landing —
 *   below the view's windowing threshold and above it (`windowAbove`: the
 *   view windows past that many cells);
 * - windowed, a release keeps the mounted lines' DOM (lines are keyed by
 *   absolute line, not by their first card).
 */
export function describePagedConformance(opts: {
  view: PagedViewUnderTest;
  layout: PagedLayout;
  /** Grid layouts: the cell count above which the view windows. */
  windowAbove?: number;
}): void {
  const { view, layout } = opts;
  const grid = layout === "stack" ? null : layout;
  /** Cards released at the head: whole rows in a stack, a page ending mid-line in a grid. */
  const page = grid === null ? 4 : grid.columns * 2 + 1;
  const total = grid === null ? 12 : grid.columns * 6;
  /** The row the reader is on: the first card of the line after the page's last. */
  const reader =
    grid === null
      ? "c6"
      : `c${Math.ceil((page + 1) / grid.columns) * grid.columns}`;
  /** Make the released rows taller, as rows that changed while away. */
  const grow = (dv: PagedDataView) => {
    const taller = (grid === null ? 20 : grid.linePx) + 15;
    dv.setRowHeight((k) => (keys(0, page).includes(k) ? taller : undefined));
  };
  /** Scroll the reader to the top of the screen. */
  const readAt = async (dv: PagedDataView) => {
    dv.scrollTo(dv.layoutOf(reader).top + dv.scrollTop());
    await dv.settle();
    expect(dv.layoutOf(reader).top).toBe(0);
  };

  describe(`paged conformance — ${view.type}`, () => {
    it("a released page is one placeholder, marked as a row and drawn as loading", async () => {
      const r = pagedRead(view, layout, total);
      await r.ready();
      r.release(page);
      expect(r.dv.placeholders().map((p) => p.key)).toEqual(["page-0"]);
      const el = r.dv.element("page-0");
      expect(el.hasAttribute("data-page-placeholder")).toBe(true);
      expect(el.querySelector('[role="status"]')).not.toBeNull();
      expect(el.textContent).toBe("");
      expect(r.dv.drawnRows()).toEqual(keys(page, total));
    });

    it("the placeholder is the room its rows took: nothing after it moves", async () => {
      const r = pagedRead(view, layout, total);
      // Stacked, released rows of their own height, so the room is measured,
      // not derived from the pitch. (A grid's last released line is shared
      // with survivors, so its height is theirs too.)
      if (grid === null) {
        r.dv.setRowHeight((k) => (keys(0, page).includes(k) ? 30 : undefined));
      }
      await r.ready();
      await r.dv.settle();
      const survivors = keys(page, total);
      const before = survivors.map((k) => r.dv.layoutOf(k).top);
      // The room the released rows took: everything above the first
      // survivor's own line.
      const room = before[0]!;
      r.release(page);
      expect(r.dv.placeholders()).toEqual([
        { key: "page-0", height: `${room}px` },
      ]);
      expect(survivors.map((k) => r.dv.layoutOf(k).top)).toEqual(before);
    });

    it("a release above the reader writes no scroll", async () => {
      const r = pagedRead(view, layout, total);
      await r.ready();
      await readAt(r.dv);
      const top = r.dv.scrollTop();
      r.dv.clearScrollWrites();
      r.release(page);
      expect(r.dv.scrollWrites()).toBe(0);
      expect(r.dv.scrollTop()).toBe(top);
      expect(r.dv.layoutOf(reader).top).toBe(0);
    });

    it("a landing above the reader that changed size is anchored", async () => {
      const r = pagedRead(view, layout, total);
      await r.ready();
      await readAt(r.dv);
      r.release(page);
      const top = r.dv.scrollTop();
      grow(r.dv);
      r.land();
      expect(r.dv.placeholders()).toEqual([]);
      expect(r.dv.layoutOf(reader).top).toBe(0);
      expect(r.dv.scrollTop()).not.toBe(top);
    });

    if (grid === null) return;

    // A windowed grid lays out a hundred-odd cards on every measurement.
    const WINDOWED_MS = 30_000;
    const gridCases = (count: number, label: string, timeout?: number) => {
      it(
        `a page ending mid-line keeps every card's column (${label})`,
        async () => {
          expect(page % grid.columns).not.toBe(0);
          const r = pagedRead(view, layout, count);
          await r.ready();
          const survivors = keys(page, count);
          const before = columns(r.dv, survivors);
          r.release(page);
          expect(columns(r.dv, survivors)).toEqual(before);
          r.land();
          expect(columns(r.dv, keys(0, count))).toEqual(
            keys(0, count).map((_, i) => i % grid.columns),
          );
        },
        timeout,
      );
    };
    gridCases(total, "plain grid");
    if (opts.windowAbove === undefined) return;
    // Windowed before the release and after it (crossing the threshold would
    // swap the branch, remounting every card).
    const windowed = opts.windowAbove + page + grid.columns * 2;
    gridCases(windowed, "windowed", WINDOWED_MS);

    it(
      "windowed: a release keeps the mounted lines' DOM",
      async () => {
        const r = pagedRead(view, layout, windowed);
        await r.ready();
        const survivors = keys(page, windowed);
        const nodes = survivors.map((k) => r.dv.element(k));
        /** Survivors whose element is not the one drawn before (remounted). */
        const remounted = () =>
          survivors.filter((k, i) => r.dv.element(k) !== nodes[i]);
        r.release(page);
        expect(remounted()).toEqual([]);
        r.land();
        expect(remounted()).toEqual([]);
      },
      WINDOWED_MS,
    );
  });
}
