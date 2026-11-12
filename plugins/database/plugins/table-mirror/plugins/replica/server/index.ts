import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  ExcludeFromFork,
  ExcludeSchemaDataFromFork,
} from "@plugins/database/plugins/admin/server";
import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { tableMirrorKeys, tableMirrorReplicas } from "./internal/tables";

export {
  pullReplica,
  ConcurrentPullError,
  type MirrorFetch,
  type MirrorFetchFailed,
  type MirrorCustomSink,
  type MirrorSinkBatch,
  type PullReplicaOptions,
  type PullResult,
} from "./internal/pull";
export {
  ensureReplica,
  dropReplica,
  sweepOrphanReplicaSchemas,
  withReplicaSchema,
  type EnsureReplicaOptions,
  type ReplicaRead,
} from "./internal/replicas";
export {
  onReplicaApplied,
  type ReplicaAppliedHandler,
} from "./internal/notify";
export type {
  ReplicaPhase,
  ReplicaProgress,
  ReplicaOutcome,
  ReplicaSinkKind,
  ReconcileReason,
} from "./internal/state";
export type { ReplicaTx } from "./internal/exec";
// Read-only for owners: a replica's state, for a status value's declared
// reads and an owner's own sweep. Written only by this plugin's functions.
export { tableMirrorReplicas } from "./internal/tables";

export default {
  description:
    "The table mirror's replica half: one Postgres schema per replica (tm_<set>_<hash>) holding tables LIKE the local install's own (unique constraints relaxed, no foreign keys), filled by pullReplica — a transport-agnostic, budgeted pull that applies each page together with its cursor in one transaction (NOTIFY table_mirror at commit): a first copy, then the delta stream; key + hash reconciliation (deleting keys the source no longer has, fetching only rows whose hash differs) when deltas cannot be trusted — reconcile-required, another source identity or epoch, a source fingerprint change, a table created or rebuilt locally (LIKE + INSERT … SELECT + swap); a custom sink in place of the schema, backed by the content-free key index table_mirror_keys; withReplicaSchema runs the owner's own SQL on the copy (search_path = the replica's schema, pg_catalog); onReplicaApplied is the change signal; replicas and their schemas are left out of worktree forks.",
  contributions: [
    // A fork starts with no mirror: the copy can be large (forever totals for
    // every deployment), and a worktree pulls its own on open.
    ExcludeFromFork({
      table: tableMirrorReplicas,
      reason:
        "A replica's state belongs to the copy in this database; a fork's tm_* schemas come across empty, so its replicas start over (a worktree pulls its own copy on open), and the orphan sweep drops the empty schemas.",
    }),
    ExcludeFromFork({
      table: tableMirrorKeys,
      reason:
        "The key index of a custom-sink replica, left out with the replicas it indexes.",
    }),
    ExcludeSchemaDataFromFork({
      schema: "tm_*",
      keep: [],
      reason:
        "Replica schemas (table-mirror/replica): copies of remote databases, re-pulled per worktree; copying them into every fork would multiply the mirror by the number of worktrees.",
    }),
    ExcludeFromChangeFeed({
      table: tableMirrorKeys,
      reason:
        "Written row by row on every applied page of a custom-sink replica; read only by its reconciliation, never by a live-state resource (owners hear onReplicaApplied).",
    }),
  ],
} satisfies ServerPluginDefinition;
