import { liveCollection } from "@plugins/network/plugins/live/core";
import { githubReleasesEntityRef, githubRunsEntityRef } from "./records";

/**
 * The watched workflows' runs, newest change first: a window (the table grows
 * by every run of every watched workflow, a few a day), filterable by repo,
 * workflow and head. Writes reach it through the change feed.
 */
export const githubRuns = liveCollection("github-events.runs", {
  from: githubRunsEntityRef,
  pick: [
    "repo",
    "workflowName",
    "head",
    "event",
    "status",
    "conclusion",
    "githubUpdatedAt",
  ],
  carry: {
    pick: [
      "id",
      "runId",
      "attempt",
      "workflowPath",
      "headSha",
      "url",
      "failedJobs",
      "reportedAt",
    ],
  },
  id: "id",
  sortable: ["githubUpdatedAt", "repo", "head"],
  default: { orderBy: [["githubUpdatedAt", "desc"]], limit: 50 },
  maxLimit: 200,
});

/** The watched repos' releases, newest change first. */
export const githubReleases = liveCollection("github-events.releases", {
  from: githubReleasesEntityRef,
  pick: ["repo", "tag", "draft", "githubUpdatedAt"],
  carry: { pick: ["id", "assets", "url"] },
  id: "id",
  sortable: ["githubUpdatedAt", "repo", "tag"],
  default: { orderBy: [["githubUpdatedAt", "desc"]], limit: 20 },
  maxLimit: 100,
});
