import {
  runtimeNamespace,
  isMain,
} from "@plugins/infra/plugins/runtime-identity/core";
import { and, arrayContains, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { getConfig } from "@plugins/config_v2/server";
import { REPO_ROOT, checkoutRef } from "@plugins/infra/plugins/paths/server";
import { _buildRuns } from "@plugins/build/plugins/run-ledger/server";
import {
  MAIN_COMPOSITION_ID,
  namespaceFor,
} from "@plugins/infra/plugins/namespace/core";
import {
  compositionsConfig,
  isServableCompositionId,
} from "@plugins/plugin-meta/plugins/composition/core";
import { readCompositionMarker } from "@plugins/infra/plugins/worktree/server";
import { wantsBuild } from "@plugins/build/plugins/deployment/core";
import type { BuildAttempt } from "@plugins/build/plugins/deployment/core";
import { readDeployment } from "@plugins/build/plugins/deployment/machine";
import { compositionWantsRebuild } from "./composition-trigger";
import { buildConfig } from "../../shared";

/**
 * What the last FINISHED main build was for. `build_runs.commitHash` +
 * `exitCode` already are the attempt record — there is no new storage here.
 *
 * Closed rows only, so `ok` is always an outcome rather than a guess about a run
 * still in flight. The cost is that a reconcile firing while a build is running
 * can decide "yes" and then have the build job's claim lose against the durable
 * in-flight lock — harmless, because the build's own terminal edge reconciles
 * again. Scoped to this namespace's own main runs: a worktree DB is forked from
 * main and inherits its rows.
 */
export async function lastClosedAttempt(): Promise<BuildAttempt | null> {
  const [row] = await db
    .select({
      commitHash: _buildRuns.commitHash,
      exitCode: _buildRuns.exitCode,
    })
    .from(_buildRuns)
    .where(
      and(
        eq(_buildRuns.namespace, runtimeNamespace()),
        // A PLAIN build of this checkout's own app — the SQL twin of
        // `isMainCompositionBuild`, which is `targets.length === 1 &&
        // targets[0] === MAIN_COMPOSITION_ID`. A run that also published someone
        // else's namespace is not the attempt this reconciler answers for, and a
        // `--composition sonata` build says nothing about whether main is
        // current.
        eq(_buildRuns.targets, [MAIN_COMPOSITION_ID]),
        isNotNull(_buildRuns.finishedAt),
      ),
    )
    .orderBy(desc(_buildRuns.startedAt))
    .limit(1);
  if (row === undefined) return null;
  return { commit: row.commitHash, ok: row.exitCode === 0 };
}

/**
 * The same question for ONE composition: what was the last finished build that
 * published it?
 *
 * The predicate is `targets @> ARRAY[id]` — CONTAINS, where main's is equality.
 * That asymmetry is the point. A run is main's attempt only when main is all it
 * built (a `--composition sonata` run says nothing about whether main is
 * current), but a run is sonata's attempt whenever sonata was among its targets:
 * one `./singularity build --composition a b` is one shared invocation that
 * genuinely attempted both, and reading it as an attempt for neither would break
 * termination for both.
 */
export async function lastCompositionAttempt(
  id: string,
): Promise<BuildAttempt | null> {
  const [row] = await db
    .select({
      commitHash: _buildRuns.commitHash,
      exitCode: _buildRuns.exitCode,
    })
    .from(_buildRuns)
    .where(
      and(
        eq(_buildRuns.namespace, runtimeNamespace()),
        arrayContains(_buildRuns.targets, [id]),
        isNotNull(_buildRuns.finishedAt),
      ),
    )
    .orderBy(desc(_buildRuns.startedAt))
    .limit(1);
  if (row === undefined) return null;
  return { commit: row.commitHash, ok: row.exitCode === 0 };
}

/** What one reconcile pass concluded. Both halves, from one read of the world. */
export interface BuildDecision {
  /** This checkout's own app wants a build. */
  main: boolean;
  /** Composition ids this checkout should rebuild, in manifest order. */
  compositions: string[];
}

/**
 * Does the current state call for an auto-build — of this checkout's own app, of
 * a composition it serves, or of neither?
 *
 * ONE entry point rather than two, so every edge re-derives both halves from the
 * same read of the world. The policies themselves are the pure `wantsBuild` and
 * `compositionWantsRebuild`; this only binds them to the db / config / git
 * singletons and to the scope decision.
 *
 * **`readDeployment()` is read exactly once**, and its `target` is what both
 * halves converge toward. A second read would pay the ancestry probes again on
 * every edge — the reason `deploymentOf` exists at all.
 *
 * Auto-build stays MAIN-ONLY, both halves, and for the same reason main's own
 * always has: `refs/heads/main` is tracked by every backend on the host, so a
 * per-worktree scope would have every live agent worktree rebuilding the same
 * compositions off one push — the fleet-wide fan-out `events.refresh-tick`
 * refuses for its own cadence. `autoBuild: false` remains main's kill switch.
 * The explicit Serve / Rebuild buttons are unaffected and work everywhere.
 */
export async function decideBuilds(now: Date): Promise<BuildDecision> {
  if (!isMain()) return { main: false, compositions: [] };

  const deployment = await readDeployment();
  const main =
    getConfig(buildConfig).autoBuild &&
    wantsBuild(deployment, await lastClosedAttempt());

  const head = deployment.target.resolved ? deployment.target.value : null;
  const checkout = await checkoutRef(REPO_ROOT);
  const compositions: string[] = [];
  for (const item of getConfig(compositionsConfig).manifests) {
    // Main's own row can carry a stored mode from any config layer, and it is
    // inert by construction: `singularity` is the namespace this checkout's own
    // build already owns, so a serve build never provisions it.
    if (!isServableCompositionId(item.id)) continue;
    const marker = readCompositionMarker(namespaceFor(item.id, checkout));
    // Nothing served here, so nothing to rebuild — the never-mint clause
    // `compositionWantsRebuild` states, applied early only to skip a ledger read
    // whose answer could not change the outcome. The predicate still owns the
    // decision.
    if (marker === null) continue;
    const wants = compositionWantsRebuild({
      mode: item.serve,
      marker,
      head,
      lastAttempt: await lastCompositionAttempt(item.id),
      now,
    });
    if (wants) compositions.push(item.id);
  }

  return { main, compositions };
}
