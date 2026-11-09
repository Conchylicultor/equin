import { describe, expect, it } from "bun:test";
import {
  BAR_WIDTH,
  HANDLE_WIDTH,
  columnFloor,
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

const col = (id: string, width: number, collapsed = false): ColumnInput => ({
  id,
  width,
  collapsed,
});

const widths = (cols: { width: number }[]) => cols.map((c) => c.width);

describe("layoutColumns — scroll sizing", () => {
  it("the leaf grows to fill spare space, never below its own width", () => {
    const l = layoutColumns([col("a", 300), col("b", 440)], 1200, null);
    expect(widths(l.columns)).toEqual([300, 900]);
    expect(l.total).toBe(1200);
  });

  it("columns that fit are not compressed", () => {
    const l = layoutColumns(
      [col("a", 320), col("b", 480), col("c", 600)],
      1400,
      null,
    );
    expect(widths(l.columns)).toEqual([320, 480, 600]);
  });

  it("three columns too wide for the row all compress in proportion and fill it exactly", () => {
    // Floors: 320 → 240, 480 → 312, 600 → 390 (Σ 942 ≤ 1136): all three stay.
    const l = layoutColumns(
      [col("a", 320), col("b", 480), col("c", 600)],
      1136,
      null,
    );
    const t = (1400 - 1136) / (1400 - 942);
    expect(l.columns[0]!.width).toBeCloseTo(320 - t * 80, 6);
    expect(l.columns[1]!.width).toBeCloseTo(480 - t * 168, 6);
    expect(l.columns[2]!.width).toBeCloseTo(600 - t * 210, 6);
    expect(l.total).toBeCloseTo(1136, 6);
    expect(scrollTarget(l, 1136)).toBeCloseTo(0, 6);
  });

  it("five columns: the oldest sit at their floor, scrolled off; the trailing window fills the row exactly", () => {
    // Floors 240, 312, 390, 390, 260: the last three (1040) fit 1136, a
    // fourth (+312) does not.
    const l = layoutColumns(
      [
        col("a", 320),
        col("b", 480),
        col("c", 600),
        col("d", 600),
        col("e", 400),
      ],
      1136,
      null,
    );
    const t = (1600 - 1136) / (1600 - 1040);
    expect(widths(l.columns).slice(0, 2)).toEqual([240, 312]);
    expect(l.columns[2]!.width).toBeCloseTo(600 - t * 210, 6);
    expect(l.columns[3]!.width).toBeCloseTo(600 - t * 210, 6);
    expect(l.columns[4]!.width).toBeCloseTo(400 - t * 140, 6);
    // The row's end puts the window's left edge exactly on the viewport's.
    expect(scrollTarget(l, 1136)).toBeCloseTo(240 + 312, 6);
    expect(l.total - scrollTarget(l, 1136)).toBeCloseTo(1136, 6);
  });

  it("a window that fits at full width keeps it, the leaf filling the rest", () => {
    // Floors 240, 260, 260: a + b + c floors 760 > 700, b + c 520 fit; b + c
    // at full width (800) do not, so they compress to 700.
    const fitted = layoutColumns(
      [col("a", 320), col("b", 400), col("c", 400)],
      700,
      null,
    );
    expect(widths(fitted.columns)).toEqual([240, 350, 350]);
    // Floors 240, 240: a's (240) + b's would not fit 400 → b alone, at its
    // own width 300, the leaf filling to 400.
    const l = layoutColumns([col("a", 320), col("b", 300)], 400, null);
    expect(widths(l.columns)).toEqual([240, 400]);
  });

  it("a leaf wider than the row takes its floor and the row scrolls", () => {
    const l = layoutColumns([col("a", 300), col("b", 2000)], 1000, null);
    expect(widths(l.columns)).toEqual([240, 1300]);
    expect(scrollTarget(l, 1000)).toBe(540);
  });

  it("a dragged (fixed) column is never compressed; a bar counts 32 fixed", () => {
    const l = layoutColumns(
      [
        { id: "a", width: 320, collapsed: true },
        { id: "b", width: 480, collapsed: false, fixed: true },
        col("c", 600),
      ],
      900,
      null,
    );
    // Floors 32, 480, 390 (Σ 902 > 900): b + c (870) fit, a sits at its bar.
    expect(l.columns[0]!.width).toBe(BAR_WIDTH);
    expect(l.columns[1]!.width).toBe(480);
    expect(l.columns[2]!.width).toBeCloseTo(420, 6);
    expect(l.total - scrollTarget(l, 900)).toBeCloseTo(900, 6);
  });

  it("an unmeasured row lays every column at its own width", () => {
    const l = layoutColumns([col("a", 320), col("b", 480)], 0, null);
    expect(widths(l.columns)).toEqual([320, 480]);
  });

  it("columnFloor: 65% of the width, never below 240, never above the width", () => {
    expect(columnFloor(600)).toBe(390);
    expect(columnFloor(320)).toBe(240);
    expect(columnFloor(200)).toBe(200);
  });

  it("a width never depends on history: opening and closing gives the same widths back", () => {
    const open = layoutColumns(
      [col("a", 300), col("b", 440), col("c", 560)],
      1400,
      null,
    );
    const closed = layoutColumns([col("a", 300), col("b", 440)], 1400, null);
    expect(open.columns[1]!.width).toBe(440);
    expect(closed.columns[1]!.width).toBe(1100);
    const reopened = layoutColumns(
      [col("a", 300), col("b", 440), col("c", 560)],
      1400,
      null,
    );
    expect(widths(reopened.columns)).toEqual(widths(open.columns));
  });

  it("dividers on every non-leaf column; the inner width excludes it", () => {
    const l = layoutColumns([col("a", 300), col("b", 440)], 0, null);
    expect(l.columns.map((c) => c.handle)).toEqual([true, false]);
    expect(l.columns[0]!.inner).toBe(300 - HANDLE_WIDTH);
    expect(l.columns[1]!.inner).toBe(440);
  });

  it("a user-collapsed column is a bar; the leaf never is", () => {
    const l = layoutColumns(
      [col("a", 300, true), col("b", 440, true)],
      1000,
      null,
    );
    expect(l.columns.map((c) => c.bar)).toEqual([true, false]);
    expect(widths(l.columns)).toEqual([BAR_WIDTH, 1000 - BAR_WIDTH]);
    expect(l.columns[0]!.handle).toBe(false);
  });
});

describe("layoutColumns — zoom", () => {
  it("the zoomed column fills the row, every other one (leaf included) is a bar", () => {
    const l = layoutColumns(
      [col("a", 300), col("b", 440), col("c", 560)],
      1200,
      "b",
    );
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
    const rest = layoutColumns([col("a", 300), col("b", 440)], 1200, null);
    const z = layoutColumns([col("a", 300), col("b", 440)], 1200, "b");
    expect(z.columns[0]!.inner).toBe(rest.columns[0]!.inner);
  });

  it("the zoomed column is never narrower than its own width", () => {
    const l = layoutColumns([col("a", 300), col("b", 900)], 600, "b");
    expect(l.columns[1]!.width).toBe(900);
  });

  it("regression: a zoom id that is not in the row collapses nothing", () => {
    // Closing the maximized column used to leave its id behind, and every
    // remaining column rendered as a bar.
    const l = layoutColumns([col("a", 300), col("b", 440)], 1200, "gone");
    expect(l.zoomed).toBeNull();
    expect(l.columns.map((c) => c.bar)).toEqual([false, false]);
    expect(widths(l.columns)).toEqual([300, 900]);
  });

  it("a user-collapsed column zoomed is expanded", () => {
    const l = layoutColumns([col("a", 300, true), col("b", 440)], 1000, "a");
    expect(l.columns.map((c) => c.bar)).toEqual([false, true]);
  });
});

describe("dragLayout", () => {
  it("only the dragged column moves; the leaf fills a gap it leaves", () => {
    const start = layoutColumns(
      [col("a", 320), col("b", 480), col("c", 600)],
      1136,
      null,
    );
    const grown = dragLayout(start, "a", start.columns[0]!.width + 50, 1136);
    expect(grown.columns[0]!.width).toBeCloseTo(
      start.columns[0]!.width + 50,
      6,
    );
    expect(grown.columns[1]!.width).toBe(start.columns[1]!.width);
    expect(grown.columns[2]!.width).toBe(start.columns[2]!.width);
    const shrunk = dragLayout(start, "a", start.columns[0]!.width - 50, 1136);
    expect(shrunk.total).toBeCloseTo(1136, 6);
    expect(shrunk.columns[1]!.width).toBe(start.columns[1]!.width);
  });

  it("never narrower than the minimum", () => {
    const start = layoutColumns([col("a", 320), col("b", 480)], 1000, null);
    expect(dragLayout(start, "a", 20, 1000).columns[0]!.width).toBe(200);
  });
});

describe("scrollTarget", () => {
  it("reveals the row's end", () => {
    const l = layoutColumns([col("a", 300), col("b", 2000)], 1000, null);
    expect(scrollTarget(l, 1000)).toBe(540);
  });

  it("is 0 when everything fits", () => {
    const l = layoutColumns([col("a", 300), col("b", 440)], 1200, null);
    expect(scrollTarget(l, 1200)).toBe(0);
  });

  it("is the start while zoomed", () => {
    const l = layoutColumns(
      [col("a", 300), col("b", 440), col("c", 560), col("d", 520)],
      1200,
      "c",
    );
    expect(scrollTarget(l, 1200)).toBe(0);
  });

  it("leaving a zoom restores the offset from before it, as far as the row reaches", () => {
    const l = layoutColumns([col("a", 300), col("b", 2000)], 1000, null);
    expect(scrollTarget(l, 1000, 140)).toBe(140);
    expect(scrollTarget(l, 1000, 5000)).toBe(540);
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
      next.map((id) => col(id, 400)),
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
