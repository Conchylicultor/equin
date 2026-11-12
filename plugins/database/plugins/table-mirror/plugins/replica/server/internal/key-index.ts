import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type {
  MirrorKeyedRow,
  MirrorPk,
} from "@plugins/database/plugins/table-mirror/core";
import {
  mirrorSql,
  type MirroredTable,
} from "@plugins/database/plugins/table-mirror/plugins/source/server";
import type { Exec, KeyHash, ReplicaTx } from "./exec";
import { rowColumns } from "./schema-sink";
import { tableMirrorKeys } from "./tables";

// The key index of a custom-sink replica (`table_mirror_keys`): the key and
// row hash of every row handed to the sink, never its content. It is what a
// reconciliation compares the source's key walk against when the sink keeps
// no rows of its own to hash (site-reports' reduce step).

const { lit, pkOrder, textArray, typedKey } = mirrorSql;

/** Forget the keys of tables the set no longer lists. */
export async function pruneKeyIndex(
  tx: ReplicaTx,
  replicaId: string,
  tables: readonly string[],
): Promise<void> {
  await tx
    .delete(tableMirrorKeys)
    .where(
      and(
        eq(tableMirrorKeys.replicaId, replicaId),
        notInArray(tableMirrorKeys.tbl, [...tables]),
      ),
    );
}

/** Record one table's part of a page: tombstoned keys forgotten, applied rows' hashes kept. */
export async function applyToKeyIndex(
  tx: ReplicaTx,
  replicaId: string,
  t: MirroredTable,
  upserts: readonly MirrorKeyedRow[],
  deletes: readonly MirrorPk[],
): Promise<void> {
  if (deletes.length > 0) {
    await tx
      .delete(tableMirrorKeys)
      .where(
        and(
          eq(tableMirrorKeys.replicaId, replicaId),
          eq(tableMirrorKeys.tbl, t.name),
          inArray(tableMirrorKeys.pk, [...deletes]),
        ),
      );
  }
  if (upserts.length > 0) {
    // A page's `h` covers every column the source sends; a keys page hashes
    // only the ones this install's table has. Kept as the latter, so a newer
    // source (extra columns) does not make every key differ at each reconcile.
    const own = new Set(t.columns);
    const hashOf = (r: MirrorKeyedRow) => {
      const extra = rowColumns(r.row).filter((c) => !own.has(c));
      return extra.length === 0
        ? r.h
        : sql`md5(((${r.row})::jsonb - ${sql.raw(textArray(extra))})::text)`;
    };
    await tx
      .insert(tableMirrorKeys)
      .values(
        upserts.map((r) => ({
          replicaId,
          tbl: t.name,
          pk: r.pk,
          h: hashOf(r),
        })),
      )
      .onConflictDoUpdate({
        target: [
          tableMirrorKeys.replicaId,
          tableMirrorKeys.tbl,
          tableMirrorKeys.pk,
        ],
        set: { h: sql`excluded.h` },
      });
  }
}

const KeyHashRowSchema = z.object({
  pk: z.record(z.string(), z.unknown()),
  h: z.string(),
});

/**
 * The index's `(pk, h)` over keys in `(afterPk, lastPk]` (to +∞ when `lastPk`
 * is null), in the source's key order: each key typed by the local table's
 * own row type (`public.<t>`, which every install has), so the order is the
 * typed one the source walks.
 */
export async function keyIndexHashes(
  exec: Exec,
  replicaId: string,
  t: MirroredTable,
  afterPk: MirrorPk | null,
  lastPk: MirrorPk | null,
): Promise<KeyHash[]> {
  const from = ["table_mirror_keys k", `LATERAL ${typedKey(t, "k.pk")} r`];
  const where = [`k.replica_id = ${lit(replicaId)}`, `k.tbl = ${lit(t.name)}`];
  if (afterPk !== null) {
    from.push(`${typedKey(t, `${lit(JSON.stringify(afterPk))}::jsonb`)} a`);
    where.push(`ROW(${pkOrder(t, "r")}) > ROW(${pkOrder(t, "a")})`);
  }
  if (lastPk !== null) {
    from.push(`${typedKey(t, `${lit(JSON.stringify(lastPk))}::jsonb`)} b`);
    where.push(`ROW(${pkOrder(t, "r")}) <= ROW(${pkOrder(t, "b")})`);
  }
  return executeRows(exec, {
    query: sql.raw(
      `SELECT k.pk, k.h FROM ${from.join(", ")}
       WHERE ${where.join(" AND ")}
       ORDER BY ${pkOrder(t, "r")}`,
    ),
    row: KeyHashRowSchema,
    label: `table-mirror: key index of ${replicaId} ${t.name}`,
  });
}
