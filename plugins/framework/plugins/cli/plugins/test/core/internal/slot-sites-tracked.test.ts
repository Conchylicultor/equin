import { expect, test } from "bun:test";
import {
  slotSite,
  slotSitesTracked,
} from "@plugins/framework/plugins/slot-declaration/core";
import { getCreatedSlots } from "@plugins/framework/plugins/slot-declaration/core/testing";

// A `bun test` process tracks slot sites from its first module on
// (`test/track-slot-sites.ts`, imported first by the preload), so no slot in it
// was made untracked — whichever suites ran before this one in the same
// process. Without it, a suite evaluating barrels through plugin-records failed
// or passed depending on what an earlier file had imported.
test("every slot a test process made has a site", () => {
  expect(slotSitesTracked()).toBe(true);
  const untracked = getCreatedSlots().filter((s) => slotSite(s) === undefined);
  expect(untracked.map((s) => s.meta)).toEqual([]);
});
