import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The main checkout's parsed commit history, one file per excluded-paths
 * filter: every commit's date, trailers and line stats up to the HEAD it was
 * parsed at. A commit's facts never change once it exists, so a later read
 * extends the file by the commits since that HEAD instead of re-running
 * `git log --numstat` over the whole history (tens of seconds of CPU).
 *
 * Host-global because every backend reads the same main checkout's history.
 */
export const commitHistoryDir = defineDataDir({
  kind: "cache",
  name: "stats-commit-history",
  owner: "stats/commits",
  description:
    "The main checkout's parsed commit history (date, trailers, line stats per commit) per excluded-paths filter, extended by the commits since its HEAD on each read",
  // Rebuilt by one full `git log --numstat` when deleted.
  reclaim: { kind: "safe" },
});

export default [commitHistoryDir];
