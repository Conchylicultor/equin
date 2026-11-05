import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
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
import {
  defineDbTriggers,
  installDbTriggers,
  type DbTriggerInstall,
  type DbTriggerSet,
} from "@plugins/database/plugins/db-triggers/server";
import type {
  Rollup,
  RollupReconcile,
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

// A rollup has TWO HALVES WITH DIFFERENT NATURES:
//
//   DEFINITION — the table, the maintain functions, the source triggers. Output
//   IS the definition, so it is skipped when unchanged: the table by its live
//   shape (`prepareRollupTables`), the functions and triggers by the one trigger
//   installer (`database/db-triggers`), as one set per rollup
//   (`rollupTriggerSet`: `rollup.<table>`) — per-object stamps checked against
//   the catalog, every source table locked in the installer's one fixed order,
//   one savepoint each (C12), a stray or dropped source's trigger dropped.
//
//   REPAIR — the reconcile (`reconcileRollups`). Its output depends on source
//   DATA (a TRUNCATE fires no trigger; a completeness argument resting on
//   application invariants can be broken by TS that moves no SQL; downtime and
//   bulk loads), so NO definition signature can license skipping it. It runs
//   every boot, after the triggers. It is DIFF-FIRST (D21): a read-only drift
//   scan, and only for the drifted keys the maintain functions' advisory locks
//   then a re-aggregate in a fresh statement that writes only what differs (see
//   `Rollup.driftSql`). It returns how many rows it wrote — a clean boot writes
//   and locks nothing.
//
// The boot schema layer (`applySchemaLayer`, one transaction) runs the three
// steps itself, so its ONE installer call holds every declared trigger set and
// can sweep the removed ones; `rebuildDerivedTables` is the same three steps
// over the rollups alone (a test database's `installRollups`).
//
// `db` and `rollups` are passed in, never read from the database plugin or
// `DerivedTable.getContributions()`: the first would form an import cycle; the
// second would read empty in the `migration-applies-clean` check, a process
// that never boots.
//
// Returns what the reconcile did per rollup (C13). It does NOT publish it:
// this also runs in the rolled-back dry run, so only the committing caller
// (the database plugin) publishes, after commit.
export async function rebuildDerivedTables(
  db: Exec,
  rollups: readonly Rollup[],
): Promise<RollupReconcile[]> {
  if (rollups.length === 0) return [];
  const { recreated, triggerSets } = await prepareRollupTables(db, rollups);
  const installs = await installDbTriggers(db, triggerSets);
  return reconcileRollups(db, rollups, { recreated, installs });
}

/** What `prepareRollupTables` hands the rest of the boot install. */
export interface PreparedRollups {
  /** The rollup tables it (re)created. */
  readonly recreated: ReadonlySet<string>;
  /** Each rollup's maintain functions and source triggers, as a db-triggers set. */
  readonly triggerSets: readonly DbTriggerSet[];
}

/**
 * The rollup tables, by their live shape — created when missing, dropped and
 * recreated when it differs (refilled by the reconcile) — and each rollup's
 * trigger set for the installer. Runs before the trigger install: a maintain
 * function writes its table.
 */
export async function prepareRollupTables(
  db: Exec,
  rollups: readonly Rollup[],
): Promise<PreparedRollups> {
  const ordered = byTable(rollups);
  return db.transaction(async (tx) => {
    const older = await takeOlderStateTables(tx);
    const recreated = new Set<string>();
    for (const r of ordered) {
      if (await ensureRollupTable(tx, r)) recreated.add(r.table);
    }
    const adoptable = adoptableSourceTables(ordered, older);
    return {
      recreated,
      triggerSets: ordered.map((r) => rollupTriggerSet(r, adoptable)),
    };
  });
}

/** A rollup's maintain functions and source triggers, as a db-triggers set. */
function rollupTriggerSet(
  r: Rollup,
  adoptable: ReadonlySet<string>,
): DbTriggerSet {
  return defineDbTriggers({
    id: rollupSetId(r.table),
    functions: r.sources.map((s) => ({
      name: s.functionName,
      args: "",
      ddl: s.functionDdl,
    })),
    triggers: r.sources.flatMap((s) =>
      s.triggers.map((t) => ({
        name: t.name,
        table: s.table,
        ddl: t.ddl,
        // Installed as written by the previous installer, which kept no
        // comment on it: adopted, not re-created (see `takeOlderStateTables`).
        ...(adoptable.has(s.table) ? { legacyStamp: null } : {}),
      })),
    ),
    // The install-time assert of the `select` against its declaration, before
    // any of the rollup's DDL (re)runs.
    beforeInstall: (exec) => assertSelectDeclared(exec, r),
  });
}

function rollupSetId(table: string): string {
  return `rollup.${table}`;
}

/**
 * The repair half, every rollup, readers last. `recreated` and `installs` (the
 * tables `prepareRollupTables` made, the trigger installer's outcomes) only
 * fill each result's `definitionChanged`.
 */
export async function reconcileRollups(
  db: Exec,
  rollups: readonly Rollup[],
  definition: {
    readonly recreated: ReadonlySet<string>;
    readonly installs: readonly DbTriggerInstall[];
  },
): Promise<RollupReconcile[]> {
  if (rollups.length === 0) return [];
  const installed = new Set(
    definition.installs
      .filter((i) => i.outcome === "installed")
      .map((i) => i.id),
  );
  const results: RollupReconcile[] = [];
  for (const r of readersLast(byTable(rollups))) {
    // A transaction of its own (a savepoint inside the schema layer), so the
    // advisory locks are held until the heal commits whoever the caller is.
    const counts = await db.transaction((tx) => reconcile(tx, r));
    results.push({
      table: r.table,
      ...counts,
      definitionChanged:
        definition.recreated.has(r.table) ||
        installed.has(rollupSetId(r.table)),
    });
  }

  const changed = results.filter((r) => r.definitionChanged);
  if (changed.length > 0) {
    log.publish(
      `[derived-tables] (re)installed rollup definition(s): ${changed.map((r) => r.table).join(", ")}`,
    );
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

/** The rollups by table name; a table declared twice is refused. */
function byTable(rollups: readonly Rollup[]): Rollup[] {
  const ordered = [...rollups].sort((a, b) => a.table.localeCompare(b.table));
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.table === ordered[i - 1]!.table) {
      throw new Error(
        `derived-tables: rollup "${ordered[i]!.table}" is declared twice`,
      );
    }
  }
  return ordered;
}

// ── the repair half ──────────────────────────────────────────────────────────

// The rollups in reconcile order: one whose source is another rollup's table
// (a materialized aggregate over the attempt rollups) after that rollup, so
// its heal reads the healed rows — and the inner heal's writes, which fire the
// outer's triggers, land before the outer's drift scan. By name otherwise.
// A cycle cannot be maintained by triggers and is refused.
function readersLast(ordered: readonly Rollup[]): Rollup[] {
  const byTable = new Map(ordered.map((r) => [r.table, r]));
  const out: Rollup[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (r: Rollup, path: readonly string[]): void => {
    const seen = state.get(r.table);
    if (seen === "done") return;
    if (seen === "visiting") {
      throw new Error(
        `derived-tables: rollups read each other in a cycle (${[...path, r.table].join(" → ")})`,
      );
    }
    state.set(r.table, "visiting");
    for (const s of r.sources) {
      const inner = byTable.get(s.table);
      if (inner !== undefined) visit(inner, [...path, r.table]);
    }
    state.set(r.table, "done");
    out.push(r);
  };
  for (const r of ordered) visit(r, []);
  return out;
}

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

// The state tables older builds keep their signatures in: the one-row
// whole-layer `DERIVED_TABLE_STATE_TABLE` (`(id boolean, signature)`) and the
// per-object `DERIVED_TABLE_OBJECT_STATE_TABLE` (`functions:<rollup>`,
// `triggers:<table>`). This build reads neither — its stamps live on the
// objects (db-triggers) — but older code still runs against this database
// whenever main is reverted past this layer, or a branch without it boots on a
// fork of main. Each is left in its shape and only EMPTIED, every boot: older
// code then finds no signature and reinstalls its own functions and triggers
// (harmless: the next boot of this code sees their catalog definition differ
// from its stamp and reinstalls its own). Left holding rows, older code would
// trust them and skip, running on this build's maintain functions or none.
// Drop them once no supported build reads them.
//
// Before emptying the per-object one it reads it: a `triggers:<table>` row
// equal to the signature the previous installer computed for this build's
// triggers on that table says they are installed as written, so the trigger
// installer adopts them (restamps) instead of re-creating them — which would
// take SHARE ROW EXCLUSIVE on every source table at once on the first boot of
// the one installer, during a hot swap. Compatibility only: drop with the
// tables.
async function takeOlderStateTables(
  tx: Tx,
): Promise<ReadonlyMap<string, string>> {
  let signatures = new Map<string, string>();
  for (const table of [
    DERIVED_TABLE_STATE_TABLE,
    DERIVED_TABLE_OBJECT_STATE_TABLE,
  ]) {
    const { present } = await executeOne(tx, {
      query: drizzleSql`SELECT to_regclass(${`public."${table}"`}) IS NOT NULL AS present`,
      row: z.object({ present: z.boolean() }),
      label: `derived-tables: older state table ${table}`,
    });
    if (!present) continue;
    if (table === DERIVED_TABLE_OBJECT_STATE_TABLE) {
      const rows = await executeRows(tx, {
        query: drizzleSql.raw(
          `SELECT name, signature FROM "public"."${table}"`,
        ),
        row: z.object({ name: z.string(), signature: z.string() }),
        label: "derived-tables: older signatures",
      });
      signatures = new Map(rows.map((r) => [r.name, r.signature]));
    }
    await tx.execute(drizzleSql.raw(`DELETE FROM "public"."${table}"`));
  }
  return signatures;
}

// The source tables whose `triggers:<table>` signature, as the previous
// installer computed it (every rollup trigger on the table, by name, their DDL
// joined), is the one recorded.
function adoptableSourceTables(
  rollups: readonly Rollup[],
  older: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const byTable = new Map<string, { name: string; ddl: string }[]>();
  for (const r of rollups) {
    for (const s of r.sources) {
      const list = byTable.get(s.table) ?? [];
      list.push(...s.triggers);
      byTable.set(s.table, list);
    }
  }
  const out = new Set<string>();
  for (const [table, triggers] of byTable) {
    const sig = sha256Hex(
      [...triggers]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => t.ddl)
        .join("\n--\n"),
    );
    if (older.get(`triggers:${table}`) === sig) out.add(table);
  }
  return out;
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
async function assertSelectDeclared(tx: Exec, r: Rollup): Promise<void> {
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

// The set of feed-exempt rollup table names (every rollup but a `fed` one,
// whose readers route by its own rows). The change-feed merges this into its trigger
// DENYLIST so no NOTIFY trigger is installed on a rollup (it is a pure
// read-cache fed by its source's change, never an independent write surface — a
// trigger on it would double-route the source change through the rollup's id
// space and defeat the correctly-scoped source-driven recompute). Complete at
// boot — contributions are collected before onReadyBlocking.
export function feedExemptTables(): Set<string> {
  return new Set(
    DerivedTable.getContributions()
      .filter((r) => !r.fed)
      .map((r) => r.table),
  );
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
  // A fed rollup is its own change source: a reader of it is a base reader.
  return new Map(
    rollups
      .filter((r) => !r.fed)
      .map((r) => [r.table, r.sources.map((s) => s.table)]),
  );
}
