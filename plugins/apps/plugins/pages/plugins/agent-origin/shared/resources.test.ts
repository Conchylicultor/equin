/**
 * The origin exposure: the pages sidebar's Private / Scratch sections filter
 * on the field id `origin` (`origin is user` / `origin is agent`), so the id,
 * its two values and what a page with no marker reads are pinned.
 *
 * Run: `./singularity test plugins/apps/plugins/pages/plugins/agent-origin`.
 */

import { expect, test } from "bun:test";
import { agentPageShape } from "./resources";

test("origin is exposed as agent | user, user where the page has no marker", () => {
  const exposure = agentPageShape.exposure;
  expect(exposure.parent.name).toBe("page_blocks");
  expect(Object.values(exposure.fields).map((f) => f.id)).toEqual(["origin"]);
  expect(exposure.fields.origin).toMatchObject({
    label: "Origin",
    absent: "user",
    presence: { values: { present: "agent", absent: "user" } },
    options: { user: { label: "Private" }, agent: { label: "Scratch" } },
  });
});
