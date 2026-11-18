import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { _githubReleases, _githubRuns } from "./tables";

// Main-only (the default): the rows are written only by main's forwarders; a
// worktree's fork holds a copy of main's, swept with its fork.

/** A run not touched on GitHub for 180 days is history no row reads. */
export const githubRunsRetention = defineRetention({
  table: _githubRuns,
  column: "githubUpdatedAt",
  ttlDays: 180,
});

/** A release not touched for two years: the releases row reads the newest. */
export const githubReleasesRetention = defineRetention({
  table: _githubReleases,
  column: "githubUpdatedAt",
  ttlDays: 730,
});
