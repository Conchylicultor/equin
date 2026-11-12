import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  onReplicaApplied,
  tableMirrorReplicas,
  withReplicaSchema,
  type ReplicaAsOf,
  type ReplicaRead,
  type ReplicaTx,
} from "@plugins/database/plugins/table-mirror/plugins/replica/server";
import { replicaIdOf } from "./jobs";

/**
 * Run the set owner's own SQL on this computer's copy of a deployment's
 * mirrored set (table-mirror/replica's `withReplicaSchema`: a read-only
 * snapshot, `search_path` the copy's schema with no `public`), `fn` getting
 * `{ sourceNow }` — the box's clock at the last page applied, the "now" a
 * report over the copy runs as of. Not readable yet (`ready: false`) until a
 * whole first copy is in place — and as `empty` while no replica exists at
 * all (no tab has asked for the set yet): a pending state, never a throw and
 * never no data.
 */
export async function readSiteMirror<T>(
  deploymentId: string,
  setId: string,
  fn: (tx: ReplicaTx, asOf: ReplicaAsOf) => Promise<T>,
): Promise<ReplicaRead<T>> {
  const replicaId = replicaIdOf(deploymentId, setId);
  const [row] = await db
    .select({ id: tableMirrorReplicas.id })
    .from(tableMirrorReplicas)
    .where(eq(tableMirrorReplicas.id, replicaId));
  if (row === undefined) return { ready: false, phase: "empty", progress: null };
  return withReplicaSchema(db, replicaId, fn);
}

/** Whose copies {@link onSiteMirrorApplied} listens to: every deployment's, or one's. */
export interface SiteMirrorScope {
  setId: string;
  /** Only this deployment's copy; omitted, any deployment's. */
  deploymentId?: string;
}

/**
 * Call `fn` whenever a copy of `scope.setId` (one deployment's, when named)
 * commits a page, or once a lost LISTEN session reopens (a page may have gone
 * unheard) — the change signal of {@link readSiteMirror}'s answers. Resolves
 * to the unsubscribe once listening, so a served value or collection's
 * `whileSubscribed` returns it and its first read cannot miss a page.
 */
export function onSiteMirrorApplied(
  scope: SiteMirrorScope,
  fn: () => void,
): Promise<() => void> {
  const only =
    scope.deploymentId === undefined
      ? null
      : replicaIdOf(scope.deploymentId, scope.setId);
  return onReplicaApplied(scope.setId, (applied) => {
    if (only === null || applied === null || applied === only) fn();
  });
}
