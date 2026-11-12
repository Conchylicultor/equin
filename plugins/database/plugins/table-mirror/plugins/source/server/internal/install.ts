import { and, eq, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { installDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import { assertMirrorSetsAllowed, type MirrorSetDefinition } from "./define";
import { tableMirrorLog, tableMirrorSource } from "./tables";
import { mirrorTriggerSet } from "./triggers";

/**
 * Make this database a mirror source for `sets`: the boot guard (no
 * never-mirrored table in a set, no table in two sets), the identity row
 * (seeded once; a new cluster or a restored box mints a new one with its
 * database), the log rows of tables no set mirrors any more dropped (the
 * stream could not join them to a table), and the change-log triggers
 * installed one table per transaction. The body of the source plugin's
 * `onReadyBlocking`, parametrized so a suite runs it on a throwaway database.
 */
export async function installMirrorSource(
  db: NodePgDatabase,
  sets: readonly MirrorSetDefinition[],
  never: readonly { tables: readonly string[]; reason: string }[],
): Promise<void> {
  assertMirrorSetsAllowed(sets, never);
  await db
    .insert(tableMirrorSource)
    .values({ singleton: true, sourceId: sql`gen_random_uuid()` })
    .onConflictDoNothing();
  const declared = sets.flatMap((s) =>
    s.tables.map((t) =>
      and(eq(tableMirrorLog.setId, s.id), eq(tableMirrorLog.tbl, t.name)),
    ),
  );
  await db
    .delete(tableMirrorLog)
    .where(declared.length === 0 ? undefined : sql`NOT (${or(...declared)})`);
  // db-triggers refuses a set with no trigger, so with no mirrored table there
  // is nothing to install. Known gap: if every set is removed at once, the
  // triggers a previous boot installed stay (the schema layer's sweep spares a
  // claimed set) and keep writing log rows the daily prune drops; removing a
  // table from a set that remains drops its triggers as usual.
  if (sets.some((s) => s.tables.length > 0)) {
    await installDbTriggers(db, [mirrorTriggerSet(sets)], {
      commit: "per-table",
    });
  }
}
