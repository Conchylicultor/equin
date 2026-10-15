import { describe, expect, it } from "bun:test";
import type { ComponentType } from "react";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { ViewSourceEntry, ViewTypeMeta } from "../../core";
import { usableTypes } from "./usable-types";

const Icon: ComponentType<{ className?: string }> = () => null;

const table = { type: "table", title: "Table", icon: Icon, order: 1 };
const gallery = { type: "gallery", title: "Gallery", icon: Icon, order: 0 };
const board = { type: "board", title: "Board", icon: Icon, order: 2 };
const contributions = [
  table,
  gallery,
  board,
] as unknown as SealContributions<ViewTypeMeta>[];

const entry: ViewSourceEntry = { contributions };

const typesOf = (entry: ViewSourceEntry) =>
  usableTypes(entry).map((c) => c.type);

describe("usableTypes", () => {
  it("offers every registered type when there is no whitelist", () => {
    expect(typesOf(entry)).toEqual(["gallery", "table", "board"]);
  });

  it("applies the entry's `views` whitelist", () => {
    expect(typesOf({ ...entry, views: ["board", "table"] })).toEqual([
      "table",
      "board",
    ]);
  });

  it("orders by `order`, then title", () => {
    const unordered = [
      { type: "b", title: "B", icon: Icon },
      { type: "a", title: "A", icon: Icon },
    ] as unknown as SealContributions<ViewTypeMeta>[];
    expect(typesOf({ contributions: unordered })).toEqual(["a", "b"]);
  });
});
