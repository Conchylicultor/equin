import { sql } from "drizzle-orm";
import {
  customType,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { externalIdColumn } from "@plugins/ids/server";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import {
  RowHashSchema,
  SourceIdentitySchema,
  TableFingerprintsSchema,
} from "@plugins/database/plugins/table-mirror/core";
import {
  ReplicaAfterSchema,
  ReplicaOutcomeSchema,
  ReplicaPhaseSchema,
  ReplicaProgressSchema,
  ReplicaSinkKindSchema,
} from "./state";

// Postgres `xid8`, kept as decimal text in JS (the source's spelling).
const xid8 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "xid8";
  },
});

/**
 * One replica: a copy of one mirror set from one source, kept here. Its owner
 * (the deploy app's site-mirror, one per deployment and set) names it by `id`
 * and drops it with `dropReplica`. The cursor (`floor`, `after`) and every
 * phase change are written in the same transaction as the rows they cover, so
 * a killed pull resumes where it stopped; `seq` moves on every such
 * transaction, so a second pull of the same replica fails loudly instead of
 * interleaving with the first.
 */
export const tableMirrorReplicas = pgTable("table_mirror_replicas", {
  id: externalIdColumn("id", {
    reason:
      "named by the replica's owner (site-mirror: one per deployment and set), which keys its own rows by it",
  }),
  setId: text("set_id").notNull(),
  sink: parsedText("sink", ReplicaSinkKindSchema).notNull(),
  /** The replica's own schema (`tm_<set>_<hash>`); null for a custom sink. */
  schemaName: text("schema_name").unique(),
  phase: parsedText("phase", ReplicaPhaseSchema).notNull().default("empty"),
  progress: parsedJson("progress", ReplicaProgressSchema),
  /** The set's tables as of the last copy or reconcile: a table added since is reconciled. */
  localTables: parsedJson("local_tables", z.array(z.string())),
  /** The source identity and fingerprints the current pass was read under. */
  sourceIdentity: parsedJson("source_identity", SourceIdentitySchema),
  fingerprints: parsedJson("fingerprints", TableFingerprintsSchema),
  /** The change stream's cursor: `floor` set, `after` null at a pass start. */
  floor: xid8("floor"),
  after: parsedJson("after", ReplicaAfterSchema),
  /** The xmin of the current stream pass's first page: the next floor once it is done. */
  passXmin: xid8("pass_xmin"),
  seq: integer("seq").notNull().default(0),
  /** The source's `now()` at the last applied page — the copy's "as of". */
  sourceNow: timestamp("source_now", { withTimezone: true, mode: "string" }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  /**
   * When a whole copy was first in place (the first sync's stream reached
   * `done`): readers read the copy only from then on. Cleared when a local
   * rebuild could not keep a table's rows, until a reconcile refills it.
   */
  copiedAt: timestamp("copied_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastOutcome: parsedJson("last_outcome", ReplicaOutcomeSchema),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/**
 * The key index of a custom-sink replica: the key and the row hash of every
 * row applied, never its content. Reconciliation compares the source's
 * `(pk, h)` walk against it, as a schema replica compares against its tables.
 */
export const tableMirrorKeys = pgTable(
  "table_mirror_keys",
  {
    replicaId: text("replica_id").notNull(),
    tbl: text("tbl").notNull(),
    pk: parsedJson("pk", z.record(z.string(), z.unknown())).notNull(),
    h: parsedText("h", RowHashSchema).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.replicaId, t.tbl, t.pk] }),
    foreignKey({
      columns: [t.replicaId],
      foreignColumns: [tableMirrorReplicas.id],
    }).onDelete("cascade"),
  ],
);
