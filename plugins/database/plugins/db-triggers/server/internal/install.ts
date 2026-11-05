import { sql } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import {
  schemaOf,
  type DbFunctionDdl,
  type DbTriggerDdl,
  type DbTriggerExec,
  type DbTriggerSet,
} from "./define";

// ── The one trigger installer ───────────────────────────────────────────────
//
// Every trigger the app declares — a plugin's invariant (`DbTrigger`), a
// table's derived `updatedAt`, a rollup's maintain triggers, graphile's
// superseded-row trigger — is installed here, by one protocol:
//
// STAMPS. Each object the installer writes carries a COMMENT
// `db-triggers:<set id>:<sha256 of its DDL>:<md5 of its catalog definition>`.
// The last field is `pg_get_functiondef` / `pg_get_triggerdef` read right
// after the DDL ran, so "installed as written" is a catalog-only read that
// takes no lock on any table, and it notices what a COMMENT alone cannot: an
// object replaced out of band (`CREATE OR REPLACE` keeps the OID, and with it
// the comment — an older build re-installing its own maintain function on a
// fork, a trigger altered by hand). A trigger dropped out of band takes its
// stamp with it; a disabled one counts as out of date.
//
// PER OBJECT. Only an object whose stamp is stale is re-run: a changed function
// body is one `CREATE OR REPLACE FUNCTION` (no table lock), never a reinstall of
// the triggers that call it (they reference it by OID).
//
// OWNERSHIP. A set owns what carries its stamp, and every trigger that calls
// one of its functions. What it owns but no longer declares is dropped — a
// trigger first (ACCESS EXCLUSIVE, for that one statement's table), then the
// function. With `sweep: { schema }`, the caller declares EVERY set living in
// that schema (the boot schema layer for `public`), and a set stamped there
// that nobody declares any more — a removed rollup, a removed table's
// `updatedAt` — is dropped whole.
//
// LOCK ORDER (C12). A trigger change takes SHARE ROW EXCLUSIVE on its table (a
// drop, ACCESS EXCLUSIVE) and, inside the boot schema layer, holds it until
// that one transaction commits — savepoints release nothing. During a hot swap
// the previous backend still writes those tables, so the installer takes them
// in ONE fixed order across every set (by `<schema>.<table>`, one savepoint
// each): a writer in that order waits for the installer or the installer for
// it, never both. A writer in another order can still close a cycle; Postgres
// aborts one side, and when that is the installer it fails loudly naming the
// table (a loud failure, never a hang). A current table takes no lock at all.
//
// SERIALIZED. A stale set's work runs under a transaction-scoped advisory lock
// per set (taken in id order) and is re-planned under them, so two installers
// racing on one database (a booting backend and a test process) never both run
// it. Then every set is asserted current, or the install throws.

const STAMP_PREFIX = "db-triggers:";

const log = defineLogSink({
  id: "db-triggers",
  description:
    "Trigger installer ops log: which declared trigger sets the boot schema layer (re)installed or dropped, and on which tables.",
});

function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function fnKey(f: DbFunctionDdl): string {
  return `${schemaOf(f)}.${f.name}`;
}

/** `to_regprocedure` / `COMMENT ON FUNCTION`'s spelling of a declared function. */
function fnSignature(f: DbFunctionDdl): string {
  return `${qi(schemaOf(f))}.${qi(f.name)}(${f.args})`;
}

function tableKey(t: {
  readonly schema?: string;
  readonly table: string;
}): string {
  return `${schemaOf(t)}.${t.table}`;
}

function triggerKey(t: DbTriggerDdl): string {
  return `${tableKey(t)}.${t.name}`;
}

/** The stamp without its catalog field: what the DDL says. */
function ddlStamp(set: DbTriggerSet, ddl: string): string {
  return `${STAMP_PREFIX}${set.id}:${sha256Hex(ddl)}`;
}

/** The set id a stamp names, or null for a comment that is not one. */
function stampOwner(comment: string | null): string | null {
  if (comment === null || !comment.startsWith(STAMP_PREFIX)) return null;
  const id = comment.slice(STAMP_PREFIX.length).split(":")[0];
  return id === undefined || id === "" ? null : id;
}

// ── Reading the catalog ─────────────────────────────────────────────────────

const TriggerRow = z.object({
  schema: z.string(),
  table: z.string(),
  name: z.string(),
  comment: z.string().nullable(),
  enabled: z.boolean(),
  def: z.string(),
  fn: z.string(),
});
type TriggerRow = z.infer<typeof TriggerRow>;

const DeclaredFunctionRow = z.object({
  signature: z.string(),
  oid: z.string().nullable(),
  comment: z.string().nullable(),
  def: z.string().nullable(),
});

const StampedFunctionRow = z.object({
  oid: z.string(),
  schema: z.string(),
  regprocedure: z.string(),
  comment: z.string(),
});
type StampedFunctionRow = z.infer<typeof StampedFunctionRow>;

interface Catalog {
  readonly triggers: readonly TriggerRow[];
  /** By declared signature. */
  readonly declaredFunctions: ReadonlyMap<
    string,
    z.infer<typeof DeclaredFunctionRow>
  >;
  readonly stampedFunctions: readonly StampedFunctionRow[];
}

async function readCatalog(
  exec: DbTriggerExec,
  sets: readonly DbTriggerSet[],
): Promise<Catalog> {
  const triggerKeys = JSON.stringify(
    sets.flatMap((s) => s.triggers.map(triggerKey)),
  );
  const fnKeys = JSON.stringify(sets.flatMap((s) => s.functions.map(fnKey)));
  const signatures = JSON.stringify(
    sets.flatMap((s) => s.functions.map(fnSignature)),
  );
  const triggers = await executeRows(exec, {
    query: sql`
      SELECT n.nspname::text AS schema, c.relname::text AS "table", t.tgname::text AS name,
             obj_description(t.oid, 'pg_trigger') AS comment,
             t.tgenabled = 'O' AS enabled,
             md5(pg_get_triggerdef(t.oid)) AS def,
             pn.nspname::text || '.' || p.proname::text AS fn
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_namespace pn ON pn.oid = p.pronamespace
       WHERE NOT t.tgisinternal
         AND (starts_with(coalesce(obj_description(t.oid, 'pg_trigger'), ''), ${STAMP_PREFIX})
              OR n.nspname::text || '.' || c.relname::text || '.' || t.tgname::text
                 IN (SELECT jsonb_array_elements_text(${triggerKeys}::jsonb))
              OR pn.nspname::text || '.' || p.proname::text
                 IN (SELECT jsonb_array_elements_text(${fnKeys}::jsonb)))`,
    row: TriggerRow,
    label: "db-triggers: triggers",
  });
  const declared = await executeRows(exec, {
    query: sql`
      SELECT d.signature, p.oid::text AS oid,
             obj_description(p.oid, 'pg_proc') AS comment,
             md5(pg_get_functiondef(p.oid)) AS def
        FROM jsonb_array_elements_text(${signatures}::jsonb) AS d(signature)
        LEFT JOIN pg_proc p ON p.oid = to_regprocedure(d.signature)`,
    row: DeclaredFunctionRow,
    label: "db-triggers: declared functions",
  });
  const stampedFunctions = await executeRows(exec, {
    query: sql`
      SELECT p.oid::text AS oid, n.nspname::text AS schema,
             p.oid::regprocedure::text AS regprocedure,
             obj_description(p.oid, 'pg_proc') AS comment
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE starts_with(coalesce(obj_description(p.oid, 'pg_proc'), ''), ${STAMP_PREFIX})`,
    row: StampedFunctionRow,
    label: "db-triggers: stamped functions",
  });
  return {
    triggers,
    declaredFunctions: new Map(declared.map((r) => [r.signature, r])),
    stampedFunctions,
  };
}

// ── Planning: what differs from the declarations ────────────────────────────

interface DropTrigger {
  readonly owner: string;
  readonly schema: string;
  readonly table: string;
  readonly name: string;
}

interface DropFunction {
  readonly owner: string;
  readonly regprocedure: string;
}

interface Plan {
  readonly functions: readonly { set: DbTriggerSet; f: DbFunctionDdl }[];
  readonly triggers: readonly { set: DbTriggerSet; t: DbTriggerDdl }[];
  /** Installed as written by an older installer: only the stamp is rewritten. */
  readonly restamps: readonly {
    set: DbTriggerSet;
    t: DbTriggerDdl;
    def: string;
  }[];
  readonly dropTriggers: readonly DropTrigger[];
  readonly dropFunctions: readonly DropFunction[];
}

function isEmpty(p: Plan): boolean {
  return (
    p.functions.length +
      p.triggers.length +
      p.restamps.length +
      p.dropTriggers.length +
      p.dropFunctions.length ===
    0
  );
}

/** Every set id a plan touches. */
function touched(p: Plan): string[] {
  return [
    ...new Set([
      ...p.functions.map((x) => x.set.id),
      ...p.triggers.map((x) => x.set.id),
      ...p.restamps.map((x) => x.set.id),
      ...p.dropTriggers.map((x) => x.owner),
      ...p.dropFunctions.map((x) => x.owner),
    ]),
  ].sort();
}

function plan(
  catalog: Catalog,
  sets: readonly DbTriggerSet[],
  sweep: { readonly schema: string } | undefined,
): Plan {
  const functions: { set: DbTriggerSet; f: DbFunctionDdl }[] = [];
  const triggers: { set: DbTriggerSet; t: DbTriggerDdl }[] = [];
  const restamps: { set: DbTriggerSet; t: DbTriggerDdl; def: string }[] = [];
  const dropTriggers: DropTrigger[] = [];
  const dropFunctions: DropFunction[] = [];

  const declaredIds = new Set(sets.map((s) => s.id));
  const declaredTriggers = new Set(
    sets.flatMap((s) => s.triggers.map(triggerKey)),
  );
  const fnOwner = new Map<string, string>();
  for (const s of sets)
    for (const f of s.functions) fnOwner.set(fnKey(f), s.id);
  const declaredOids = new Set<string>();

  for (const set of sets) {
    for (const f of set.functions) {
      const row = catalog.declaredFunctions.get(fnSignature(f));
      if (row?.oid != null) declaredOids.add(row.oid);
      const current =
        row?.oid != null &&
        row.comment === `${ddlStamp(set, f.ddl)}:${row.def}`;
      if (!current) functions.push({ set, f });
    }
    for (const t of set.triggers) {
      const row = catalog.triggers.find(
        (r) =>
          r.schema === schemaOf(t) && r.table === t.table && r.name === t.name,
      );
      if (row === undefined || !row.enabled) {
        triggers.push({ set, t });
      } else if (row.comment === `${ddlStamp(set, t.ddl)}:${row.def}`) {
        continue;
      } else if (
        (t.legacyStamp !== undefined && row.comment === t.legacyStamp) ||
        row.comment === legacyDbTriggersStamp(set)
      ) {
        restamps.push({ set, t, def: row.def });
      } else {
        triggers.push({ set, t });
      }
    }
  }

  for (const r of catalog.triggers) {
    if (declaredTriggers.has(`${r.schema}.${r.table}.${r.name}`)) continue;
    const stamped = stampOwner(r.comment);
    const owner =
      (stamped !== null && declaredIds.has(stamped) ? stamped : null) ??
      fnOwner.get(r.fn) ??
      (stamped !== null && sweep !== undefined && r.schema === sweep.schema
        ? stamped
        : null);
    if (owner === null) continue;
    dropTriggers.push({
      owner,
      schema: r.schema,
      table: r.table,
      name: r.name,
    });
  }

  for (const f of catalog.stampedFunctions) {
    if (declaredOids.has(f.oid)) continue;
    const stamped = stampOwner(f.comment);
    if (stamped === null) continue;
    if (
      declaredIds.has(stamped) ||
      (sweep !== undefined && f.schema === sweep.schema)
    ) {
      dropFunctions.push({ owner: stamped, regprocedure: f.regprocedure });
    }
  }

  return { functions, triggers, restamps, dropTriggers, dropFunctions };
}

// The stamp the installer's first version left on every trigger of a set: the
// set id and one sha256 over all its DDL. A trigger carrying it for this very
// DDL is adopted (restamped), like a declared `legacyStamp`. Compatibility
// only: drop once no supported database predates the per-object stamps.
function legacyDbTriggersStamp(set: DbTriggerSet): string {
  return `${set.id}:${sha256Hex(
    [
      ...set.functions.map((f) => f.ddl),
      ...set.triggers.map((t) => t.ddl),
    ].join("\n--\n"),
  )}`;
}

// ── Applying a plan ─────────────────────────────────────────────────────────

const DefRow = z.object({ def: z.string() });

async function apply(
  tx: DbTriggerExec,
  sets: readonly DbTriggerSet[],
  p: Plan,
): Promise<void> {
  // 1. Each set's own assert, before any of its DDL.
  const installing = new Set([
    ...p.functions.map((x) => x.set.id),
    ...p.triggers.map((x) => x.set.id),
  ]);
  for (const set of sets) {
    if (installing.has(set.id) && set.beforeInstall !== undefined) {
      await set.beforeInstall(tx);
    }
  }

  // 2. Functions: `CREATE OR REPLACE` takes no table lock.
  for (const { set, f } of p.functions) {
    await tx.execute(sql.raw(f.ddl));
    const [row] = await executeRows(tx, {
      query: sql.raw(
        `SELECT md5(pg_get_functiondef(to_regprocedure(${lit(fnSignature(f))}))) AS def`,
      ),
      row: DefRow,
      label: `db-triggers: definition of ${fnKey(f)}`,
    });
    await tx.execute(
      sql.raw(
        `COMMENT ON FUNCTION ${fnSignature(f)} IS ${lit(`${ddlStamp(set, f.ddl)}:${row!.def}`)}`,
      ),
    );
  }

  // 3. Triggers an older installer left as written: the stamp only. COMMENT
  // takes SHARE UPDATE EXCLUSIVE, which conflicts with no writer.
  for (const { set, t, def } of p.restamps) {
    await tx.execute(
      sql.raw(
        `COMMENT ON TRIGGER ${qi(t.name)} ON ${qi(schemaOf(t))}.${qi(t.table)} IS ${lit(`${ddlStamp(set, t.ddl)}:${def}`)}`,
      ),
    );
  }

  // 4. Triggers: one table per savepoint, in the one fixed order.
  const tables = [
    ...new Set([
      ...p.triggers.map((x) => tableKey(x.t)),
      ...p.dropTriggers.map((d) => `${d.schema}.${d.table}`),
    ]),
  ].sort();
  for (const table of tables) {
    const drops = p.dropTriggers.filter(
      (d) => `${d.schema}.${d.table}` === table,
    );
    const creates = p.triggers.filter((x) => tableKey(x.t) === table);
    try {
      await tx.transaction(async (sp) => {
        for (const d of drops) {
          await sp.execute(
            sql.raw(
              `DROP TRIGGER ${qi(d.name)} ON ${qi(d.schema)}.${qi(d.table)}`,
            ),
          );
        }
        for (const { set, t } of creates) {
          await sp.execute(sql.raw(t.ddl));
          const on = `${qi(schemaOf(t))}.${qi(t.table)}`;
          const [row] = await executeRows(sp, {
            query: sql.raw(
              `SELECT md5(pg_get_triggerdef(oid)) AS def FROM pg_trigger
                WHERE tgrelid = ${lit(on)}::regclass AND tgname = ${lit(t.name)}`,
            ),
            row: DefRow,
            label: `db-triggers: definition of ${triggerKey(t)}`,
          });
          await sp.execute(
            sql.raw(
              `COMMENT ON TRIGGER ${qi(t.name)} ON ${on} IS ${lit(`${ddlStamp(set, t.ddl)}:${row!.def}`)}`,
            ),
          );
        }
      });
    } catch (e) {
      throw new Error(
        `db-triggers: installing the triggers on "${table}" failed. Tables are installed one savepoint each, in the fixed order [${tables.join(", ")}]; a writer taking them in another order during a hot swap can deadlock with the boot (SQLSTATE 40P01), which fails it loudly here — retry the deploy once that writer is gone. Cause: ${(e as Error).message}`,
        { cause: e },
      );
    }
    log.publish(
      `[db-triggers] ${table}: ${[
        ...creates.map((x) => `installed ${x.t.name} (${x.set.id})`),
        ...drops.map((d) => `dropped ${d.name} (${d.owner})`),
      ].join(", ")}`,
    );
  }

  // 5. Functions no set declares any more, once nothing calls them.
  for (const d of p.dropFunctions) {
    await tx.execute(sql.raw(`DROP FUNCTION ${d.regprocedure}`));
    log.publish(
      `[db-triggers] dropped function ${d.regprocedure} (${d.owner})`,
    );
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

export interface DbTriggerInstall {
  readonly id: string;
  /** `dropped`: a set nobody declares any more, removed by a sweep. */
  readonly outcome: "installed" | "unchanged" | "dropped";
}

export interface InstallDbTriggersOptions {
  /**
   * `sets` are EVERY set whose objects live in `schema`: a set stamped there
   * that is not among them is dropped whole. Only the boot schema layer, which
   * holds the complete list, passes it.
   */
  readonly sweep?: { readonly schema: string };
}

/**
 * Install (or leave alone, when already current) each declared trigger set —
 * at boot every set the app declares, in a test the sets its suite needs on a
 * throwaway database. Must run after migrations: every table must exist. `db`
 * may be a transaction (boot's schema layer): each table is then a savepoint,
 * and every lock is held until the outer commit. Then asserts every set is
 * installed as written and throws if one is not — a boot never proceeds
 * without an invariant its plugin declared.
 */
export async function installDbTriggers(
  db: DbTriggerExec,
  sets: readonly DbTriggerSet[],
  options: InstallDbTriggersOptions = {},
): Promise<readonly DbTriggerInstall[]> {
  assertDistinct(sets);
  const first = plan(await readCatalog(db, sets), sets, options.sweep);
  let done: string[] = [];
  if (!isEmpty(first)) {
    done = await db.transaction(async (tx) => {
      // Re-planned under the locks: a racing installer may have done it — or
      // made another set stale, whose lock is then taken before anything runs.
      const locked = new Set<string>();
      let p = first;
      for (;;) {
        const unlocked = touched(p).filter((id) => !locked.has(id));
        if (unlocked.length === 0) break;
        for (const id of unlocked) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext('db_triggers'), hashtext(${id}))`,
          );
          locked.add(id);
        }
        p = plan(await readCatalog(tx, sets), sets, options.sweep);
      }
      await apply(tx, sets, p);
      return touched(p);
    });
  }
  const after = plan(await readCatalog(db, sets), sets, options.sweep);
  if (!isEmpty(after)) {
    throw new Error(
      `db-triggers: trigger set missing or out of date after install: ${touched(after).join(", ")}.`,
    );
  }
  const declared = new Set(sets.map((s) => s.id));
  return [
    ...sets.map((s) => ({
      id: s.id,
      outcome: done.includes(s.id)
        ? ("installed" as const)
        : ("unchanged" as const),
    })),
    ...done
      .filter((id) => !declared.has(id))
      .map((id) => ({ id, outcome: "dropped" as const })),
  ];
}

function assertDistinct(sets: readonly DbTriggerSet[]): void {
  const seen = new Map<string, string>();
  const claim = (key: string, id: string) => {
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Error(
        `db-triggers: ${key} is declared by two trigger sets ("${prior}" and "${id}").`,
      );
    }
    seen.set(key, id);
  };
  for (const s of sets) {
    claim(`set ${s.id}`, s.id);
    for (const f of s.functions) claim(`function ${fnKey(f)}`, s.id);
    for (const t of s.triggers) claim(`trigger ${triggerKey(t)}`, s.id);
  }
}
