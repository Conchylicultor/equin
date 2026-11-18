import { db } from "@plugins/database/server";
import {
  gitTagsServed,
  refHeadServed,
} from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { resolveUpstreamRemote } from "@plugins/infra/plugins/git/plugins/remotes/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  isMain,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { getServerCommit } from "@plugins/build/plugins/server-build-id/server";
import { _buildRuns } from "@plugins/build/plugins/run-ledger/server";
import {
  inflightRunOn,
  lastClosedRunOn,
} from "@plugins/build/plugins/run-ledger/machine";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { readOwnReleases, releasesHolding } from "@plugins/upstream/core";
import {
  upstreamPublisherStatus,
  type GitHubPublication,
  type PublisherStatus,
  type Releasability,
} from "@plugins/upstream/plugins/release/core";
import { SOURCE_REPO } from "@plugins/framework/plugins/product-name/core";
import {
  _githubReleases,
  _githubRuns,
} from "@plugins/integrations/plugins/github-events/server";
import {
  forwarderStatusOf,
  githubEventsStatusServed,
  newestRunOf,
  releaseOf,
} from "@plugins/integrations/plugins/github-events/machine";
import { RELEASE_WORKFLOW } from "@plugins/installer/plugins/release-assets/core";

/**
 * The publisher's releases (see `PublisherStatus`): served by main's backend
 * on the checkout that has no upstream because it IS the canonical repo;
 * `not-publisher` everywhere else (a clone, or any worktree's backend — a
 * release is cut from main's checkout only).
 *
 * External (git and the served dist are most of its truth), recomputed on
 * what can change it: `main` moving (the unreleased count), a tag created
 * or deleted (a cut, from the endpoint or `./equin version cut` in a
 * terminal: the latest release and the unreleased count), a write to
 * `build_runs` (a build starting or ending), and the backend serving a new
 * build (a restart reads it fresh; an adopted deploy notifies, machine barrel),
 * and GitHub telling what it did of the newest tag (a run or release of it
 * stored, a forwarder connecting or dropping) — pushed by GitHub, never fetched.
 */
export const publisherStatusServed = serveValue(upstreamPublisherStatus, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [_buildRuns, _githubRuns, _githubReleases],
    reason:
      "a build starting or ending changes whether the served commit can be released; a run or release GitHub reported changes what it published of the newest tag",
  },
  recomputeOn: [refHeadServed, gitTagsServed, githubEventsStatusServed],
  loader: () => readPublisherStatus(),
});

async function readPublisherStatus(): Promise<PublisherStatus> {
  if (!isMain()) return { kind: "not-publisher" };
  const root = await getWorktreeRoot();
  const upstream = await resolveUpstreamRemote(root);
  if (upstream.kind !== "none" || upstream.reason !== "is-publisher")
    return { kind: "not-publisher" };
  const own = await readOwnReleases(root);
  return {
    kind: "publisher",
    latest: own.latest,
    unreleased: own.unreleased,
    releasable: await readReleasability(root),
    github:
      own.latest === null ? null : await readGitHubPublication(own.latest.tag),
  };
}

/**
 * What GitHub published of `tag`: the release workflow's newest run of it and
 * its Release, as the product repo's forwarder stored them. Claims nothing
 * while that forwarder is not connected — what was stored may be stale.
 */
async function readGitHubPublication(tag: string): Promise<GitHubPublication> {
  const forwarder = forwarderStatusOf(SOURCE_REPO);
  if (forwarder === null)
    return { kind: "not-connected", reason: "GitHub events are not set up" };
  if (forwarder.state !== "connected")
    return { kind: "not-connected", reason: `GitHub ${forwarder.state}` };
  const [run, release] = await Promise.all([
    newestRunOf({
      repo: SOURCE_REPO,
      workflowPath: RELEASE_WORKFLOW,
      head: tag,
    }),
    releaseOf(SOURCE_REPO, tag),
  ]);
  return {
    kind: "connected",
    run:
      run === null
        ? null
        : { status: run.status, conclusion: run.conclusion, url: run.url },
    release:
      release === null
        ? null
        : { draft: release.draft, assets: release.assets, url: release.url },
  };
}

/** The cut's own checks (`./equin version cut`), against main's served build. */
async function readReleasability(root: string): Promise<Releasability> {
  const namespace = runtimeNamespace();
  const target = { only: MAIN_COMPOSITION_ID };
  const inflight = await inflightRunOn(db, namespace, target);
  if (inflight.kind === "run")
    return { kind: "building", commit: inflight.commitHash };
  const commit = await getServerCommit();
  if (commit === null) return { kind: "not-served" };
  const build = await lastClosedRunOn(db, namespace, target, commit);
  if (build.kind !== "run") return { kind: "no-build", commit };
  if (build.exitCode !== 0) return { kind: "failed", commit, runId: build.id };
  const [tag] = await releasesHolding(root, commit);
  if (tag !== undefined) return { kind: "released", commit, tag };
  return { kind: "ready", commit };
}
