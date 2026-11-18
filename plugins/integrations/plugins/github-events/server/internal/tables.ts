import { index } from "drizzle-orm/pg-core";
import { defineEntity } from "@plugins/infra/plugins/entities/server";
import { githubReleasesEntityRef, githubRunsEntityRef } from "../../core";

// The watched workflows' runs and the watched repos' releases, written only by
// the ingest (machine/internal/ingest.ts): GitHub's deliveries and the
// catch-up listing of every forwarder (re)start, through one upsert each.

const githubRuns = defineEntity(githubRunsEntityRef, {
  primaryKey: "id",
  columns: { failedJobs: { default: [] } },
  indexes: (t) => [
    // The publisher's releases row reads one head's newest run of one
    // workflow; the runs window reads newest first.
    index("github_runs_repo_path_head_idx").on(
      t.repo,
      t.workflowPath,
      t.head,
      t.githubUpdatedAt.desc(),
    ),
    index("github_runs_updated_idx").on(t.githubUpdatedAt.desc()),
  ],
});
export const _githubRuns = githubRuns.table;

const githubReleases = defineEntity(githubReleasesEntityRef, {
  primaryKey: "id",
  columns: { assets: { default: [] } },
  indexes: (t) => [
    index("github_releases_updated_idx").on(t.githubUpdatedAt.desc()),
  ],
});
export const _githubReleases = githubReleases.table;
