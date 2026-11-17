import { db } from "@plugins/database/server";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { serverPinCommit } from "@plugins/build/plugins/server-build-id/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  currentRelease,
  fetchUpstreamStatus,
  releaseInCommit,
  standingAgainst,
  UPSTREAM_BRANCH,
  upstreamReleaseNamespace,
  type UpstreamStatus,
} from "@plugins/upstream/core";
import {
  upstreamReleaseStatus,
  type ReleaseStatus,
} from "@plugins/upstream/plugins/release/core";
import { _upstreamReleaseCheck } from "../../server/internal/tables";

/**
 * The release status as the web reads it: the last check's stored answer
 * (upstream's newest release, when it was read) joined with where local `main`
 * stands against it NOW, read from git.
 *
 * External (git is half its truth), recomputed on exactly what can change it:
 * a check recording a new answer (a write to its row, through the change
 * feed), a tracked ref moving (`refHeadServed`, the same edge
 * `build.deployment` recomputes on) — so a merge that lands the release reads
 * as current as soon as `main` moves, not at the next daily check — and the
 * backend serving a new build: a restart reads it fresh, an adopted deploy
 * notifies it (`RestartSkip.Adopted`, machine barrel). Nothing polls it.
 */
export const releaseStatusServed = serveValue(upstreamReleaseStatus, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [_upstreamReleaseCheck],
    reason:
      "a singleton row: the last check's answer; any write to it changes the status",
  },
  recomputeOn: [refHeadServed],
  loader: () => readReleaseStatus(),
});

async function readReleaseStatus(): Promise<ReleaseStatus> {
  const [row] = await db.select().from(_upstreamReleaseCheck);
  if (row === undefined) return { kind: "unknown" };
  const checkedAt = row.checkedAt.toISOString();
  if (row.outcome === "no-upstream") return { kind: "no-upstream" };
  const remote = row.remote;
  if (remote === null)
    throw new Error(
      `upstream_release_check says "${row.outcome}" but names no remote — the row was written outside checkUpstream.`,
    );
  const root = await getWorktreeRoot();
  if (row.outcome === "no-release")
    return {
      kind: "no-release",
      current: await currentRelease(
        root,
        UPSTREAM_BRANCH,
        upstreamReleaseNamespace(remote),
      ),
      checkedAt,
    };
  const latest = row.latest;
  if (latest === null)
    throw new Error(
      "upstream_release_check says upstream has a release but names none — the row was written outside checkUpstream.",
    );
  const standing = await standingAgainst(root, remote, latest);
  return standing.kind === "current"
    ? {
        kind: "current",
        current: latest,
        latest,
        installed: await servesRelease(root, remote, latest),
        checkedAt,
      }
    : { kind: "behind", current: standing.current, latest, checkedAt };
}

/**
 * Does this backend serve a build holding the release? Only main installs
 * anything (it rebuilds when `main` moves), so on any other checkout the
 * release in local `main` is all there is to say. A backend that cannot name
 * its commit (a mixed boot) is not serving it: main rebuilds such a backend.
 */
async function servesRelease(
  root: string,
  remote: string,
  latest: string,
): Promise<boolean> {
  if (!isMain()) return true;
  const served = serverPinCommit();
  if (served === null) return false;
  return releaseInCommit(root, remote, latest, served);
}

/** The stored half of an answer; `unreachable` stores nothing — it said nothing. */
function storedAnswer(
  status: Exclude<UpstreamStatus, { kind: "unreachable" }>,
): {
  outcome: "no-upstream" | "no-release" | "release";
  remote: string | null;
  latest: string | null;
} {
  switch (status.kind) {
    case "no-upstream":
      return { outcome: "no-upstream", remote: null, latest: null };
    case "no-release":
      return { outcome: "no-release", remote: status.remote, latest: null };
    case "current":
      return {
        outcome: "release",
        remote: status.remote,
        latest: status.release,
      };
    case "behind":
      return {
        outcome: "release",
        remote: status.remote,
        latest: status.latest,
      };
  }
}

/**
 * Ask upstream (one fetch of its main and release tags) and record the answer
 * — the change feed pushes it to every reader. What the daily job and `POST /api/upstream/check`
 * both run, so the two can never record different things.
 */
export async function checkUpstream(): Promise<UpstreamStatus> {
  const status = await fetchUpstreamStatus(await getWorktreeRoot());
  if (status.kind === "unreachable") return status;
  const answer = { ...storedAnswer(status), checkedAt: new Date() };
  await db
    .insert(_upstreamReleaseCheck)
    .values({ singleton: true, ...answer })
    .onConflictDoUpdate({
      target: _upstreamReleaseCheck.singleton,
      set: answer,
    });
  return status;
}
