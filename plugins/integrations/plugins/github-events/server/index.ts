import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { githubRunFailedKind } from "./internal/kind";
import {
  githubReleasesRetention,
  githubRunsRetention,
} from "./internal/retention";
import { githubReleasesServed, githubRunsServed } from "./internal/served";

export { _githubReleases, _githubRuns } from "./internal/tables";
export {
  GitHubEvents,
  githubWatches,
  releasesWatched,
  watchedRepos,
  watchFor,
  workflowFileOf,
} from "./internal/watch";
export type { GitHubWatch, WatchedRunFailure } from "./internal/watch";

export default {
  description:
    "GitHub events, every host's half: the GitHubEvents.Watch contribution (repo, workflow file, releases?, remedy? — an open set each repo's owner contributes, read through githubWatches / watchedRepos / watchFor), the github_runs table (one row per run attempt of a watched workflow: status, conclusion, head, failed jobs and steps, reported_at) and github_releases (one per release of a watched repo: draft, asset names), served as the github-events.runs / github-events.releases live windows and swept after 180 days / 2 years, and the github-run-failed report kind (fingerprint repo + workflow + head; its task names the failed jobs and steps, the run, `gh run view <id> --log-failed`, and the watch's own remedy).",
  contributions: [
    ...githubRunsServed.declare,
    ...githubReleasesServed.declare,
    githubRunFailedKind,
  ],
  register: [githubRunsRetention, githubReleasesRetention],
} satisfies ServerPluginDefinition;
