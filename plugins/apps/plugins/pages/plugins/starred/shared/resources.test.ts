/**
 * The starred exposure: the pages sidebar's Favorites view filters on the
 * field id `starred` (`starred is true`), so the id is pinned — a boolean, the
 * side row's presence.
 *
 * Run: `./singularity test plugins/apps/plugins/pages/plugins/starred`.
 */

import { expect, test } from "bun:test";
import { starredPageShape } from "./resources";

test("starred is exposed as the presence boolean `starred` of a block", () => {
  const exposure = starredPageShape.exposure;
  expect(exposure.parent.name).toBe("page_blocks");
  expect(Object.values(exposure.fields).map((f) => f.id)).toEqual(["starred"]);
  expect(exposure.fields.starred).toMatchObject({
    label: "Starred",
    typeId: "bool",
    absent: false,
    presence: { values: null },
  });
});
