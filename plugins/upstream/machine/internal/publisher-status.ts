import { db } from "@plugins/database/server";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
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
  type PublisherStatus,
  type Releasability,
} from "@plugins/upstream/plugins/release/core";

/**
 * The publisher's releases (see `PublisherStatus`): served by main's backend
 * on the checkout that has no upstream because it IS the canonical repo;
 * `not-publisher` everywhere else (a clone, or any worktree's backend — a
 * release is cut from main's checkout only).
 *
 * External (git and the served dist are most of its truth), recomputed on
 * what can change it: `main` moving (the unreleased count), a write to
 * `build_runs` (a build starting or ending), the backend serving a new build
 * (a restart reads it fresh; an adopted deploy notifies, machine barrel), and
 * a cut through the endpoint (it notifies). A tag cut from a terminal is heard
 * at the next of those.
 */
export const publisherStatusServed = serveValue(upstreamPublisherStatus, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [_buildRuns],
    reason:
      "a build starting or ending changes whether the served commit can be released",
  },
  recomputeOn: [refHeadServed],
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
