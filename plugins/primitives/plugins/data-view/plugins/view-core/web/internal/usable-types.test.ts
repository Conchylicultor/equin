import { describe, expect, it } from "bun:test";
import type { ComponentType } from "react";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { ViewSourceEntry, ViewTypeMeta } from "../../core";
import { usableTypes } from "./usable-types";

const Icon: ComponentType<{ className?: string }> = () => null;

// In the order the host hands them — the view-type slot's layout order.
const gallery = { type: "gallery", title: "Gallery", icon: Icon };
const table = { type: "table", title: "Table", icon: Icon };
const board = { type: "board", title: "Board", icon: Icon };
const contributions = [
  gallery,
  table,
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

  it("keeps the order the host lists the contributions in (the slot layout)", () => {
    const listed = [
      { type: "b", title: "B", icon: Icon },
      { type: "a", title: "A", icon: Icon },
    ] as unknown as SealContributions<ViewTypeMeta>[];
    expect(typesOf({ contributions: listed })).toEqual(["b", "a"]);
  });
});
