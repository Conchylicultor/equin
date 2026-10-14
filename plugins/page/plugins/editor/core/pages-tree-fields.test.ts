/**
 * `pages.tree`'s fields, derived: the one field the row lists of itself is
 * `editedAt` (the pages sidebar's Recent section sorts and filters on it — a
 * saved view names it), the row carries every `PageRow` field, and the rows
 * reach the `page_blocks` entity, so every exposure of a block (starred,
 * origin, tags — pinned in their own plugins) folds into them.
 *
 * Run: `./singularity test plugins/page/plugins/editor/core/pages-tree-fields.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { pagesTree } from "./resources";

describe("pages.tree fields", () => {
  test("lists editedAt, a sortless instant", () => {
    expect(Object.keys(pagesTree.fields)).toEqual(["editedAt"]);
    expect(pagesTree.fields.editedAt).toMatchObject({
      label: "Edited",
      typeId: "date",
      domain: "instant",
    });
  });

  test("carries the PageRow fields and reaches the page_blocks entity", () => {
    expect(([...pagesTree.rowKeys] as string[]).sort()).toEqual(
      [
        "editedAt",
        "id",
        "pageId",
        "parentId",
        "type",
        "data",
        "rank",
        "expanded",
        "createdAt",
        "updatedAt",
        "docRank",
      ].sort(),
    );
    expect(Object.keys(pagesTree.exposes ?? {})).toEqual(["base"]);
    expect(pagesTree.exposes?.base?.name).toBe("page_blocks");
  });
});
