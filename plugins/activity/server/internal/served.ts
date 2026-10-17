import { serveUnionCollection } from "@plugins/network/plugins/live/server";
import { activity } from "../../core";

/**
 * The activity space, served: every kind of record is one arm of the
 * `activity` union window, bound by its own plugin through
 * `activityServed.arm(arm, { from, id, base, extra?, where? })` — this plugin
 * never names one. `id` is the union's own: the arm's primary key.
 */
export const activityServed = serveUnionCollection(activity, {
  derive: { id: { reads: [], bind: (_reads, { id }) => id } },
});
