/**
 * `pages.tree.v2`'s fields, derived: the row lists its tree parent (`pageId`,
 * a level is `where: { pageId }`), its `title` (searched server-side) and
 * `editedAt` (the pages sidebar's Recent section sorts and filters on it — a
 * saved view names it); it carries every `PageRow` field; it is a tree
 * (`pageId` / `docRank`); and the rows reach the `page_blocks` entity, so
 * every exposure of a block (starred, origin, tags — pinned in their own
 * plugins) folds into them.
 *
 * Run: `./equin test plugins/page/plugins/editor/core/pages-tree-fields.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { pagesTree } from "./resources";

describe("pages.tree.v2 fields", () => {
  test("lists the parent, the title and editedAt — the latter two sortable", () => {
    expect(Object.keys(pagesTree.fields)).toEqual([
      "pageId",
      "title",
      "editedAt",
    ]);
    expect(pagesTree.fields.editedAt).toMatchObject({
      label: "Edited",
      typeId: "date",
      domain: "instant",
      sortable: true,
    });
    expect(pagesTree.fields.title).toMatchObject({
      domain: "text",
      sortable: true,
    });
    expect(pagesTree.fields.pageId).toMatchObject({ domain: "text" });
  });

  test("is a tree over pageId, ranked by docRank", () => {
    expect(pagesTree.tree).toEqual({ parent: "pageId", rank: "docRank" });
  });

  test("carries the PageRow fields and reaches the page_blocks entity", () => {
    expect(([...pagesTree.rowKeys] as string[]).sort()).toEqual(
      [
        "title",
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
