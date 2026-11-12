import { describe, expect, it } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  nextPreview,
  previewDropDest,
  previewOrder,
  resolveGroupDrop,
} from "./drag-preview";
import type { RankReorderItem } from "./resolve-sortable-drop";

const item = (id: string, group: string, i: number): RankReorderItem => ({
  id,
  rank: Rank.from(`a${i}`),
  group,
});

// Two groups: A = a1 a2 a3, B = b1 b2.
const ORDERED: RankReorderItem[] = [
  item("a1", "A", 1),
  item("a2", "A", 2),
  item("a3", "A", 3),
  item("b1", "B", 1),
  item("b2", "B", 2),
];
const ids = (items: readonly RankReorderItem[]) =>
  items.map((i) => `${i.id}:${i.group}`);

const box = (top: number) => ({ top, left: 0, width: 100, height: 20 });

describe("previewOrder", () => {
  it("is the order unchanged with no preview", () => {
    expect(ids(previewOrder(ORDERED, null))).toEqual(ids(ORDERED));
  });

  it("moves the row beside its anchor, carrying the new group", () => {
    expect(
      ids(
        previewOrder(ORDERED, {
          id: "a2",
          group: "B",
          targetId: "b2",
          zone: "before",
        }),
      ),
    ).toEqual(["a1:A", "a3:A", "b1:B", "a2:B", "b2:B"]);
    expect(
      ids(
        previewOrder(ORDERED, {
          id: "a2",
          group: "B",
          targetId: "b2",
          zone: "after",
        }),
      ),
    ).toEqual(["a1:A", "a3:A", "b1:B", "b2:B", "a2:B"]);
  });

  it("puts an unanchored row at its group's head, or the end for an empty group", () => {
    expect(ids(previewOrder(ORDERED, { id: "a2", group: "B" }))).toEqual([
      "a1:A",
      "a3:A",
      "a2:B",
      "b1:B",
      "b2:B",
    ]);
    expect(ids(previewOrder(ORDERED, { id: "b1", group: "C" }))).toEqual([
      "a1:A",
      "a2:A",
      "a3:A",
      "b2:B",
      "b1:C",
    ]);
  });
});

describe("nextPreview", () => {
  const geometry = {
    layout: "vertical" as const,
    dragged: box(0),
    over: box(40),
  };

  it("keeps the preview over nothing, and over the group the row is shown in", () => {
    expect(nextPreview("a1", "A", null, null, geometry)).toEqual({
      kind: "keep",
    });
    expect(
      nextPreview(
        "a1",
        "A",
        null,
        { kind: "row", id: "a2", group: "A" },
        geometry,
      ),
    ).toEqual({ kind: "keep" });
    const inB = {
      id: "a1",
      group: "B",
      targetId: "b1",
      zone: "before" as const,
    };
    expect(
      nextPreview(
        "a1",
        "A",
        inB,
        { kind: "row", id: "b2", group: "B" },
        geometry,
      ),
    ).toEqual({ kind: "keep" });
  });

  it("previews the row beside a row of another group, on the side of its centre", () => {
    expect(
      nextPreview(
        "a1",
        "A",
        null,
        { kind: "row", id: "b1", group: "B" },
        geometry,
      ),
    ).toEqual({
      kind: "set",
      preview: { id: "a1", group: "B", targetId: "b1", zone: "before" },
    });
    expect(
      nextPreview(
        "a1",
        "A",
        null,
        { kind: "row", id: "b1", group: "B" },
        { ...geometry, dragged: box(60) },
      ),
    ).toEqual({
      kind: "set",
      preview: { id: "a1", group: "B", targetId: "b1", zone: "after" },
    });
  });

  it("previews unanchored over another group's empty band, and goes home over its own", () => {
    expect(
      nextPreview(
        "a1",
        "A",
        null,
        { kind: "group", group: "C", preview: true },
        geometry,
      ),
    ).toEqual({ kind: "set", preview: { id: "a1", group: "C" } });
    expect(
      nextPreview(
        "a1",
        "A",
        { id: "a1", group: "C" },
        { kind: "row", id: "a2", group: "A" },
        geometry,
      ),
    ).toEqual({ kind: "set", preview: null });
    expect(
      nextPreview(
        "a1",
        "A",
        { id: "a1", group: "C" },
        { kind: "other" },
        geometry,
      ),
    ).toEqual({ kind: "set", preview: null });
  });

  it("keeps the row where it is over a target that draws no row (a collapsed group's header)", () => {
    const inB = { id: "a1", group: "B" };
    expect(
      nextPreview(
        "a1",
        "A",
        inB,
        { kind: "group", group: "C", preview: false },
        geometry,
      ),
    ).toEqual({ kind: "keep" });
    expect(
      nextPreview(
        "a1",
        "A",
        null,
        { kind: "group", group: "C", preview: false },
        geometry,
      ),
    ).toEqual({ kind: "keep" });
  });
});

describe("previewDropDest", () => {
  it("anchors after the row above it in its new group", () => {
    const previewed = previewOrder(ORDERED, {
      id: "a2",
      group: "B",
      targetId: "b2",
      zone: "before",
    });
    expect(previewDropDest(previewed, "a2", "a2")).toEqual({
      group: "B",
      targetId: "b1",
      zone: "after",
    });
  });

  it("follows the slide the strategy shows: dropped over the row below, after it", () => {
    const previewed = previewOrder(ORDERED, { id: "a2", group: "B" });
    expect(previewDropDest(previewed, "a2", "b2")).toEqual({
      group: "B",
      targetId: "b2",
      zone: "after",
    });
  });

  it("anchors before the next row at the head, and not at all alone", () => {
    expect(
      previewDropDest(
        previewOrder(ORDERED, { id: "a2", group: "B" }),
        "a2",
        null,
      ),
    ).toEqual({ group: "B", targetId: "b1", zone: "before" });
    expect(
      previewDropDest(
        previewOrder(ORDERED, { id: "a2", group: "C" }),
        "a2",
        "a2",
      ),
    ).toEqual({ group: "C" });
  });
});

describe("resolveGroupDrop", () => {
  it("lands after the group below, before the group above, nowhere on itself", () => {
    expect(resolveGroupDrop(["x", "y", "z"], "x", "z")).toEqual({
      targetKey: "z",
      zone: "after",
    });
    expect(resolveGroupDrop(["x", "y", "z"], "z", "x")).toEqual({
      targetKey: "x",
      zone: "before",
    });
    expect(resolveGroupDrop(["x", "y"], "x", "x")).toBeNull();
  });
});
