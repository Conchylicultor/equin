/**
 * The cross-page gap detector (`cross-page-gaps.ts`): a row that leaves one
 * live page and reappears in another within the window, in no page between,
 * is one gap; the duplicate order, a flip in place, a delete, a page handing
 * its rows on and an unchanged rows array are not.
 *
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { createCrossPageGaps, type GapPage } from "./cross-page-gaps";

type Row = { id: string };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const page = (key: string, r: readonly Row[]): GapPage<Row> => ({
  key,
  rows: r,
});
const detector = () => createCrossPageGaps<Row>((r) => r.id, 1000);

describe("cross-page gaps", () => {
  test("a row leaving A, then entering B within the window, is one gap", () => {
    const d = detector();
    const b0 = rows("c");
    expect(d.observe(0, [page("A", rows("a", "b")), page("B", b0)])).toEqual(
      [],
    );
    expect(d.observe(10, [page("A", rows("a")), page("B", b0)])).toEqual([]);
    expect(
      d.observe(250, [page("A", rows("a")), page("B", rows("b", "c"))]),
    ).toEqual([{ id: "b", from: "A", to: "B", ms: 240 }]);
  });

  test("the entering frame first (the duplicate) is no gap", () => {
    const d = detector();
    d.observe(0, [page("A", rows("a", "b")), page("B", rows("c"))]);
    d.observe(10, [page("A", rows("a", "b")), page("B", rows("b", "c"))]);
    d.observe(20, [page("A", rows("a")), page("B", rows("b", "c"))]);
    // Leaving B and coming back to A later is not matched to a stale departure.
    expect(
      d.observe(30, [page("A", rows("a", "b")), page("B", rows("c"))]),
    ).toEqual([]);
  });

  test("both frames in one observation are no gap", () => {
    const d = detector();
    d.observe(0, [page("A", rows("a", "b")), page("B", rows("c"))]);
    expect(
      d.observe(10, [page("A", rows("a")), page("B", rows("b", "c"))]),
    ).toEqual([]);
    // Whichever page is listed first.
    expect(
      d.observe(20, [page("B", rows("c")), page("A", rows("a", "b"))]),
    ).toEqual([]);
  });

  test("a reappearance past the window, or in the same page, closes nothing", () => {
    const d = detector();
    d.observe(0, [page("A", rows("a", "b")), page("B", rows("c"))]);
    d.observe(10, [page("A", rows("a")), page("B", rows("c"))]);
    expect(
      d.observe(1500, [page("A", rows("a")), page("B", rows("b", "c"))]),
    ).toEqual([]);

    const e = detector();
    e.observe(0, [page("A", rows("a", "b"))]);
    e.observe(10, [page("A", rows("a"))]);
    expect(e.observe(20, [page("A", rows("a", "b"))])).toEqual([]);
  });

  test("a deleted row never reappears: nothing is reported", () => {
    const d = detector();
    d.observe(0, [page("A", rows("a", "b"))]);
    d.observe(10, [page("A", rows("a"))]);
    expect(d.observe(2000, [page("A", rows("a"))])).toEqual([]);
  });

  test("a page that leaves hands its rows on — no departure", () => {
    const d = detector();
    d.observe(0, [page("A", rows("a", "b"))]);
    // A split into A1 / A2: A is gone, its rows reappear in the new pages.
    d.observe(10, []);
    expect(
      d.observe(20, [page("A1", rows("a")), page("A2", rows("b"))]),
    ).toEqual([]);
  });

  test("a row entering a page first seen closes a gap", () => {
    const d = detector();
    d.observe(0, [page("A", rows("a", "b"))]);
    d.observe(10, [page("A", rows("a"))]);
    expect(d.observe(60, [page("A", rows("a")), page("C", rows("b"))])).toEqual(
      [{ id: "b", from: "A", to: "C", ms: 50 }],
    );
  });

  test("an unchanged rows array is not diffed", () => {
    let calls = 0;
    const d = createCrossPageGaps<Row>((r) => {
      calls++;
      return r.id;
    });
    const a = rows("a", "b", "c");
    d.observe(0, [page("A", a)]);
    expect(calls).toBe(3);
    d.observe(10, [page("A", a)]);
    expect(calls).toBe(3);
  });
});
