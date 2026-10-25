import { and, desc, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  LOG_FORMAT,
  parseGitLog,
  runGit,
} from "@plugins/primitives/plugins/commit-list/server";
import { _buildRuns } from "@plugins/build/plugins/run-ledger/server";
import { buildRunIdKind } from "@plugins/build/plugins/run-ledger/core";
import {
  BUILD_COMMITS_MAX,
  BUILD_RUN_HISTORY_COMMITS,
  buildRunCommits,
  type BuildRunCommits,
} from "../../core/run-commits";

/**
 * The commits between the previous successful build of this namespace and
 * this run's tree — or, with no previous successful build, the run's own
 * commit and its history. Both lookups are scoped to this namespace: another
 * namespace's run (an inherited main row in a worktree DB) is `missing`.
 *
 * Read one row past the cap, so `truncated` is git's own answer rather than a
 * guess from the count.
 */
async function loadRunCommits(id: string): Promise<BuildRunCommits> {
  const namespace = runtimeNamespace();
  const [thisRun] = await db
    .select({
      commitHash: _buildRuns.commitHash,
      startedAt: _buildRuns.startedAt,
    })
    .from(_buildRuns)
    .where(
      and(
        eq(_buildRuns.namespace, namespace),
        eq(_buildRuns.id, buildRunIdKind.key(id)),
      ),
    )
    .limit(1);
  if (thisRun === undefined) {
    throw buildRunCommits.refuse(
      "missing",
      `no build run ${id} in this namespace`,
    );
  }
  if (!thisRun.commitHash)
    return { commits: [], basis: "since-previous", truncated: false };

  // Scoped to this namespace: a worktree DB is forked from main and inherits
  // main's rows, and the lower bound is this namespace's previous success —
  // which also reads through `build_runs_ns_started_id_idx`.
  const [prevRun] = await db
    .select({ commitHash: _buildRuns.commitHash })
    .from(_buildRuns)
    .where(
      and(
        eq(_buildRuns.namespace, namespace),
        lt(_buildRuns.startedAt, thisRun.startedAt),
        isNotNull(_buildRuns.commitHash),
        eq(_buildRuns.exitCode, 0),
      ),
    )
    .orderBy(desc(_buildRuns.startedAt))
    .limit(1);

  const basis = prevRun?.commitHash ? "since-previous" : "history";
  const max =
    basis === "since-previous" ? BUILD_COMMITS_MAX : BUILD_RUN_HISTORY_COMMITS;
  const range = prevRun?.commitHash
    ? `${prevRun.commitHash}..${thisRun.commitHash}`
    : thisRun.commitHash;
  // runGit throws on failure — a failed log must never be absorbed as an empty
  // commit list; the throw surfaces as a failed read.
  const out = await runGit(
    ["log", `--max-count=${max + 1}`, `--format=${LOG_FORMAT}`, range],
    REPO_ROOT,
  );
  const commits = parseGitLog(out);
  return commits.length > max
    ? { commits: commits.slice(0, max), basis, truncated: true }
    : { commits, basis, truncated: false };
}

/**
 * `notified` by the ledger: the answer is a pure function of two `build_runs`
 * rows (this run's commit, and the newest successful run before it) over git
 * objects addressed by sha, which never change — so a write to the ledger is
 * the only thing that can move it (a run gaining its commit, an older run
 * settling as the previous success), and once both rows are final it is
 * immutable. Throttled: a build writes its row a few times as it runs, and
 * each recompute is one `git log`.
 */
export const buildRunCommitsServed = serveValue(buildRunCommits, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [_buildRuns],
    reason:
      "the range is this run's commit and the newest earlier successful run's, so any run's insert or exit code may move its lower bound",
  },
  throttleMs: 1000,
  loader: ({ id }) => loadRunCommits(id),
});
