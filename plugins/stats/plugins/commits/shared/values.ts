import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  cappedList,
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";

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

/** A by-category point's keys, and the category's item order. */
const CATEGORY_ITEMS_REASON =
  "one entry per item configured in the category (plus Unknown) — a handful the user names";

const LinesDeltaSchema = z.object({ added: z.number(), removed: z.number() });

// BOUND (every value below): one point per day / bucket that holds a commit of
// the repo's history — the history's span over the bucket width, never the
// number of commits (today ~170 days, ~1.5k hour buckets) — capped at
// `COMMIT_POINTS_MAX` (the newest points; `truncated` when older ones were
// dropped). A by-category point holds one entry per item of that category; a
// by-extension point one per file extension the history touched (~50) —
// cumulative points carry every extension seen so far. Load is on-demand (an
// HTTP read per mount and per change), so the payload never rides the socket.

/**
 * How many points a commits series holds — hour buckets of about six years of
 * a busy history. The loader keeps the newest and says `truncated`.
 */
export const COMMIT_POINTS_MAX = 20_000;

const truncated = z
  .boolean()
  .describe(
    "Whether points older than the newest COMMIT_POINTS_MAX were dropped.",
  );

/** The note under a commits chart whose series dropped its oldest points. */
export function commitPointsNote(d: { truncated: boolean }): string | null {
  return d.truncated ? `Showing the latest ${COMMIT_POINTS_MAX} points.` : null;
}

/** The points of a commits series, capped at `COMMIT_POINTS_MAX`. */
function points<T extends z.ZodTypeAny>(point: T) {
  return cappedList(point, { max: COMMIT_POINTS_MAX });
}

/** Commits per series point. */
export const commitsCounts = liveValue("stats.commits.counts", {
  schema: z.object({
    points: points(z.object({ x: z.string(), count: z.number() })),
    truncated,
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
      points: points(
        z.object({
          x: z.string(),
          byItem: wholeRecord(z.number(), { reason: CATEGORY_ITEMS_REASON }),
        }),
      ),
      truncated,
      items: wholeList(z.string(), { reason: CATEGORY_ITEMS_REASON }),
    }),
    query: CommitsByCategoryQuerySchema,
    load: "on-demand",
    needsMachine: COMMITS_ON_THIS_MACHINE,
  },
);

/** Lines added / removed per series point, minus the configured excluded paths. */
export const commitsLines = liveValue("stats.commits.lines", {
  schema: z.object({
    points: points(
      z.object({ x: z.string(), added: z.number(), removed: z.number() }),
    ),
    truncated,
  }),
  query: CommitsQuerySchema,
  load: "on-demand",
  needsMachine: COMMITS_ON_THIS_MACHINE,
});

/** Lines added / removed per series point and file extension, minus the excluded paths. */
export const commitsLinesByExt = liveValue("stats.commits.lines-by-ext", {
  schema: z.object({
    points: points(
      z.object({
        x: z.string(),
        byExt: wholeRecord(LinesDeltaSchema, {
          reason:
            "one key per file extension the history touched (~50) — the repo's file kinds, never its files",
        }),
      }),
    ),
    truncated,
  }),
  query: CommitsQuerySchema,
  load: "on-demand",
  needsMachine: COMMITS_ON_THIS_MACHINE,
});
