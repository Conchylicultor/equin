import { liveArm } from "@plugins/network/plugins/live/core";
import { activity } from "@plugins/activity/core";
import { pagesEntityRef } from "@plugins/page/plugins/block-entity/core";

/**
 * Pages, as an arm of the activity space. Declared FROM the block entity, so
 * every field a plugin exposes on a page (starred, agent-written, its tags)
 * is listed in the "Page" band of every list of activity, with no code here.
 */
export const pageActivityArm = liveArm(activity, "page", {
  label: "Page",
  order: 30,
  from: pagesEntityRef,
});
