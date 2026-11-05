import { describe, expect, test } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { Block } from "../../core";
import type { FlatBlock, FrameSpan } from "./block-frames";
import { BLOCK_GUTTER, BLOCK_INDENT } from "./page-column";
import { resolveSelectionBands, type RowOverhang } from "./selection-bands";

function block(id: string): Block {
  return {
    id,
    pageId: "page-1",
    parentId: null,
    type: "text",
    data: { text: [] },
    rank: Rank.from("a1"),
    expanded: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** A flatten from `id@depth` shorthand — `"b1"`, `"b2@1"`. */
function flatten(...spec: string[]): FlatBlock[] {
  return spec.map((s) => {
    const [id, depth] = s.split("@");
    return {
      block: block(id!),
      depth: Number(depth ?? 0),
      childCount: 0,
      ordinal: 1,
      firstVisibleChildType: null,
    };
  });
}

function frame(flat: FlatBlock[], start: number, end: number): FrameSpan {
  const entry = flat[start]!;
  return { block: entry.block, depth: entry.depth, start, end };
}

const left = (depth: number) => BLOCK_GUTTER + depth * BLOCK_INDENT;

const NONE: ReadonlyMap<string, RowOverhang> = new Map();

describe("resolveSelectionBands", () => {
  test("nothing selected paints nothing", () => {
    expect(
      resolveSelectionBands(flatten("b1", "b2"), [], new Set(), NONE),
    ).toEqual([]);
  });

  test("one block is one band, rounded on both ends", () => {
    const flat = flatten("b1", "b2", "b3");
    expect(resolveSelectionBands(flat, [], new Set(["b2"]), NONE)).toEqual([
      {
        key: "selection:1",
        start: 1,
        end: 1,
        left: left(0),
        right: 0,
        roundTop: true,
        roundBottom: true,
      },
    ]);
  });

  test("consecutive blocks merge into ONE band — the whole point", () => {
    const flat = flatten("b1", "b2", "b3", "b4");
    expect(
      resolveSelectionBands(flat, [], new Set(["b2", "b3"]), NONE),
    ).toEqual([
      {
        key: "selection:1",
        start: 1,
        end: 2,
        left: left(0),
        right: 0,
        roundTop: true,
        roundBottom: true,
      },
    ]);
  });

  test("a gap in the selection splits it into two rounded runs", () => {
    const flat = flatten("b1", "b2", "b3", "b4");
    expect(
      resolveSelectionBands(flat, [], new Set(["b1", "b4"]), NONE),
    ).toEqual([
      {
        key: "selection:0",
        start: 0,
        end: 0,
        left: left(0),
        right: 0,
        roundTop: true,
        roundBottom: true,
      },
      {
        key: "selection:3",
        start: 3,
        end: 3,
        left: left(0),
        right: 0,
        roundTop: true,
        roundBottom: true,
      },
    ]);
  });

  test("a depth step splits a run into touching bands, rounded only at the ends", () => {
    const flat = flatten("b1", "b2@1");
    expect(
      resolveSelectionBands(flat, [], new Set(["b1", "b2"]), NONE),
    ).toEqual([
      {
        key: "selection:0",
        start: 0,
        end: 0,
        left: left(0),
        right: 0,
        roundTop: true,
        roundBottom: false,
      },
      {
        key: "selection:1",
        start: 1,
        end: 1,
        left: left(1),
        right: 0,
        roundTop: false,
        roundBottom: true,
      },
    ]);
  });

  test("a selected container paints its whole frame span", () => {
    const flat = flatten("c1", "b2@1", "b3@1", "b4");
    const spans = [frame(flat, 0, 2)];
    expect(resolveSelectionBands(flat, spans, new Set(["c1"]), NONE)).toEqual([
      {
        key: "selection:0",
        start: 0,
        end: 2,
        left: left(0),
        right: 0,
        roundTop: true,
        roundBottom: true,
      },
    ]);
  });

  test("a selection nested inside a selected container paints once, at the outer edge", () => {
    const flat = flatten("c1", "b2@1", "b3@1");
    const spans = [frame(flat, 0, 2)];
    expect(
      resolveSelectionBands(flat, spans, new Set(["c1", "b2"]), NONE),
    ).toEqual([
      {
        key: "selection:0",
        start: 0,
        end: 2,
        left: left(0),
        right: 0,
        roundTop: true,
        roundBottom: true,
      },
    ]);
  });

  test("a container's span merges with the block selected right after it", () => {
    const flat = flatten("c1", "b2@1", "b3");
    const spans = [frame(flat, 0, 1)];
    expect(
      resolveSelectionBands(flat, spans, new Set(["c1", "b3"]), NONE),
    ).toEqual([
      {
        key: "selection:0",
        start: 0,
        end: 2,
        left: left(0),
        right: 0,
        roundTop: true,
        roundBottom: true,
      },
    ]);
  });

  test("a selected block with no visible row paints nothing", () => {
    const flat = flatten("b1", "b2");
    expect(
      resolveSelectionBands(flat, [], new Set(["hidden-child"]), NONE),
    ).toEqual([]);
  });

  test("a wide line widens its own band, split from the column-wide line above", () => {
    const flat = flatten("b1", "t2", "b3");
    const extents = new Map([["t2", { left: 30, right: 40 }]]);
    expect(
      resolveSelectionBands(flat, [], new Set(["b1", "t2", "b3"]), extents),
    ).toEqual([
      {
        key: "selection:0",
        start: 0,
        end: 0,
        left: left(0),
        right: 0,
        roundTop: true,
        roundBottom: false,
      },
      {
        key: "selection:1",
        start: 1,
        end: 1,
        left: left(0) - 30,
        right: -40,
        roundTop: false,
        roundBottom: false,
      },
      {
        key: "selection:2",
        start: 2,
        end: 2,
        left: left(0),
        right: 0,
        roundTop: false,
        roundBottom: true,
      },
    ]);
  });

  test("a line no wider than the column keeps the column band", () => {
    const flat = flatten("b1", "t2");
    const extents = new Map([["t2", { left: 0, right: 0 }]]);
    expect(
      resolveSelectionBands(flat, [], new Set(["b1", "t2"]), extents),
    ).toEqual([
      {
        key: "selection:0",
        start: 0,
        end: 1,
        left: left(0),
        right: 0,
        roundTop: true,
        roundBottom: true,
      },
    ]);
  });

  test("an unselected wide line paints nothing", () => {
    const flat = flatten("b1", "t2");
    const extents = new Map([["t2", { left: 40, right: 40 }]]);
    expect(resolveSelectionBands(flat, [], new Set(["b1"]), extents)).toEqual([
      {
        key: "selection:0",
        start: 0,
        end: 0,
        left: left(0),
        right: 0,
        roundTop: true,
        roundBottom: true,
      },
    ]);
  });
});
