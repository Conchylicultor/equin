import { describe, expect, it } from "bun:test";
import {
  BAR_WIDTH,
  HANDLE_WIDTH,
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

  it("columns wider than the row overflow: every column keeps its own width", () => {
    const l = layoutColumns(
      [col("a", 300), col("b", 440), col("c", 560), col("d", 520)],
      1200,
      null,
    );
    expect(widths(l.columns)).toEqual([300, 440, 560, 520]);
    expect(l.total).toBe(1820);
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

describe("scrollTarget", () => {
  it("reveals the row's end", () => {
    const l = layoutColumns(
      [col("a", 300), col("b", 440), col("c", 560), col("d", 520)],
      1200,
      null,
    );
    expect(scrollTarget(l, 1200)).toBe(620);
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
    const l = layoutColumns(
      [col("a", 300), col("b", 440), col("c", 560), col("d", 520)],
      1200,
      null,
    );
    expect(scrollTarget(l, 1200, 140)).toBe(140);
    expect(scrollTarget(l, 1200, 5000)).toBe(620);
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
