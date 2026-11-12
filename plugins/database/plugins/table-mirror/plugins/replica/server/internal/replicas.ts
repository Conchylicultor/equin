import { eq, isNotNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { hashHex } from "@plugins/packages/plugins/string-hash/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { MirrorSetDefinition } from "@plugins/database/plugins/table-mirror/plugins/source/server";
import type { ReplicaTx } from "./exec";
import { replicaSchemaName } from "./schema-sink";
import type { ReplicaPhase, ReplicaProgress, ReplicaSinkKind } from "./state";
import { tableMirrorReplicas } from "./tables";

/** Every replica schema starts with this; the namespace is the replica's to own (`sweepOrphanReplicaSchemas`). */
export const REPLICA_SCHEMA_PREFIX = "tm_";

export interface EnsureReplicaOptions {
  /** The owner's name for it, unique (site-mirror: per deployment and set). */
  id: string;
  set: MirrorSetDefinition;
  /** `schema` (default): the set's tables, same DDL. `custom`: a sink of the owner's own, with the key index. */
  sink?: ReplicaSinkKind;
}

/**
 * The replica named `id`, created empty if it does not exist. Its first pull
 * copies. An existing replica of another set or sink kind throws: an id
 * names one copy.
 */
export async function ensureReplica(
  db: NodePgDatabase,
  opts: EnsureReplicaOptions,
): Promise<void> {
  const sink = opts.sink ?? "schema";
  await db
    .insert(tableMirrorReplicas)
    .values({
      id: opts.id,
      setId: opts.set.id,
      sink,
      schemaName:
        sink === "schema"
          ? replicaSchemaName(opts.set.id, opts.id, hashHex)
          : null,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select({
      setId: tableMirrorReplicas.setId,
      sink: tableMirrorReplicas.sink,
    })
    .from(tableMirrorReplicas)
    .where(eq(tableMirrorReplicas.id, opts.id));
  if (row === undefined) {
    throw new Error(
      `table-mirror: replica ${opts.id} vanished as it was created`,
    );
  }
  if (row.setId !== opts.set.id || row.sink !== sink) {
    throw new Error(
      `table-mirror: replica ${opts.id} copies set "${row.setId}" into a ${row.sink} sink, not "${opts.set.id}" into a ${sink} one`,
    );
  }
}

/** Drop a replica: its schema, its key index and its row, in one transaction. */
export async function dropReplica(
  db: NodePgDatabase,
  replicaId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(tableMirrorReplicas)
      .where(eq(tableMirrorReplicas.id, replicaId))
      .returning({ schemaName: tableMirrorReplicas.schemaName });
    if (row?.schemaName != null) {
      await tx.execute(
        sql.raw(`DROP SCHEMA IF EXISTS ${row.schemaName} CASCADE`),
      );
    }
  });
}

const SchemaRowSchema = z.object({ name: z.string() });

/**
 * Drop every `tm_*` schema no replica row names (a replica dropped by a
 * deleted owner, a fork's copied DDL). Answers the schemas dropped.
 */
export async function sweepOrphanReplicaSchemas(
  db: NodePgDatabase,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    // Schemas first, then the rows that name them (each statement its own
    // snapshot): a replica's row is committed before its first pull creates
    // its schema, so a schema listed here has its row visible below.
    const schemas = await executeRows(tx, {
      query: sql.raw(
        `SELECT nspname::text AS name FROM pg_namespace
         WHERE left(nspname, ${REPLICA_SCHEMA_PREFIX.length}) = '${REPLICA_SCHEMA_PREFIX}'`,
      ),
      row: SchemaRowSchema,
      label: "table-mirror: replica schemas",
    });
    const named = new Set(
      (
        await tx
          .select({ schemaName: tableMirrorReplicas.schemaName })
          .from(tableMirrorReplicas)
          .where(isNotNull(tableMirrorReplicas.schemaName))
      ).map((r) => r.schemaName),
    );
    const orphans = schemas.map((s) => s.name).filter((n) => !named.has(n));
    for (const name of orphans) {
      await tx.execute(sql.raw(`DROP SCHEMA ${name} CASCADE`));
    }
    return orphans;
  });
}

/**
 * A read of a replica's copy: `ready` with the value, or not yet readable —
 * before its first copy is done (or while a local rebuild that lost a
 * table's rows is reconciled) the copy is not the data — a pending state,
 * never a partial list.
 */
export type ReplicaRead<T> =
  | { ready: true; value: T; sourceNow: Date }
  | { ready: false; phase: ReplicaPhase; progress: ReplicaProgress | null };

/**
 * What a read of the copy is "as of": the source's own clock at the last
 * page applied (`source_now`), read in the same snapshot as the rows — so an
 * owner's report over the copy is exactly what the source would have answered
 * at that moment (today's partial day, a live-visit cutoff), never this
 * computer's clock.
 */
export interface ReplicaAsOf {
  sourceNow: Date;
}

/**
 * Run `fn` against a replica's copy: one read-only REPEATABLE READ
 * transaction (a page applied meanwhile is all or nothing to it) with
 * `search_path` set to the replica's schema then `pg_catalog` — no `public`,
 * so the owner's own SQL, naming its tables unqualified, runs unchanged on
 * the copy, and a query naming a table the set does not mirror fails instead
 * of reading this computer's own rows. `fn` is told what the copy is "as
 * of" (`sourceNow`: the source's clock at the last applied page), so a read
 * that depends on time asks it of the copy's moment, never this computer's
 * clock.
 */
export async function withReplicaSchema<T>(
  db: NodePgDatabase,
  replicaId: string,
  fn: (tx: ReplicaTx, asOf: ReplicaAsOf) => Promise<T>,
): Promise<ReplicaRead<T>> {
  return db.transaction(
    async (tx): Promise<ReplicaRead<T>> => {
      const [row] = await tx
        .select({
          sink: tableMirrorReplicas.sink,
          schemaName: tableMirrorReplicas.schemaName,
          phase: tableMirrorReplicas.phase,
          progress: tableMirrorReplicas.progress,
          sourceNow: tableMirrorReplicas.sourceNow,
          copiedAt: tableMirrorReplicas.copiedAt,
        })
        .from(tableMirrorReplicas)
        .where(eq(tableMirrorReplicas.id, replicaId));
      if (row === undefined) {
        throw new Error(`table-mirror: no replica ${replicaId}`);
      }
      if (row.sink !== "schema" || row.schemaName === null) {
        throw new Error(
          `table-mirror: replica ${replicaId} has a custom sink — it keeps no tables to read`,
        );
      }
      // A whole copy was in place once (a reconcile of it since is readable,
      // as a delta pull in progress is); before that, a reconcile of a copy
      // that never finished is still not the data.
      if (row.copiedAt === null) {
        return { ready: false, phase: row.phase, progress: row.progress };
      }
      // Every applied page stamps `source_now` with the copy's progress, so a
      // copy in place without one is a broken invariant, not an unknown time.
      if (row.sourceNow === null) {
        throw new Error(
          `table-mirror: replica ${replicaId} holds a whole copy but no source clock`,
        );
      }
      const sourceNow = new Date(row.sourceNow);
      await tx.execute(
        sql.raw(`SET LOCAL search_path TO ${row.schemaName}, pg_catalog`),
      );
      return {
        ready: true,
        value: await fn(tx, { sourceNow }),
        sourceNow,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
