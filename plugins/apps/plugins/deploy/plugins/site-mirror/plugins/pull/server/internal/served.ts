import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  tableMirrorReplicas,
  type ReplicaOutcome,
  type ReplicaProgress,
} from "@plugins/database/plugins/table-mirror/plugins/replica/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import {
  MirrorOutcomeSchema,
  siteMirrorStatus,
  type MirrorOutcome,
  type MirrorProgress,
  type SiteMirrorStatus,
} from "../../core";
import { siteMirrorReplicas } from "./tables";

/** The replica's progress without the key it stands at (a key is the box's data). */
function progressOf(p: ReplicaProgress | null): MirrorProgress | null {
  if (p === null) return null;
  if (p.stage === "stream") return { stage: "stream", reason: p.reason };
  return {
    stage: "tables",
    tablesDone: p.tablesDone,
    total: p.total,
    rows: p.rows,
    deleted: p.deleted,
    reason: p.reason,
  };
}

/**
 * The replica's outcome, checked against what the freshness line renders: a
 * transport failure is stored opaque by the replica, and this transport only
 * ever records host-query's failures.
 */
function outcomeOf(o: ReplicaOutcome | null): MirrorOutcome | null {
  return o === null ? null : MirrorOutcomeSchema.parse(o);
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

async function statusOf(deploymentId: string): Promise<SiteMirrorStatus[]> {
  const rows = await db
    .select({
      setId: siteMirrorReplicas.setId,
      requestedAt: siteMirrorReplicas.requestedAt,
      runError: siteMirrorReplicas.runError,
      phase: tableMirrorReplicas.phase,
      progress: tableMirrorReplicas.progress,
      copiedAt: tableMirrorReplicas.copiedAt,
      lastSyncedAt: tableMirrorReplicas.lastSyncedAt,
      sourceNow: tableMirrorReplicas.sourceNow,
      lastAttemptAt: tableMirrorReplicas.lastAttemptAt,
      lastOutcome: tableMirrorReplicas.lastOutcome,
    })
    .from(siteMirrorReplicas)
    .innerJoin(
      tableMirrorReplicas,
      eq(tableMirrorReplicas.id, siteMirrorReplicas.replicaId),
    )
    .where(
      eq(siteMirrorReplicas.deploymentId, deploymentIdKind.key(deploymentId)),
    )
    .orderBy(siteMirrorReplicas.setId);
  return rows.map((r) => ({
    setId: r.setId,
    phase: r.phase,
    progress: progressOf(r.progress),
    copied: r.copiedAt !== null,
    lastSyncedAt: iso(r.lastSyncedAt),
    sourceNow:
      r.sourceNow === null ? null : new Date(r.sourceNow).toISOString(),
    lastAttemptAt: iso(r.lastAttemptAt),
    lastOutcome: outcomeOf(r.lastOutcome),
    // Asked for after the last attempt ended (a run that threw ends nothing:
    // its error says so instead).
    pending:
      r.requestedAt !== null &&
      r.runError === null &&
      (r.lastAttemptAt === null || r.requestedAt > r.lastAttemptAt),
    runError: r.runError,
  }));
}

export const siteMirrorStatusServed = serveValue(siteMirrorStatus, {
  source: "db",
  reads: {
    tables: [siteMirrorReplicas, tableMirrorReplicas],
    reason:
      "a deployment's replicas: the owner rows (asked-for, run errors) and each replica's phase, cursor times and last outcome, written with every applied page",
  },
  loader: ({ deploymentId }) => statusOf(deploymentId),
});
