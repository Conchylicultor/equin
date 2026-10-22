import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

// Interim stats values (research/2026-10-11-global-endpoint-reads-onto-live.md,
// B9) — deleted once the metrics plan's P2/P3 serve these series.
//
// Every value reads `git log` of the main checkout, so only the desktop app
// answers: a host without the computer reads `unavailable`.
const COMMITS_ON_THIS_MACHINE = {
  feature: "Commit history of this checkout",
} as const;

export const COMMIT_BUCKETS = ["hour", "day", "week", "month", "year"] as const;
export type CommitBucket = (typeof COMMIT_BUCKETS)[number];

/**
 * Which series a chart draws: the running total, one point per day holding a
 * commit, or the count per `bucket` (UTC). Each point's `x` is that day / bucket
 * key — the same strings the old endpoints answered as `date` / `bucket`.
 */
const CommitSeriesSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cumulative") }),
  z.object({ kind: z.literal("rate"), bucket: z.enum(COMMIT_BUCKETS) }),
]);
export type CommitSeries = z.infer<typeof CommitSeriesSchema>;

/**
 * The question every commits chart asks. `dedup` collapses the commits of one
 * push (a `Singularity-Push` trailer) into one — the section passes its
 * `filterRebases` config, as it passed the old endpoints' `dedup`.
 */
const CommitsQuerySchema = z.object({
  series: CommitSeriesSchema,
  dedup: z.boolean(),
});
export type CommitsQuery = z.infer<typeof CommitsQuerySchema>;

const CommitsByCategoryQuerySchema = CommitsQuerySchema.extend({
  /** The conversation category to break down by (any configured one). */
  categoryId: z.string().min(1),
});
export type CommitsByCategoryQuery = z.infer<
  typeof CommitsByCategoryQuerySchema
>;

const LinesDeltaSchema = z.object({ added: z.number(), removed: z.number() });

// BOUND (every value below): one point per day / bucket that holds a commit of
// the repo's history — the history's span over the bucket width, never the
// number of commits (today ~170 days, ~1.5k hour buckets). A by-category point
// holds one entry per item of that category; a by-extension point one per file
// extension the history touched (~50) — cumulative points carry every
// extension seen so far. Load is on-demand (an HTTP read per mount and per
// change), so the payload never rides the socket.

/** Commits per series point. */
export const commitsCounts = liveValue("stats.commits.counts", {
  schema: z.object({
    points: z.array(z.object({ x: z.string(), count: z.number() })),
  }),
  query: CommitsQuerySchema,
  load: "on-demand",
  needsMachine: COMMITS_ON_THIS_MACHINE,
});

/**
 * Commits per series point, broken down by the item each commit's
 * conversation (its `Singularity-Conversation` trailer) carries within one
 * category — `Unknown` when it has none. `items` is the category's configured
 * item order, the series order.
 */
export const commitsCountsByCategory = liveValue(
  "stats.commits.counts-by-category",
  {
    schema: z.object({
      points: z.array(
        z.object({ x: z.string(), byItem: z.record(z.string(), z.number()) }),
      ),
      items: z.array(z.string()),
    }),
    query: CommitsByCategoryQuerySchema,
    load: "on-demand",
    needsMachine: COMMITS_ON_THIS_MACHINE,
  },
);

/** Lines added / removed per series point, minus the configured excluded paths. */
export const commitsLines = liveValue("stats.commits.lines", {
  schema: z.object({
    points: z.array(
      z.object({ x: z.string(), added: z.number(), removed: z.number() }),
    ),
  }),
  query: CommitsQuerySchema,
  load: "on-demand",
  needsMachine: COMMITS_ON_THIS_MACHINE,
});

/** Lines added / removed per series point and file extension, minus the excluded paths. */
export const commitsLinesByExt = liveValue("stats.commits.lines-by-ext", {
  schema: z.object({
    points: z.array(
      z.object({
        x: z.string(),
        byExt: z.record(z.string(), LinesDeltaSchema),
      }),
    ),
  }),
  query: CommitsQuerySchema,
  load: "on-demand",
  needsMachine: COMMITS_ON_THIS_MACHINE,
});
