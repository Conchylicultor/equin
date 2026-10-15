import { createHash } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import {
  DERIVED_TABLE_OBJECT_STATE_TABLE,
  DERIVED_TABLE_STATE_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import {
  executeOne,
  executeRows,
} from "@plugins/database/plugins/sql-rows/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { z } from "zod";
import type {
  Rollup,
  RollupOp,
  RollupReconcile,
  RollupTrigger,
} from "@plugins/database/plugins/derived-tables/core";
import { DerivedTable } from "./contribution";

type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];
type Exec = NodePgDatabase | Tx;

const log = defineLogSink({
  id: "derived-tables",
  description:
    "Derived-tables rebuild ops log: rollup table/function/trigger DDL and the boot reconcile from source.",
});

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Installs the rollup layer and reconciles every rollup against its sources.
// Runs inside the migrations plugin's one boot schema-layer transaction
// (`applySchemaLayer`), after the migrations and the derived `updatedAt`
// triggers and before the views (a view may read a rollup).
//
// A rollup has TWO HALVES WITH DIFFERENT NATURES:
//
//   DEFINITION — the table, the maintain functions, the source triggers. Output
//   IS the definition, so it is skipped when unchanged: the table by its live
//   shape, the functions and each source table's triggers by a content
//   signature in `derived_table_state` (checked against the catalog, so an
//   object dropped out of band is reinstalled).
//
//   REPAIR — the reconcile. Its output depends on source DATA (a TRUNCATE fires
//   no trigger; a completeness argument resting on application invariants can
//   be broken by TS that moves no SQL; downtime and bulk loads), so NO
//   definition signature can license skipping it. It runs every boot. It is
//   DIFF-FIRST (D21): a read-only drift scan, and only for the drifted keys the
//   maintain functions' advisory locks then a re-aggregate in a fresh
//   statement that writes only what differs (see `Rollup.driftSql`). It
//   returns how many rows it wrote — a clean boot writes and locks nothing.
//
// TRIGGER DDL, ONE SOURCE TABLE PER SAVEPOINT, IN A FIXED ORDER (C12). A
// trigger change takes a ShareRowExclusive lock on its source table (an
// AccessExclusive one to drop a stale trigger) that is held until the schema
// layer commits — savepoints do not release locks. During a hot swap the old
// backend still writes those tables, so the layer takes them in one fixed
// order (by name: attempts < conversations < pushes, the order the app's
// writers touch them, parent before child): a writer in that order waits for
// the layer or the layer for it, never both. Only a table whose rollup
// triggers changed is locked at all, so a steady-state boot takes no source
// lock. A writer in the opposite order can still close a cycle; Postgres then
// aborts one side, and when that is the layer the boot fails loudly naming the
// table (D25: a loud failure, never a hang). The reconcile runs after every
// savepoint.
//
// `db` and `rollups` are passed in, never read from the database plugin or
// `DerivedTable.getContributions()`: the first would form an import cycle; the
// second would read empty in the `migration-applies-clean` check, a process
// that never boots.
//
// Returns what the reconcile did per rollup (C13). It does NOT publish it:
// this function also runs in the rolled-back dry run, so only the committing
// caller (the database plugin) publishes, after commit.
export async function rebuildDerivedTables(
  db: Exec,
  rollups: readonly Rollup[],
): Promise<RollupReconcile[]> {
  if (rollups.length === 0) return [];
  const ordered = [...rollups].sort((a, b) => a.table.localeCompare(b.table));
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.table === ordered[i - 1]!.table) {
      throw new Error(
        `derived-tables: rollup "${ordered[i]!.table}" is declared twice`,
      );
    }
  }

  const changed = await db.transaction((tx) => installDefinitions(tx, ordered));

  const results: RollupReconcile[] = [];
  for (const r of ordered) {
    // A transaction of its own (a savepoint inside the schema layer), so the
    // advisory locks are held until the heal commits whoever the caller is.
    const counts = await db.transaction((tx) => reconcile(tx, r));
    results.push({
      table: r.table,
      ...counts,
      definitionChanged: changed.has(r.table),
    });
  }

  const healed = results.filter((r) => r.upserted + r.deleted > 0);
  log.publish(
    healed.length === 0
      ? `[derived-tables] reconciled ${results.length} rollup(s): no drift`
      : `[derived-tables] reconcile HEALED drift: ${healed
          .map((r) => `${r.table} (+${r.upserted} -${r.deleted})`)
          .join(", ")}`,
    healed.length === 0 ? "stdout" : "stderr",
  );
  return results;
}

// ── the repair half ──────────────────────────────────────────────────────────

async function reconcile(
  tx: Tx,
  r: Rollup,
): Promise<{ upserted: number; deleted: number }> {
  const { keys } = await executeOne(tx, {
    query: drizzleSql.raw(r.driftSql),
    row: z.object({ keys: z.array(z.string()) }),
    label: `derived-tables: drift ${r.table}`,
  });
  if (keys.length === 0) return { upserted: 0, deleted: 0 };
  await tx.execute(drizzleSql.raw(r.lockSql(keys)));
  return executeOne(tx, {
    query: drizzleSql.raw(r.reconcileSql(keys)),
    row: z.object({ upserted: z.number(), deleted: z.number() }),
    label: `derived-tables: reconcile ${r.table}`,
  });
}

// ── the definition half ──────────────────────────────────────────────────────

const STATE_DDL = `CREATE TABLE IF NOT EXISTS "public"."${DERIVED_TABLE_OBJECT_STATE_TABLE}" (
  name      text PRIMARY KEY,
  signature text NOT NULL
)`;

/** Every rollup table whose definition was (re)installed. */
async function installDefinitions(
  tx: Tx,
  ordered: readonly Rollup[],
): Promise<Set<string>> {
  const changed = new Set<string>();
  await ensureStateTable(tx);
  const stored = await readSignatures(tx);

  // 1. Tables — by their live shape.
  for (const r of ordered) {
    if (await ensureRollupTable(tx, r)) changed.add(r.table);
  }

  // 2. Maintain functions — CREATE OR REPLACE takes no table lock.
  const isManagedFn = managedFunctionMatcher(ordered);
  const fnsBefore = new Set(
    (await listTriggerFunctions(tx)).filter(isManagedFn),
  );
  for (const r of ordered) {
    const name = `functions:${r.table}`;
    const sig = sha(r.sources.map((s) => s.functionDdl).join("\n--\n"));
    if (
      stored.get(name) === sig &&
      r.sources.every((s) => fnsBefore.has(s.functionName))
    ) {
      continue;
    }
    await assertSelectDeclared(tx, r);
    for (const s of r.sources) {
      await tx.execute(drizzleSql.raw(s.functionDdl));
    }
    await stamp(tx, name, sig);
    changed.add(r.table);
  }

  // 3. Triggers — one source table per savepoint, in a fixed order.
  const desired = desiredTriggers(ordered);
  const installed = (await listTriggers(tx)).filter((t) => isManagedFn(t.fn));
  const tables = [
    ...new Set([...desired.keys(), ...installed.map((t) => t.table)]),
  ].sort();
  for (const table of tables) {
    const want = desired.get(table) ?? [];
    const have = installed.filter((t) => t.table === table);
    const name = `triggers:${table}`;
    const sig = sha(want.map((w) => w.trigger.ddl).join("\n--\n"));
    // Name, function AND shape (timing, level, op, no column list): a trigger
    // altered out of band is reinstalled here, not left for A21 to refuse.
    const upToDate =
      stored.get(name) === (want.length === 0 ? undefined : sig) &&
      have.length === want.length &&
      want.every((w) =>
        have.some(
          (h) =>
            h.name === w.trigger.name &&
            triggerProblems(h, w.functionName, w.trigger.op).length === 0,
        ),
      );
    if (upToDate) continue;

    const wantNames = new Set(want.map((w) => w.trigger.name));
    try {
      await tx.transaction(async (sp) => {
        for (const stale of have.filter((h) => !wantNames.has(h.name))) {
          await sp.execute(
            drizzleSql.raw(
              `DROP TRIGGER IF EXISTS ${q(stale.name)} ON "public".${q(table)}`,
            ),
          );
        }
        for (const w of want) {
          await sp.execute(drizzleSql.raw(w.trigger.ddl));
        }
        if (want.length === 0) await unstamp(sp, name);
        else await stamp(sp, name, sig);
      });
    } catch (e) {
      throw new Error(
        `derived-tables: installing the rollup triggers on "${table}" failed. Source tables are installed one savepoint each, in the fixed order [${tables.join(", ")}]; a writer taking them in another order during a hot swap can deadlock with the boot (SQLSTATE 40P01), which fails it loudly here — retry the deploy once that writer is gone. Cause: ${(e as Error).message}`,
        { cause: e },
      );
    }
    log.publish(
      `[derived-tables] installed the rollup triggers on ${table}: ${want
        .map((w) => w.trigger.name)
        .join(", ")}${
        have.some((h) => !wantNames.has(h.name))
          ? ` (dropped ${have
              .filter((h) => !wantNames.has(h.name))
              .map((h) => h.name)
              .join(", ")})`
          : ""
      }`,
    );
    for (const r of ordered) {
      if (
        r.sources.some((s) => s.table === table) ||
        have.some((h) => belongsTo(h.fn, r.table))
      ) {
        changed.add(r.table);
      }
    }
  }

  // 4. Maintain functions no trigger calls any more: a legacy hand-written one
  // (`<rollup>_maintain`) or a dropped source's.
  const wantFns = new Set(
    ordered.flatMap((r) => r.sources.map((s) => s.functionName)),
  );
  for (const fn of (await listTriggerFunctions(tx)).filter(isManagedFn)) {
    if (wantFns.has(fn)) continue;
    await tx.execute(
      drizzleSql.raw(`DROP FUNCTION IF EXISTS "public".${q(fn)}()`),
    );
    log.publish(`[derived-tables] dropped the unused maintain function ${fn}`);
    for (const r of ordered) if (belongsTo(fn, r.table)) changed.add(r.table);
  }

  // 5. A21: the installed rollup triggers are exactly the generated ones.
  await assertTriggersInstalled(tx, ordered, isManagedFn);

  if (changed.size > 0) {
    log.publish(
      `[derived-tables] (re)installed rollup definition(s): ${[...changed].join(", ")}`,
    );
  }
  return changed;
}

// The per-object state table (`functions:<rollup>`, `triggers:<table>`).
//
// The one-row whole-layer table older code keeps its signature in
// (`DERIVED_TABLE_STATE_TABLE`, `(id boolean, signature)`) is left in its shape
// — older code still runs against this database whenever main is reverted past
// this layer, or a branch without it boots on a fork of main — and only
// EMPTIED, every boot. Older code then finds no signature, reinstalls its
// legacy triggers beside these (harmless duplicates: both maintain the same
// rows correctly) and runs; the next boot of this code drops them as stale.
// Left holding its row, older code would trust it and skip, leaving its rollups
// with no trigger at all. Drop it once no supported build reads it.
async function ensureStateTable(tx: Tx): Promise<void> {
  await tx.execute(drizzleSql.raw(STATE_DDL));
  const legacy = await executeOne(tx, {
    query: drizzleSql`SELECT to_regclass(${`public."${DERIVED_TABLE_STATE_TABLE}"`}) IS NOT NULL AS present`,
    row: z.object({ present: z.boolean() }),
    label: "derived-tables: legacy state table",
  });
  if (legacy.present) {
    await tx.execute(
      drizzleSql.raw(`DELETE FROM "public"."${DERIVED_TABLE_STATE_TABLE}"`),
    );
  }
}

async function readSignatures(tx: Tx): Promise<Map<string, string>> {
  const rows = await executeRows(tx, {
    query: drizzleSql.raw(
      `SELECT name, signature FROM "public"."${DERIVED_TABLE_OBJECT_STATE_TABLE}"`,
    ),
    row: z.object({ name: z.string(), signature: z.string() }),
    label: "derived-tables: read signatures",
  });
  return new Map(rows.map((r) => [r.name, r.signature]));
}

async function stamp(tx: Tx, name: string, signature: string): Promise<void> {
  await tx.execute(drizzleSql`
    INSERT INTO "public".${drizzleSql.raw(`"${DERIVED_TABLE_OBJECT_STATE_TABLE}"`)} (name, signature)
    VALUES (${name}, ${signature})
    ON CONFLICT (name) DO UPDATE SET signature = EXCLUDED.signature`);
}

async function unstamp(tx: Tx, name: string): Promise<void> {
  await tx.execute(drizzleSql`
    DELETE FROM "public".${drizzleSql.raw(`"${DERIVED_TABLE_OBJECT_STATE_TABLE}"`)} WHERE name = ${name}`);
}

// Creates the table when missing; recreates it when its live shape (columns,
// types, nullability, key) differs from the declaration. A rollup is derived
// state, so a shape change is a drop and a refill by the reconcile below — never
// a migration. CASCADE drops a view reading it; the schema layer's
// `rebuildDerivedViews` runs next and restores every declared view it finds
// missing. Returns whether it (re)created the table.
async function ensureRollupTable(tx: Tx, r: Rollup): Promise<boolean> {
  const live = await executeRows(tx, {
    query: drizzleSql`
      SELECT a.attname::text AS name,
             format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS not_null,
             COALESCE((SELECT a.attnum = ANY(i.indkey::int2[]) FROM pg_index i
                        WHERE i.indrelid = a.attrelid AND i.indisprimary), false) AS pk
        FROM pg_attribute a
       WHERE a.attrelid = to_regclass(${`public."${r.table}"`})
         AND a.attnum > 0 AND NOT a.attisdropped`,
    row: z.object({
      name: z.string(),
      type: z.string(),
      not_null: z.boolean(),
      pk: z.boolean(),
    }),
    label: `derived-tables: ${r.table} shape`,
  });
  if (live.length > 0) {
    const describe = (c: {
      name: string;
      type: string;
      notNull: boolean;
      pk: boolean;
    }) => `${c.name} ${c.type}${c.pk ? " pk" : c.notNull ? " not null" : ""}`;
    const want = r.columns
      .map((c) => describe({ ...c, type: c.sqlType, pk: c.name === r.key }))
      .sort();
    const have = live
      .map((c) => describe({ ...c, notNull: c.not_null }))
      .sort();
    if (want.join("\n") === have.join("\n")) return false;
    log.publish(
      `[derived-tables] ${r.table}: live shape [${have.join(", ")}] differs from the declared [${want.join(", ")}] — dropping it (CASCADE) and refilling it from source`,
      "stderr",
    );
    await tx.execute(
      drizzleSql.raw(`DROP TABLE "public".${q(r.table)} CASCADE`),
    );
  }
  await tx.execute(drizzleSql.raw(r.createTableDdl));
  return true;
}

// A function this layer owns: a generated `<rollup>__<source>_maintain` or a
// legacy hand-written `<rollup>_maintain`, for a declared rollup. Never a
// change-feed `live_state_*` or a `*_derive_updated_at` function.
function managedFunctionMatcher(
  rollups: readonly Rollup[],
): (fn: string) => boolean {
  return (fn) =>
    fn.endsWith("_maintain") && rollups.some((r) => belongsTo(fn, r.table));
}

function belongsTo(fn: string, rollup: string): boolean {
  return fn === `${rollup}_maintain` || fn.startsWith(`${rollup}__`);
}

interface Desired {
  rollup: string;
  functionName: string;
  trigger: RollupTrigger;
}

function desiredTriggers(rollups: readonly Rollup[]): Map<string, Desired[]> {
  const out = new Map<string, Desired[]>();
  for (const r of rollups) {
    for (const s of r.sources) {
      const list = out.get(s.table) ?? [];
      for (const trigger of s.triggers) {
        list.push({ rollup: r.table, functionName: s.functionName, trigger });
      }
      out.set(s.table, list);
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.trigger.name.localeCompare(b.trigger.name));
  }
  return out;
}

async function listTriggerFunctions(tx: Tx): Promise<string[]> {
  const rows = await executeRows(tx, {
    query: drizzleSql.raw(`
      SELECT p.proname::text AS name FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype AND p.pronargs = 0`),
    row: z.object({ name: z.string() }),
    label: "derived-tables: list trigger functions",
  });
  return rows.map((r) => r.name);
}

interface InstalledTrigger {
  name: string;
  table: string;
  fn: string;
  tgtype: number;
  ncols: number;
}

async function listTriggers(tx: Tx): Promise<InstalledTrigger[]> {
  return executeRows(tx, {
    query: drizzleSql.raw(`
      SELECT t.tgname::text AS name, c.relname::text AS "table", p.proname::text AS fn,
             t.tgtype::int AS tgtype, cardinality(t.tgattr::int2[])::int AS ncols
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = 'public' AND NOT t.tgisinternal`),
    row: z.object({
      name: z.string(),
      table: z.string(),
      fn: z.string(),
      tgtype: z.number(),
      ncols: z.number(),
    }),
    label: "derived-tables: list triggers",
  });
}

// pg_trigger.tgtype bits (src/include/catalog/pg_trigger.h).
const TGTYPE_ROW = 1;
const TGTYPE_BEFORE = 2;
const TGTYPE_INSTEAD = 64;
const TGTYPE_EVENT: Record<RollupOp, number> = {
  insert: 4,
  delete: 8,
  update: 16,
};
const TGTYPE_EVENTS = 4 | 8 | 16 | 32;

// What is wrong with an installed trigger against its declaration: it must call
// `fn`, be AFTER … FOR EACH STATEMENT, fire on exactly `op`, and carry NO column
// list (C1: transition tables are refused on a trigger with one, and the diff
// lives in the function). Empty when it matches.
function triggerProblems(
  t: InstalledTrigger,
  fn: string,
  op: RollupOp,
): string[] {
  const problems: string[] = [];
  if (t.fn !== fn) problems.push(`${t.name} calls ${t.fn}, not ${fn}`);
  if ((t.tgtype & (TGTYPE_ROW | TGTYPE_BEFORE | TGTYPE_INSTEAD)) !== 0) {
    problems.push(`${t.name} is not AFTER … FOR EACH STATEMENT`);
  }
  if ((t.tgtype & TGTYPE_EVENTS) !== TGTYPE_EVENT[op]) {
    problems.push(`${t.name} does not fire on exactly ${op}`);
  }
  if (t.ncols !== 0) problems.push(`${t.name} has a column list`);
  return problems;
}

// A21: the catalog holds exactly the generated rollup triggers, each on its
// source table and matching its declaration (`triggerProblems`).
async function assertTriggersInstalled(
  tx: Tx,
  rollups: readonly Rollup[],
  isManagedFn: (fn: string) => boolean,
): Promise<void> {
  const installed = (await listTriggers(tx)).filter((t) => isManagedFn(t.fn));
  const problems: string[] = [];
  const expected = new Map<
    string,
    { table: string; fn: string; op: RollupOp }
  >();
  for (const r of rollups) {
    for (const s of r.sources) {
      for (const t of s.triggers) {
        expected.set(`${s.table}.${t.name}`, {
          table: s.table,
          fn: s.functionName,
          op: t.op,
        });
      }
    }
  }
  for (const t of installed) {
    const want = expected.get(`${t.table}.${t.name}`);
    if (want === undefined) {
      problems.push(
        `unexpected trigger ${t.name} on ${t.table} (calls ${t.fn})`,
      );
      continue;
    }
    expected.delete(`${t.table}.${t.name}`);
    problems.push(...triggerProblems(t, want.fn, want.op));
  }
  for (const [where] of expected) problems.push(`missing trigger ${where}`);
  if (problems.length > 0) {
    throw new Error(
      `derived-tables: the installed rollup triggers do not match their declarations (A21):\n  - ${problems.join("\n  - ")}`,
    );
  }
}

// The rollup's `select`, compiled as a temp view and checked against its
// declaration before its maintain functions are (re)installed:
//
//   - its output columns are exactly the table's (the projection reads them by
//     name, so a missing one fails at once but an extra one would be dropped
//     silently);
//   - every column it reads is declared — on a source table, its primary key,
//     `carry` or a `reads` entry; on a via table, `match` or `key`. An UPDATE
//     re-aggregates only the rows where those moved (C1), so an undeclared
//     read is a write that silently stops maintaining the rollup until the
//     next boot's reconcile heals it.
//
// Read off the view's own dependency records (`pg_depend`: Postgres records
// every column a view's query names), so it is what Postgres parsed, not a
// guess at the SQL text. A whole-row reference (`row_to_json(c)`) records no
// column and is not seen. The view is dropped before the savepoint ends.
async function assertSelectDeclared(tx: Tx, r: Rollup): Promise<void> {
  const view = "_rollup_select_check";
  const regclass = `pg_temp.${q(view)}`;
  const problems = await tx.transaction(async (sp) => {
    try {
      await sp.execute(
        drizzleSql.raw(`CREATE TEMP VIEW ${q(view)} AS ${r.selectCheckSql}`),
      );
    } catch (e) {
      throw new Error(
        `derived-tables: rollup "${r.table}"'s select does not compile: ${(e as Error).message}`,
        { cause: e },
      );
    }
    const out = await executeRows(sp, {
      query: drizzleSql`
        SELECT attname::text AS name FROM pg_attribute
         WHERE attrelid = ${regclass}::regclass AND attnum > 0 AND NOT attisdropped`,
      row: z.object({ name: z.string() }),
      label: `derived-tables: ${r.table} select columns`,
    });
    const reads = await executeRows(sp, {
      query: drizzleSql`
        SELECT DISTINCT n.nspname::text AS schema, c.relname::text AS "table",
               a.attname::text AS "column"
          FROM pg_depend d
          JOIN pg_rewrite rw ON rw.oid = d.objid
          JOIN pg_class c ON c.oid = d.refobjid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_attribute a
                 ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid AND d.refobjsubid > 0
         WHERE d.classid = 'pg_rewrite'::regclass
           AND d.refclassid = 'pg_class'::regclass
           AND rw.ev_class = ${regclass}::regclass
           AND d.refobjid <> rw.ev_class`,
      row: z.object({
        schema: z.string(),
        table: z.string(),
        column: z.string().nullable(),
      }),
      label: `derived-tables: ${r.table} select reads`,
    });
    await sp.execute(drizzleSql.raw(`DROP VIEW ${regclass}`));
    return selectProblems(
      r,
      out.map((c) => c.name),
      reads,
    );
  });
  if (problems.length > 0) {
    throw new Error(
      `derived-tables: rollup "${r.table}"'s select does not match its declaration:\n  - ${problems.join("\n  - ")}`,
    );
  }
}

/** The mismatches between a rollup's compiled `select` and its declaration. */
function selectProblems(
  r: Rollup,
  output: readonly string[],
  reads: readonly {
    schema: string;
    table: string;
    column: string | null;
  }[],
): string[] {
  const problems: string[] = [];
  const want = new Set(r.columns.map((c) => c.name));
  const got = new Set(output);
  for (const c of want) {
    if (!got.has(c)) problems.push(`it returns no column "${c}"`);
  }
  for (const c of got) {
    if (!want.has(c))
      problems.push(`it returns "${c}", not a column of the table`);
  }
  const declared = new Map<string, Set<string>>();
  const allow = (table: string, cols: readonly string[]) => {
    const set = declared.get(table) ?? new Set<string>();
    for (const c of cols) set.add(c);
    declared.set(table, set);
  };
  for (const s of r.sources) {
    allow(s.table, [...s.pk, s.carry, ...s.reads]);
    if (s.via !== undefined) allow(s.via.table, [s.via.match, s.via.key]);
  }
  for (const d of reads) {
    const cols = d.schema === "public" ? declared.get(d.table) : undefined;
    if (cols === undefined) {
      problems.push(
        `it reads ${d.schema}.${d.table}, which is neither a source nor a via table`,
      );
    } else if (d.column !== null && !cols.has(d.column)) {
      problems.push(
        `it reads ${d.table}.${d.column}, which no declaration names (a source's pk, carry or reads; a via's match or key) — an UPDATE of it would not re-aggregate`,
      );
    }
  }
  return [...new Set(problems)];
}

// ── consumers' views of the collection ──────────────────────────────────────

// The set of rollup table names. The change-feed merges this into its trigger
// DENYLIST so no NOTIFY trigger is installed on a rollup (it is a pure
// read-cache fed by its source's change, never an independent write surface — a
// trigger on it would double-route the source change through the rollup's id
// space and defeat the correctly-scoped source-driven recompute). Complete at
// boot — contributions are collected before onReadyBlocking.
export function feedExemptTables(): Set<string> {
  return new Set(DerivedTable.getContributions().map((r) => r.table));
}

/**
 * Every rollup → the source tables whose triggers maintain it (C30). A write
 * to a rollup is always caused by a write to one of these, which is what a
 * reader of the rollup must be routed by.
 */
export function rollupSources(): Map<string, string[]> {
  return rollupSourcesOf(DerivedTable.getContributions());
}

/** `rollupSources` over an explicit rollup list (a headless suite has no contributions). Pure. */
export function rollupSourcesOf(
  rollups: readonly Rollup[],
): Map<string, string[]> {
  return new Map(rollups.map((r) => [r.table, r.sources.map((s) => s.table)]));
}
