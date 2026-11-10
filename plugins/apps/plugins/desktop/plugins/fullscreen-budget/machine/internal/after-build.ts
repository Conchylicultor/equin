import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { latestSupervisedRun } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { isMainCompositionBuild } from "@plugins/build/core";
import { buildStatusOf } from "@plugins/build/plugins/build-status/core";
import { _buildRuns } from "@plugins/build/plugins/run-ledger/server";
import {
  buildRunIdKind,
  type BuildRunId,
} from "@plugins/build/plugins/run-ledger/core";
import { fullscreenBudgetJob } from "./budget-job";

const columns = {
  startedAt: _buildRuns.startedAt,
  finishedAt: _buildRuns.finishedAt,
  exitCode: _buildRuns.exitCode,
  commitHash: _buildRuns.commitHash,
  targets: _buildRuns.targets,
};

type BuildRow = {
  finishedAt: Date | null;
  exitCode: number | null;
  commitHash: string | null;
  targets: string[];
};

/**
 * Enqueue the budget run for a build that deployed this namespace's own app
 * (a plain build that succeeded — what main's auto-build and its Build button
 * run), unless its commit was already measured. Idempotent: a run is
 * announced more than once, and two backends overlap across a deploy.
 */
async function measureIfDeployed(row: BuildRow): Promise<void> {
  if (buildStatusOf(row) !== "success") return;
  if (!isMainCompositionBuild(row.targets)) return;
  const commit = row.commitHash;
  if (commit === null) return;
  if ((await latestSupervisedRun(fullscreenBudgetJob, { commit })) !== null)
    return;
  await fullscreenBudgetJob.enqueue({ commit });
}

/** A build run's exit marker landed: measure what it deployed. */
export async function onBuildTerminal(runId: BuildRunId): Promise<void> {
  const [row] = await db
    .select(columns)
    .from(_buildRuns)
    .where(eq(_buildRuns.id, buildRunIdKind.key(runId)));
  // No row: the ledger no longer has it. Nothing deployed to measure.
  if (row !== undefined) await measureIfDeployed(row);
}

/** How far back a booting backend looks for a deploy it has not measured. */
const BOOT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * At boot: the latest successful plain build of this namespace (a composition
 * build is skipped — it served another namespace), if its commit was never
 * measured — a build whose marker landed while no backend was listening. Only
 * the latest: what is served is the latest build's.
 */
export async function measureLatestDeploy(): Promise<void> {
  const rows = await db
    .select(columns)
    .from(_buildRuns)
    .where(
      and(
        eq(_buildRuns.namespace, runtimeNamespace()),
        eq(_buildRuns.exitCode, 0),
        gt(_buildRuns.finishedAt, new Date(Date.now() - BOOT_LOOKBACK_MS)),
      ),
    )
    .orderBy(desc(_buildRuns.finishedAt))
    .limit(20);
  const latest = rows.find((r) => isMainCompositionBuild(r.targets));
  if (latest !== undefined) await measureIfDeployed(latest);
}
