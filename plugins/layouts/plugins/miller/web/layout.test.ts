import { describe, expect, it } from "bun:test";
import {
  BAR_WIDTH,
  HANDLE_WIDTH,
  MIN_COLUMN_WIDTH,
  PAIR_MIN,
  SHARE_MIN,
  dragLayout,
  effectiveZoom,
  heldInner,
  layoutColumns,
  moveZoom,
  routeKey,
  scrollTarget,
  toggleZoom,
  type ColumnInput,
} from "./layout";

const col = (
  id: string,
  dragged: number | null = null,
  collapsed = false,
): ColumnInput => ({ id, dragged, collapsed });
const cols = (n: number) =>
  Array.from({ length: n }, (_, i) => col(String.fromCharCode(97 + i)));

const widths = (cols: { width: number }[]) => cols.map((c) => c.width);

describe("layoutColumns — balanced", () => {
  it("columns that fit share the row equally: 50/50, then 33/33/33", () => {
    expect(widths(layoutColumns(cols(1), 1470, null).columns)).toEqual([1470]);
    expect(widths(layoutColumns(cols(2), 1470, null).columns)).toEqual([
      735, 735,
    ]);
    expect(widths(layoutColumns(cols(3), 1470, null).columns)).toEqual([
      490, 490, 490,
    ]);
  });

  it("past SHARE_MIN, older columns keep the same share and scroll off", () => {
    // 1470 / 420 → 3 fit; a 4th opens on the right at the same width.
    const l = layoutColumns(cols(4), 1470, null);
    expect(widths(l.columns)).toEqual([490, 490, 490, 490]);
    expect(scrollTarget(l, 1470)).toBe(490);
  });

  it("the leaf gets no bonus: opening the next column moves nothing else's share", () => {
    const three = layoutColumns(cols(3), 1470, null);
    const four = layoutColumns(cols(4), 1470, null);
    expect(four.columns[2]!.width).toBe(three.columns[2]!.width);
  });

  it("a narrow row keeps two columns side by side down to PAIR_MIN each", () => {
    // 699 < 2 × 420, but ≥ 2 × 300: the pane opened from stays beside.
    const l = layoutColumns(cols(3), 699, null);
    expect(widths(l.columns)).toEqual([349.5, 349.5, 349.5]);
    expect(scrollTarget(l, 699)).toBe(349.5);
    expect(2 * PAIR_MIN).toBeLessThan(2 * SHARE_MIN);
  });

  it("below two PAIR_MIN, one column takes the row", () => {
    const l = layoutColumns(cols(2), 500, null);
    expect(widths(l.columns)).toEqual([500, 500]);
    expect(scrollTarget(l, 500)).toBe(500);
  });

  it("a dragged column keeps its width; the others share what it leaves", () => {
    const l = layoutColumns([col("a", 300), col("b"), col("c")], 1300, null);
    expect(widths(l.columns)).toEqual([300, 500, 500]);
  });

  it("a dragged column counts at its width when deciding what fits", () => {
    // a (700) + b + c at 420 = 1540 > 1300: b and c share, a scrolls off.
    const l = layoutColumns([col("a", 700), col("b"), col("c")], 1300, null);
    expect(widths(l.columns)).toEqual([700, 650, 650]);
    expect(scrollTarget(l, 1300)).toBe(700);
  });

  it("all shown columns dragged: the leaf shares", () => {
    const l = layoutColumns([col("a", 300), col("b", 300)], 1000, null);
    expect(widths(l.columns)).toEqual([300, 700]);
  });

  it("a user-collapsed column is a 32px bar and leaves the rest to share; the leaf never is", () => {
    const l = layoutColumns(
      [col("a", null, true), col("b"), col("c", null, true)],
      1032,
      null,
    );
    expect(l.columns.map((c) => c.bar)).toEqual([true, false, false]);
    expect(widths(l.columns)).toEqual([BAR_WIDTH, 500, 500]);
    expect(l.columns[0]!.handle).toBe(false);
  });

  it("an unmeasured row lays every column at SHARE_MIN (a dragged one at its width)", () => {
    const l = layoutColumns([col("a", 300), col("b")], 0, null);
    expect(widths(l.columns)).toEqual([300, SHARE_MIN]);
  });

  it("dividers on every non-leaf column; the inner width excludes it", () => {
    const l = layoutColumns(cols(2), 1000, null);
    expect(l.columns.map((c) => c.handle)).toEqual([true, false]);
    expect(l.columns[0]!.inner).toBe(500 - HANDLE_WIDTH);
    expect(l.columns[1]!.inner).toBe(500);
  });

  it("a width never depends on history: opening and closing gives the same widths back", () => {
    const two = widths(layoutColumns(cols(2), 1400, null).columns);
    layoutColumns(cols(3), 1400, null);
    expect(widths(layoutColumns(cols(2), 1400, null).columns)).toEqual(two);
  });
});

describe("layoutColumns — zoom", () => {
  it("the zoomed column fills the row, every other one (leaf included) is a bar", () => {
    const l = layoutColumns(cols(3), 1200, "b");
    expect(l.zoomed).toBe("b");
    expect(l.columns.map((c) => c.bar)).toEqual([true, false, true]);
    expect(widths(l.columns)).toEqual([
      BAR_WIDTH,
      1200 - 2 * BAR_WIDTH,
      BAR_WIDTH,
    ]);
    expect(l.columns.every((c) => !c.handle)).toBe(true);
  });

  it("under its bar a column keeps its unzoomed pane width (it stays laid out)", () => {
    const rest = layoutColumns(cols(2), 1200, null);
    const z = layoutColumns(cols(2), 1200, "b");
    expect(z.columns[0]!.inner).toBe(rest.columns[0]!.inner);
  });

  it("the zoomed column is never narrower than MIN_COLUMN_WIDTH", () => {
    const l = layoutColumns(cols(3), 200, "b");
    expect(l.columns[1]!.width).toBe(MIN_COLUMN_WIDTH);
  });

  it("regression: a zoom id that is not in the row collapses nothing", () => {
    // Closing the maximized column used to leave its id behind, and every
    // remaining column rendered as a bar.
    const l = layoutColumns(cols(2), 1200, "gone");
    expect(l.zoomed).toBeNull();
    expect(l.columns.map((c) => c.bar)).toEqual([false, false]);
    expect(widths(l.columns)).toEqual([600, 600]);
  });

  it("a user-collapsed column zoomed is expanded", () => {
    const l = layoutColumns([col("a", null, true), col("b")], 1000, "a");
    expect(l.columns.map((c) => c.bar)).toEqual([false, true]);
  });
});

describe("dragLayout", () => {
  it("only the dragged column moves; the leaf fills a gap it leaves", () => {
    const start = layoutColumns(cols(3), 1260, null);
    const grown = dragLayout(start, "a", start.columns[0]!.width + 50, 1260);
    expect(grown.columns[0]!.width).toBeCloseTo(
      start.columns[0]!.width + 50,
      6,
    );
    expect(grown.columns[1]!.width).toBe(start.columns[1]!.width);
    expect(grown.columns[2]!.width).toBe(start.columns[2]!.width);
    const shrunk = dragLayout(start, "a", start.columns[0]!.width - 50, 1260);
    expect(shrunk.total).toBeCloseTo(1260, 6);
    expect(shrunk.columns[1]!.width).toBe(start.columns[1]!.width);
  });

  it("never narrower than the minimum", () => {
    const start = layoutColumns(cols(2), 1000, null);
    expect(dragLayout(start, "a", 20, 1000).columns[0]!.width).toBe(200);
  });
});

describe("scrollTarget", () => {
  it("reveals the row's end", () => {
    const l = layoutColumns(cols(4), 1000, null);
    expect(scrollTarget(l, 1000)).toBe(1000);
  });

  it("is 0 when everything fits", () => {
    const l = layoutColumns(cols(2), 1200, null);
    expect(scrollTarget(l, 1200)).toBe(0);
  });

  it("is the start while zoomed", () => {
    const l = layoutColumns(cols(4), 1200, "c");
    expect(scrollTarget(l, 1200)).toBe(0);
  });

  it("leaving a zoom restores the offset from before it, as far as the row reaches", () => {
    const l = layoutColumns(cols(4), 1000, null);
    expect(scrollTarget(l, 1000, 140)).toBe(140);
    expect(scrollTarget(l, 1000, 5000)).toBe(1000);
  });
});

describe("heldInner", () => {
  const [a] = layoutColumns([col("a", 300), col("b", 300)], 0, null).columns;
  const wide = layoutColumns([col("a", 700)], 0, null).columns[0]!;

  it("a narrowing column keeps its old inner width", () => {
    expect(heldInner(a!, wide)).toBe(700);
  });

  it("a growing column lays out at its target at once", () => {
    expect(heldInner(wide, a)).toBe(700);
  });

  it("nothing is held from or into a bar, or for a newcomer", () => {
    const bar = layoutColumns([col("a", 700, true), col("b", 1)], 0, null)
      .columns[0]!;
    expect(heldInner(a!, bar)).toBe(a!.inner);
    expect(heldInner(a!, undefined)).toBe(a!.inner);
  });
});

describe("zoom state", () => {
  const ids = ["a", "b", "c"];
  const route = routeKey(ids);

  it("double-click zooms, records the scroll, and double-click again leaves", () => {
    const z = toggleZoom(null, "b", route, ids, 140);
    expect(z).toEqual({ id: "b", route, scrollFrom: 140 });
    expect(effectiveZoom(z, route, ids)).toBe("b");
    expect(toggleZoom(z, "b", route, ids, 0)).toBeNull();
  });

  it("a bar click while zoomed moves the zoom, keeping the scroll to restore", () => {
    const z = toggleZoom(null, "b", route, ids, 140);
    const moved = moveZoom(z, "a", route, ids);
    expect(moved).toEqual({ id: "a", route, scrollFrom: 140 });
    expect(toggleZoom(z, "c", route, ids, 0)).toEqual({
      id: "c",
      route,
      scrollFrom: 140,
    });
  });

  it("a bar click with no zoom changes nothing", () => {
    expect(moveZoom(null, "a", route, ids)).toBeNull();
  });

  it("regression: opening a pane from the zoomed column ends the zoom", () => {
    // Opening a link from a maximized column used to draw the new column as a
    // 32px bar (the maximize survived the route change).
    const z = toggleZoom(null, "b", route, ids, 0);
    const next = ["a", "b", "d"];
    const nextRoute = routeKey(next);
    expect(effectiveZoom(z, nextRoute, next)).toBeNull();
    const l = layoutColumns(
      next.map((id) => col(id)),
      1200,
      effectiveZoom(z, nextRoute, next),
    );
    expect(l.columns.map((c) => c.bar)).toEqual([false, false, false]);
  });

  it("regression: closing the zoomed column ends the zoom", () => {
    const z = toggleZoom(null, "c", route, ids, 0);
    const next = ["a", "b"];
    expect(effectiveZoom(z, routeKey(next), next)).toBeNull();
  });

  it("a reorder is a route change too", () => {
    const z = toggleZoom(null, "a", route, ids, 0);
    const next = ["b", "a", "c"];
    expect(effectiveZoom(z, routeKey(next), next)).toBeNull();
  });
});
