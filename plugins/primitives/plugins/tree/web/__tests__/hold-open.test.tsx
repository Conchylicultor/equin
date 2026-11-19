import { describe, it, expect, afterEach } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { useTreeModel } from "../internal/use-tree-model";
import type { TreeItem } from "../internal/types";

/**
 * `holdOpen` draws a source's search hits open without touching the open set:
 * the painted lines show every child, while `openKeys` — what row-fold reads a
 * toggle from — stays `rows[].expanded`, the user's.
 */

afterEach(cleanup);

const [r1, r2] = Rank.nBetween(null, null, 2);
const row = (id: string, parentId: string | null, rank = r1!): TreeItem => ({
  id,
  parentId,
  rank,
  expanded: false,
});
const rows = [row("p", null), row("p1", "p"), row("q", null, r2)];

function model(holdOpen: boolean) {
  return renderHook(() =>
    useTreeModel({
      rows,
      selectedId: undefined,
      onSelect: () => {},
      setExpanded: () => {},
      holdOpen,
    }),
  ).result.current;
}

describe("useTreeModel holdOpen", () => {
  it("draws every node open", () => {
    expect(model(false).orderedIds).toEqual(["p", "q"]);
    expect(model(true).orderedIds).toEqual(["p", "p1", "q"]);
  });

  it("leaves the open set the user's", () => {
    expect([...model(true).openKeys]).toEqual([]);
  });
});
