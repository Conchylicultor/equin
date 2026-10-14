/**
 * The tags exposure: a page's tags reach every list of blocks under the field
 * id `tags` (the pages sidebar's id before it was derived — saved views name
 * it), as a tags-typed string array; an untagged page reads NULL (no tags).
 *
 * Run: `./singularity test plugins/page/plugins/tags/core/resources.test.ts`.
 */

import { expect, test } from "bun:test";
import { pageTagAssignmentShape } from "./resources";

test("tagIds is exposed as `tags`, a tags field reading NULL when untagged", () => {
  const exposure = pageTagAssignmentShape.exposure;
  expect(exposure.parent.name).toBe("page_blocks");
  expect(Object.values(exposure.fields).map((f) => f.id)).toEqual(["tags"]);
  expect(exposure.fields.tagIds).toMatchObject({
    id: "tags",
    label: "Tags",
    typeId: "tags",
    absent: null,
  });
  expect(exposure.row.parse({ tagIds: null })).toEqual({ tagIds: null });
  expect(exposure.row.parse({ tagIds: ["tag-1"] })).toEqual({
    tagIds: ["tag-1"],
  });
});
