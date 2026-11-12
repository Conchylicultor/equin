import { z } from "zod";
import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { resolveMirrorSet } from "@plugins/database/plugins/table-mirror/plugins/source/server";
import {
  dropReplica,
  ensureReplica,
  pullReplica,
  sweepOrphanReplicaSchemas,
  tableMirrorReplicas,
} from "@plugins/database/plugins/table-mirror/plugins/replica/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { mirrorFetchOverSsh } from "./fetch";
import { siteMirrorReplicas } from "./tables";

/** Every replica this plugin owns is named `site-mirror:<deployment>:<set>`. */
const REPLICA_ID_PREFIX = "site-mirror:";

export function replicaIdOf(deploymentId: string, setId: string): string {
  return `${REPLICA_ID_PREFIX}${deploymentIdKind.key(deploymentId)}:${setId}`;
}

/**
 * Fetches one pull job may make: one bounded chunk. A page answers within
 * curl's 10 s on the box (an SSH session's 20 s at worst), so a run is a few
 * minutes at most; a copy or reconcile longer than that continues in the
 * next run, from the cursor the last page committed.
 */
const PULL_BUDGET_PAGES = 20;

/**
 * Keys per reconcile keys page. The budget is counted between steps, and one
 * keys page is one step: its differing rows are all fetched (one GET per key
 * list that fits a question, ~185 uuid keys) before it commits. 2000 keys
 * bound that step to about a dozen SSH requests even when every hash differs
 * (a local column added), instead of ~100 at the source's default 20 000.
 */
const RECONCILE_KEYS_PER_PAGE = 2000;

const PullInputSchema = z.object({
  deploymentId: z.string(),
  setId: z.string(),
});

/** A pull a set asked for no longer resolves: this release no longer declares it. */
export class UnknownMirrorSetError extends Error {
  constructor(setId: string) {
    super(
      `site-mirror: this computer declares no mirror set "${setId}" — its replica cannot be pulled`,
    );
    this.name = "UnknownMirrorSetError";
  }
}

/**
 * The replica of `setId` for a deployment, created (replica row, then this
 * plugin's owner row) if this is the first ask. Throws on a set this
 * computer does not declare.
 */
export async function ensureSiteReplica(
  deploymentId: string,
  setId: string,
): Promise<void> {
  const set = resolveMirrorSet(setId);
  if ("kind" in set) throw new UnknownMirrorSetError(setId);
  const replicaId = replicaIdOf(deploymentId, setId);
  await ensureReplica(db, { id: replicaId, set });
  await db
    .insert(siteMirrorReplicas)
    .values({
      replicaId,
      deploymentId: deploymentIdKind.key(deploymentId),
      setId,
    })
    .onConflictDoNothing();
}

/**
 * Ask for a pull of one replica: stamps `requested_at` (the status value's
 * "syncing" until the run ends) and enqueues the job — which coalesces with
 * one already pending for the replica.
 */
export async function requestPull(
  deploymentId: string,
  setId: string,
): Promise<void> {
  await db
    .update(siteMirrorReplicas)
    .set({ requestedAt: new Date() })
    .where(eq(siteMirrorReplicas.replicaId, replicaIdOf(deploymentId, setId)));
  await siteMirrorPullJob.enqueue({ deploymentId, setId });
}

/**
 * One bounded chunk of one replica's sync, over SSH to the deployment's box.
 * A chunk whose budget ran out with the replica still behind enqueues the
 * next one, so a first copy is resumable and no run is long. A refusal or a
 * transport failure is the replica's recorded outcome (the freshness line
 * shows it), never a throw; a throw is a bug, recorded as the owner row's
 * `run_error` and rethrown.
 */
export const siteMirrorPullJob = defineJob({
  name: "site-mirror.pull",
  description:
    "Copies a deployed site's mirrored tables (its analytics) from the site's server into this computer, a few pages at a time.",
  hold: "minutes",
  inProcess:
    "Each page is applied with its cursor in one transaction, so a run killed by a restart resumes from the last committed page on its next run; at most 20 SSH requests, each bounded by its 20 s deadline.",
  input: PullInputSchema,
  event: z.never(),
  // One pending pull per replica: a sync while one waits folds into it.
  dedup: { key: ({ deploymentId, setId }) => replicaIdOf(deploymentId, setId) },
  // Two pulls of one replica must never interleave (the replica throws), and
  // a pull is SSH-bound anyway: one at a time on this backend.
  serial: true,
  maxAttempts: 2,
  // A run that ended for good without its own catch running (its worker died
  // on its last attempt, a cancel) is recorded like a throw, so the status
  // never shows a pull still coming that will not.
  async onDead({ input: { deploymentId, setId }, death }) {
    await db
      .update(siteMirrorReplicas)
      .set({ runError: `the pull ended (${death.cause}): ${death.error}` })
      .where(
        eq(siteMirrorReplicas.replicaId, replicaIdOf(deploymentId, setId)),
      );
  },
  async run({ input: { deploymentId, setId } }) {
    const replicaId = replicaIdOf(deploymentId, setId);
    const [owner] = await db
      .select({ replicaId: siteMirrorReplicas.replicaId })
      .from(siteMirrorReplicas)
      .where(eq(siteMirrorReplicas.replicaId, replicaId));
    // The deployment was deleted since (its row cascaded): nothing to pull.
    if (owner === undefined) return;
    try {
      const set = resolveMirrorSet(setId);
      if ("kind" in set) throw new UnknownMirrorSetError(setId);
      const result = await pullReplica({
        db,
        replicaId,
        set,
        fetch: mirrorFetchOverSsh(deploymentId),
        budget: { pages: PULL_BUDGET_PAGES },
        bounds: { maxKeys: RECONCILE_KEYS_PER_PAGE },
      });
      await db
        .update(siteMirrorReplicas)
        .set({ runError: null })
        .where(eq(siteMirrorReplicas.replicaId, replicaId));
      if (result.outcome.kind === "stopped") {
        await requestPull(deploymentId, setId);
      }
    } catch (err) {
      await db
        .update(siteMirrorReplicas)
        .set({ runError: err instanceof Error ? err.message : String(err) })
        .where(eq(siteMirrorReplicas.replicaId, replicaId));
      throw err;
    }
  },
});

/**
 * Hourly, on main only (no `perWorktree`): a pull of every replica this
 * computer keeps — the box has no change signal reaching here, so the
 * schedule is what keeps an unopened site's copy fresh. First drops the
 * replicas whose deployment is gone (their owner row cascaded) and every
 * replica schema no replica names.
 */
export const siteMirrorPullAllJob = defineJob({
  name: "site-mirror.pull-all",
  description:
    "Every hour, asks for a fresh copy of each deployed site's mirrored tables, and drops the copies of sites that were deleted.",
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "37 * * * *" },
  async run() {
    const orphans = await db
      .select({ id: tableMirrorReplicas.id })
      .from(tableMirrorReplicas)
      .leftJoin(
        siteMirrorReplicas,
        eq(siteMirrorReplicas.replicaId, tableMirrorReplicas.id),
      )
      .where(
        and(
          like(tableMirrorReplicas.id, `${REPLICA_ID_PREFIX}%`),
          isNull(siteMirrorReplicas.replicaId),
        ),
      );
    for (const { id } of orphans) await dropReplica(db, id);
    await sweepOrphanReplicaSchemas(db);
    const owned = await db
      .select({
        deploymentId: siteMirrorReplicas.deploymentId,
        setId: siteMirrorReplicas.setId,
      })
      .from(siteMirrorReplicas);
    for (const r of owned) await requestPull(r.deploymentId, r.setId);
  },
});
