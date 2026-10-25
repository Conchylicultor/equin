import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { pluginHealthReviewsEntityRef } from "../core";

// The recorded reviews, as a live collection over `plugin_health_reviews`: a
// bounded window (by axis, 50 / max 200) plus its `:rows` point sibling. The
// plugin pane scopes it to one plugin with `where: { pluginId }` — the server
// filters, so a tab never ships every plugin's reviews to count one plugin's.
// The table holds at most one row per (pluginId, axis) — the unique-index
// conflict target a re-review UPDATEs in place — so one plugin's window holds
// one row per axis it was reviewed along.
export const pluginHealthReviews = liveCollection("plugin-health-reviews", {
  from: pluginHealthReviewsEntityRef,
  pick: ["pluginId", "axis"],
  carry: { pick: ["id", "commitHash", "conversationId", "createdAt"] },
  // Its wire rows stay the table's own columns: no extension exposes a review.
  baseExposures: false,
  id: "id",
  sortable: ["axis"],
  default: { orderBy: [["axis", "asc"]], limit: 50 },
  maxLimit: 200,
});

/**
 * How far one review has gone stale: commits that touched the plugin's folder
 * on `main` since the reviewed commit, and whether one of its public barrels
 * (`web` / `server` / `core` `index.ts`) changed since. A function of the
 * reviewed commit and main's HEAD only — git, no Postgres.
 */
export const PluginStalenessSchema = z.object({
  commitsSince: z.number(),
  apiChanged: z.boolean(),
});
export type PluginStaleness = z.infer<typeof PluginStalenessSchema>;

/**
 * One review's staleness, keyed by the plugin and the commit it was reviewed
 * at (two reviews at one commit share a tuple). External, `notified` by every
 * tracked ref advance: the walk ends at main's HEAD, so a moved HEAD is the one
 * thing that changes the answer. On demand — two git walks per tuple, read
 * only while a plugin's Health section is open.
 *
 * Refused (an answer about the stored commit, never retried):
 * - `invalid-commit` — the stored hash is not a hex sha (it reaches `git` as
 *   an argv entry, so nothing else is passed through);
 * - `unknown-commit` — git cannot resolve it in main's checkout (gc'd, or
 *   recorded from a branch since pruned).
 */
export const pluginStaleness = liveValue("plugin-health.staleness", {
  schema: PluginStalenessSchema,
  params: ["pluginId", "commitHash"],
  load: "on-demand",
  refusals: ["invalid-commit", "unknown-commit"],
});

/**
 * The tasks one review filed (`propose_task`), counted by status. Counts, not
 * the task rows: the section shows only how many are open / dropped / held,
 * and a review's task list grows with every re-review along its axis, so the
 * payload stays three numbers however many tasks it filed.
 */
export const ReviewTaskCountsSchema = z.object({
  open: z.number(),
  dropped: z.number(),
  held: z.number(),
});
export type ReviewTaskCounts = z.infer<typeof ReviewTaskCountsSchema>;

/** {@link ReviewTaskCountsSchema} per review id — db, over the review↔task link and the tasks it names. */
export const reviewTaskCounts = liveValue("plugin-health.review-tasks", {
  schema: ReviewTaskCountsSchema,
  params: ["reviewId"],
});
