import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { DbTriggerSet } from "./define";

// ── Installing a declared trigger set ───────────────────────────────────────
//
// The derived-`updatedAt` installer's protocol
// (`plugins/database/plugins/derived-updated-at/server/internal/install.ts`):
// each trigger's COMMENT is its set's stamp (`<set id>:<signature>`), so
// "already installed as written?" is a catalog-only read that takes no lock on
// the table; a trigger dropped or disabled out of band counts as out of date.
// Only a stale set runs its DDL, in one transaction (a savepoint inside the boot
// layer's), serialized by an advisory lock and re-checked under it. `CREATE OR
// REPLACE TRIGGER` takes SHARE ROW EXCLUSIVE, never ACCESS EXCLUSIVE.
//
// The set is the unit: one changed DDL reinstalls all of it, and a trigger the
// set no longer declares — found by the set id in its stamp — is dropped
// (ACCESS EXCLUSIVE, for that one statement's table). A FUNCTION removed from a
// set stays: nothing calls it once its trigger is gone; drop it in a migration
// if it matters.

type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];
type Exec = NodePgDatabase | Tx;

const OwnedRow = z.object({
  name: z.string(),
  table: z.string(),
  stamp: z.string(),
  enabled: z.boolean(),
});
const FunctionRow = z.object({ present: z.boolean() });

function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function stampOf(set: DbTriggerSet): string {
  return `${set.id}:${set.signature}`;
}

/** Every trigger in the database stamped as one of this set's. */
async function ownedTriggers(
  exec: Exec,
  set: DbTriggerSet,
): Promise<z.infer<typeof OwnedRow>[]> {
  return executeRows(exec, {
    query: sql.raw(
      `SELECT t.tgname::text AS name,
              c.relname::text AS table,
              obj_description(t.oid, 'pg_trigger') AS stamp,
              t.tgenabled = 'O' AS enabled
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE starts_with(coalesce(obj_description(t.oid, 'pg_trigger'), ''), ${lit(`${set.id}:`)})`,
    ),
    row: OwnedRow,
    label: `db-triggers: triggers of ${set.id}`,
  });
}

async function isUpToDate(exec: Exec, set: DbTriggerSet): Promise<boolean> {
  const owned = await ownedTriggers(exec, set);
  if (owned.length !== set.triggers.length) return false;
  for (const t of set.triggers) {
    const row = owned.find((o) => o.name === t.name && o.table === t.table);
    if (!row || row.stamp !== stampOf(set) || !row.enabled) return false;
  }
  for (const f of set.functions) {
    const rows = await executeRows(exec, {
      query: sql.raw(
        `SELECT to_regprocedure(${lit(`${f.name}(${f.args})`)}) IS NOT NULL AS present`,
      ),
      row: FunctionRow,
      label: `db-triggers: state of ${f.name}`,
    });
    if (!rows[0]?.present) return false;
  }
  return true;
}

async function installOne(
  db: Exec,
  set: DbTriggerSet,
): Promise<"installed" | "unchanged"> {
  if (await isUpToDate(db, set)) return "unchanged";
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('db_triggers'), hashtext(${set.id}))`,
    );
    if (await isUpToDate(tx, set)) return "unchanged";
    for (const f of set.functions) await tx.execute(sql.raw(f.ddl));
    for (const t of set.triggers) {
      await tx.execute(sql.raw(t.ddl));
      await tx.execute(
        sql.raw(
          `COMMENT ON TRIGGER "${t.name}" ON "${t.table}" IS ${lit(stampOf(set))}`,
        ),
      );
    }
    for (const o of await ownedTriggers(tx, set)) {
      if (set.triggers.some((t) => t.name === o.name && t.table === o.table)) {
        continue;
      }
      await tx.execute(sql.raw(`DROP TRIGGER "${o.name}" ON "${o.table}"`));
    }
    return "installed";
  });
}

export interface DbTriggerInstall {
  readonly id: string;
  readonly outcome: "installed" | "unchanged";
}

/**
 * Install (or leave alone, when already current) each declared trigger set —
 * at boot every `DbTrigger` contribution, in a test the sets its suite needs on
 * a throwaway database. Must run after migrations: every table must exist.
 * Then asserts every set is installed as written and throws if one is not — a
 * boot never proceeds without an invariant its plugin declared.
 */
export async function installDbTriggers(
  db: Exec,
  sets: readonly DbTriggerSet[],
): Promise<readonly DbTriggerInstall[]> {
  const ids = new Set<string>();
  for (const set of sets) {
    if (ids.has(set.id)) {
      throw new Error(
        `db-triggers: two trigger sets share the id "${set.id}".`,
      );
    }
    ids.add(set.id);
  }
  const results: DbTriggerInstall[] = [];
  for (const set of sets) {
    results.push({ id: set.id, outcome: await installOne(db, set) });
  }
  const stale: string[] = [];
  for (const set of sets) {
    if (!(await isUpToDate(db, set))) stale.push(set.id);
  }
  if (stale.length > 0) {
    throw new Error(
      `db-triggers: trigger set missing or out of date after install: ${stale.join(", ")}.`,
    );
  }
  return results;
}
