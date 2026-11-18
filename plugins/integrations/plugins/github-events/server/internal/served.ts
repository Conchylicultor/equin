import { serveCollection } from "@plugins/network/plugins/live/server";
import { githubReleases, githubRuns } from "../../core";
import { _githubReleases, _githubRuns } from "./tables";

/** `github-events.runs`, compiled from the table; the change feed carries writes. */
export const githubRunsServed = serveCollection(githubRuns, {
  from: _githubRuns,
});

/** `github-events.releases`, compiled from the table. */
export const githubReleasesServed = serveCollection(githubReleases, {
  from: _githubReleases,
});
