import { db } from "@plugins/database/server";
import {
  onReplicaApplied,
  withReplicaSchema,
  type ReplicaRead,
  type ReplicaTx,
} from "@plugins/database/plugins/table-mirror/plugins/replica/server";
import { replicaIdOf } from "./jobs";

/**
 * Run the set owner's own SQL on this computer's copy of a deployment's
 * mirrored set (table-mirror/replica's `withReplicaSchema`: a read-only
 * snapshot, `search_path` the copy's schema with no `public`). `ready: false`
 * until a whole copy is in place. A deployment whose set was never asked for
 * has no replica: that throws — a consumer reads the copy only once
 * `site-mirror.status` says it is `copied`. `fn` is told the copy's
 * `sourceNow` (the box's clock at the last applied page).
 */
export function readSiteMirror<T>(
  deploymentId: string,
  setId: string,
  fn: (tx: ReplicaTx, copy: { sourceNow: Date | null }) => Promise<T>,
): Promise<ReplicaRead<T>> {
  return withReplicaSchema(db, replicaIdOf(deploymentId, setId), fn);
}

/**
 * Call `fn` whenever any deployment's copy of `setId` committed a page (or
 * the change signal was lost and one may have been missed) — a served value
 * over the copy calls its own `notify()` from it. Returns the unsubscribe.
 */
export function onSiteMirrorApplied(setId: string, fn: () => void): () => void {
  return onReplicaApplied(setId, () => fn());
}
