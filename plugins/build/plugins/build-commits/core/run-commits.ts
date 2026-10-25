import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { CommitRowSchema } from "@plugins/primitives/plugins/commit-list/core";

/**
 * The most commits one build's answer lists. A build after a long gap (the
 * previous successful build months back, or a first build over a fresh
 * history) spans thousands; past this the list is no longer read commit by
 * commit, and `truncated` says the older ones were dropped.
 */
export const BUILD_COMMITS_MAX = 200;

export const BuildRunCommitsSchema = z.object({
  /**
   * The commits the run's tree adds since the previous successful build of
   * this namespace, newest first — the newest {@link BUILD_COMMITS_MAX}. With
   * no previous successful build to range from, the run's own commit and its
   * history (at most {@link BUILD_RUN_HISTORY_COMMITS}). Empty when the run
   * recorded no commit.
   */
  commits: cappedList(CommitRowSchema, { max: BUILD_COMMITS_MAX }),
  /**
   * What `commits` lists: `since-previous` — the range from the previous
   * successful build of this namespace to this run's commit; `history` — no
   * earlier successful build to range from, so the run's own newest commits
   * stand in (not a range: older history is not "in this build").
   */
  basis: z.enum(["since-previous", "history"]),
  /**
   * More commits exist than `commits` lists: in the range (`since-previous`),
   * or further back in the run's history (`history`).
   */
  truncated: z.boolean(),
});
export type BuildRunCommits = z.infer<typeof BuildRunCommitsSchema>;

/**
 * How much history a run with no previous successful build shows: there is
 * no range to list, so its newest commits stand in for "what this build
 * shipped".
 */
export const BUILD_RUN_HISTORY_COMMITS = 50;

const RUN_COMMITS_REFUSALS = ["missing"] as const;

/**
 * One build run's commits, by run id (`build_runs.id`) — the build detail's
 * Commits section. A build's commits are about the TREE it was built from,
 * which every one of its targets shares, so the question is the run alone.
 *
 * An id naming no run of this namespace is refused `missing`.
 *
 * Desktop-only: the commits are read with git from the checkout.
 */
export const buildRunCommits = liveValue("build.run-commits", {
  schema: BuildRunCommitsSchema,
  params: ["id"],
  refusals: RUN_COMMITS_REFUSALS,
  needsMachine: { feature: "Reading a build's commits" },
});
