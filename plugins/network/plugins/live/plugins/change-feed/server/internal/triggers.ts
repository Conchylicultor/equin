import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import {
  defineDbTriggers,
  installDbTriggers,
  type DbTriggerDdl,
  type DbTriggerSet,
} from "@plugins/database/plugins/db-triggers/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  MIGRATIONS_TABLE_NAME,
  LIVE_STATE_CHANGELOG_TABLE,
  LIVE_STATE_HANDOFF_TABLE,
  LIVE_STATE_SNAPSHOT_TABLE,
  LIVE_STATE_TRIGGER_STATE_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import type { TableLayoutRequirement } from "@plugins/framework/plugins/server-core/core";
import { changeFeedLog as log } from "./log-sink";
import { ensureTxnEndTrigger, TXN_END_FUNCTION_DDL } from "./txn-end";

// Infrastructure tables the change-feed must NEVER trigger on — its own plumbing,
// independent of any feature plugin's opt-out. Keep this minimal.
//
// We exclude the migrations bookkeeping table — written by the migration runner
// inside `onReadyBlocking`, never read by a live-state loader, so triggering on it
// adds pure noise. graphile_worker lives in its own schema, so it is already
// excluded by the public-schema filter.
//
// `live_state_changelog` and `live_state_snapshot` (the L2 persisted-
// materialization tables) are denylisted because `live_state_notify()` writes the
// changelog from inside every trigger — a trigger ON the changelog would recurse
// infinitely (each INSERT firing the trigger that does another INSERT). The
// snapshot table is written by the runtime persist hook (out of band of any
// trigger) and read only at boot, so it never needs a feed either.
//
// The table-name constants live in the derived-views core leaf (the imperative-
// public-table allowlist) so the orphaned-db-tables check and the create sites
// share one source — see that module.
// `feedExempt` adds the trigger-maintained materialized rollup tables
// (derived-tables' `feedExemptTables()`): a rollup is a pure read-cache fed by its
// source's change, never an independent write surface — a NOTIFY trigger on it
// would double-route the source change through the rollup's id space and defeat
// the correctly-scoped source-driven recompute. `optedOut` adds the tables a
// feature plugin opted out via the `ExcludeFromChangeFeed` contribution
// (`excludedTableNames()`, e.g. high-churn observability counters) — keeping THIS
// plugin from naming any consumer table (collection-consumer separation).
// `produced` adds the tables an in-process change producer declares
// (`producedTableNames()`, ./producer): a produced table's change source is the
// backend that writes it, so a trigger on it would make its writes reach their
// readers twice — once from the producer, once from the feed. All three are
// contribution sets, so the CALLER reads them (see `TriggerExclusions`).
// `live_state_trigger_state` (the former installer's signatures, read once to
// adopt its triggers and then dropped — see "Adopting" below; an older build
// booting on a fork recreates it) is plumbing no live-state loader ever reads.
// `live_state_handoff` (the epoch handoff live-state-snapshot writes at
// shutdown) is plumbing too.
function buildDenylist(exclusions: TriggerExclusions): Set<string> {
  return new Set<string>([
    MIGRATIONS_TABLE_NAME,
    LIVE_STATE_CHANGELOG_TABLE,
    LIVE_STATE_SNAPSHOT_TABLE,
    LIVE_STATE_TRIGGER_STATE_TABLE,
    LIVE_STATE_HANDOFF_TABLE,
    ...exclusions.feedExempt,
    ...exclusions.optedOut,
    ...exclusions.produced,
  ]);
}

/**
 * The contributed tables the feed installs no trigger on, beyond its own
 * plumbing. Passed in rather than read here: both are contribution sets, which
 * only a process that booted the plugin graph can read (`getContributions`
 * throws anywhere else) — so the boot hook reads them, and a suite driving a
 * throwaway database states its own.
 */
export interface TriggerExclusions {
  /** Trigger-maintained rollups (derived-tables' `feedExemptTables()`). */
  feedExempt: ReadonlySet<string>;
  /** Feature opt-outs (`ExcludeFromChangeFeed`: `excludedTableNames()`). */
  optedOut: ReadonlySet<string>;
  /** Tables with an in-process change producer (`producedTableNames()`). */
  produced: ReadonlySet<string>;
}

// L2 durable outbox DDL. Created in rebuildTriggers' prelude transaction, before
// the trigger functions are installed, so the table the functions INSERT into is
// guaranteed to exist before any data-change trigger can fire. Derived-state
// table (CREATE TABLE IF NOT EXISTS on boot, like derived_view_state)
// — NOT a drizzle migration. See
// research/2026-06-22-global-live-state-l2-persisted-materialization.md §3.1.
//
//  - `seq` is a stable ordering / prune key only (NOT the watermark).
//  - `xid` is `pg_current_xact_id()` — the 64-bit xid8, stored as numeric so it
//    never overflows signed bigint near 2^63. NEVER the 32-bit txid_* forms.
//  - `ids` is the changed PKs, or NULL (bulk / pk-less / over-cap → FULL on catch-up).
//  - `keys` / `unchanged` are a ROUTED table's key layout and known-unchanged
//    column set (see ROUTED_NOTIFY_FUNCTION_DDL) — NULL for every other table
//    (and `keys` for an over-cap statement). A changelog created before them
//    gains them once (see `ensureChangelogTable`).
const CHANGELOG_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${LIVE_STATE_CHANGELOG_TABLE} (
  seq        bigserial PRIMARY KEY,
  xid        numeric   NOT NULL,
  t          text      NOT NULL,
  op         char(1)   NOT NULL,
  ids        text[],
  at         timestamptz NOT NULL DEFAULT now(),
  keys       jsonb,
  unchanged  text[]
)`;
const CHANGELOG_INDEX = "live_state_changelog_xid_idx";
const CHANGELOG_INDEX_DDL = `CREATE INDEX IF NOT EXISTS ${CHANGELOG_INDEX} ON ${LIVE_STATE_CHANGELOG_TABLE} (xid)`;
// The columns added after the table first shipped, with their types: each is
// ALTERed in only when the catalog says it is missing.
const CHANGELOG_LATER_COLUMNS: readonly (readonly [string, string])[] = [
  ["keys", "jsonb"],
  ["unchanged", "text[]"],
];

const CatalogNameRowSchema = z.object({ name: z.string() });

// A public relation's name if it exists (`to_regclass` is NULL otherwise) —
// a catalog read, no lock on the relation.
async function relationExists(
  db: NodePgDatabase,
  name: string,
): Promise<boolean> {
  const rows = await executeRows(db, {
    query: drizzleSql.raw(
      `SELECT relname AS name FROM pg_class
       WHERE oid = to_regclass(${quoteLiteral(`public.${name}`)})`,
    ),
    row: CatalogNameRowSchema,
    label: "relationExists",
  });
  return rows.length > 0;
}

// Create the L2 durable outbox table, its xid index and its later columns —
// each ONLY when the catalog says it is missing. Every one of those statements
// locks the changelog even when it has nothing to do (`ALTER TABLE … ADD
// COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE, `CREATE INDEX IF NOT EXISTS`
// SHARE), and every trigger on every table INSERTs into the changelog: one
// open writing transaction would block the statement, and every other writer
// would queue behind its lock request. Read first, so a changelog already in
// shape takes no lock at all; the DDL runs once, when the shape moves.
//
// Extracted so production (rebuildTriggers, passing its own `tx`) and the
// DB-backed test harness share ONE DDL source — mirroring
// `ensureSnapshotTable(db)` in live-state-snapshot. A drizzle transaction `tx`
// is assignable to `NodePgDatabase` for `.execute`, so callers can pass either
// the pool-backed db or a live transaction.
export async function ensureChangelogTable(db: NodePgDatabase): Promise<void> {
  if (!(await relationExists(db, LIVE_STATE_CHANGELOG_TABLE))) {
    await db.execute(drizzleSql.raw(CHANGELOG_TABLE_DDL));
  } else {
    const present = new Set(await tableColumns(db, LIVE_STATE_CHANGELOG_TABLE));
    for (const [column, type] of CHANGELOG_LATER_COLUMNS) {
      if (present.has(column)) continue;
      await db.execute(
        drizzleSql.raw(
          `ALTER TABLE ${LIVE_STATE_CHANGELOG_TABLE} ADD COLUMN IF NOT EXISTS ${column} ${type}`,
        ),
      );
    }
  }
  if (!(await relationExists(db, CHANGELOG_INDEX))) {
    await db.execute(drizzleSql.raw(CHANGELOG_INDEX_DDL));
  }
}

// The generic STATEMENT-level trigger function. It is deterministic, data-less
// DDL (never a migration), installed with the feed's trigger set whenever its
// stamp says it is stale.
//
// One function serves every table and every op:
//  - INSERT / UPDATE read the `new_rows` transition table; DELETE reads
//    `old_rows`. The trigger declares the appropriate transition table.
//  - The PK column is passed per-table as TG_ARGV[0]. With a single-column PK we
//    aggregate the changed PK values into a text[]; with a composite/absent PK
//    TG_ARGV[0] is empty → ids stays NULL → the consumer treats it as
//    FULL-for-table (still correct, just unscoped).
//  - Payload is json {t, op, ids, x, at}. NOTIFY has a ~8 KB ceiling; if the payload
//    exceeds 7000 bytes (large bulk statement) we re-emit with ids = NULL so the
//    consumer degrades to FULL-for-table rather than dropping the NOTIFY.
//  - STATEMENT-level + transition tables means exactly one NOTIFY per statement,
//    not one per row — the whole reason this is cheap on bulk writes.
const NOTIFY_FUNCTION_DDL = `
CREATE OR REPLACE FUNCTION live_state_notify() RETURNS trigger AS $live_state$
DECLARE
  pk_col text := TG_ARGV[0];
  ids text[];
  payload text;
  has_rows boolean;
  -- Wall clock of THIS statement, epoch ms — clock_timestamp(), not now(): now()
  -- is the transaction's START, which for a long transaction predates the change
  -- by the transaction's whole length. Rides the NOTIFY as 'at' so an open tab
  -- can measure change → applied on a clock the serving thread does not own.
  -- NOTIFY only — the changelog row has no use for it (catch-up replays changes
  -- no tab was waiting on).
  changed_at bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
BEGIN
  -- A statement that touched zero rows changed no data — e.g. an
  -- INSERT … ON CONFLICT DO NOTHING that fully conflicted, or an UPDATE/DELETE
  -- matching no rows. The STATEMENT-level trigger still fires once; suppress it
  -- here so a no-op statement never drives a (FULL-for-table) live-state
  -- recompute. This cannot drop a real invalidation: no affected row ⇒ no data
  -- change ⇒ nothing for the consumer to recompute or for catch-up to replay.
  -- (EXECUTE — not a static reference — because new_rows/old_rows only exist for
  -- the matching TG_OP, mirroring the dynamic array_agg below.)
  IF TG_OP = 'DELETE' THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM old_rows)' INTO has_rows;
  ELSE
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM new_rows)' INTO has_rows;
  END IF;
  IF NOT has_rows THEN
    RETURN NULL;
  END IF;

  IF pk_col IS NOT NULL AND pk_col <> '' THEN
    IF TG_OP = 'DELETE' THEN
      EXECUTE format('SELECT array_agg(%I::text) FROM old_rows', pk_col) INTO ids;
    ELSE
      EXECUTE format('SELECT array_agg(%I::text) FROM new_rows', pk_col) INTO ids;
    END IF;
  ELSE
    ids := NULL;
  END IF;

  -- 'x' is the source transaction id (pg_current_xact_id(), the same xid8 the
  -- changelog row below stores) — the mutation-ack attribution the live-state
  -- runtime threads onto its recompute frames (ackTx). Kept on the over-cap
  -- re-emit too: dropping the ids degrades scope, not attribution.
  payload := json_build_object('t', TG_TABLE_NAME, 'op', left(TG_OP, 1), 'ids', ids, 'x', pg_current_xact_id()::text, 'at', changed_at)::text;

  -- NOTIFY payloads are capped at ~8 KB. Over the cap, drop the id list and let
  -- the consumer recompute the whole table (FULL-for-table) instead of losing
  -- the change entirely. The same over-cap rule applies to the durable changelog
  -- row below (NULL ids → FULL on catch-up), so re-derive ids once here.
  IF octet_length(payload) > 7000 THEN
    ids := NULL;
    payload := json_build_object('t', TG_TABLE_NAME, 'op', left(TG_OP, 1), 'ids', NULL, 'x', pg_current_xact_id()::text, 'at', changed_at)::text;
  END IF;

  PERFORM pg_notify('live_state', payload);

  -- L2 durable outbox: write a transactional changelog row alongside the
  -- ephemeral NOTIFY. Because this INSERT runs inside the same trigger/txn as the
  -- data change, the changelog row commits ATOMICALLY with the write (a
  -- rolled-back write leaves no changelog row). The xid is the 64-bit xid8 via
  -- pg_current_xact_id() — the same family as the watermark the runtime captures
  -- (pg_snapshot_xmin) — so the catch-up replay predicate (xid >= position) is
  -- never under-replayed. See
  -- research/2026-06-22-global-live-state-l2-persisted-materialization.md §3.1.
  INSERT INTO live_state_changelog (xid, t, op, ids)
  VALUES (pg_current_xact_id()::text::numeric, TG_TABLE_NAME, left(TG_OP, 1), ids);

  RETURN NULL;
END;
$live_state$ LANGUAGE plpgsql;
`;

// The trigger function of a ROUTED table — one a compiled route reads
// (`routedTableRequirements()`, research/2026-09-29-global-scoped-change-routing.md
// P3). Its layout rides the trigger arguments, derived from the routes and never
// declared beside them:
//
//  - TG_ARGV[0] — the single-column PK, or '' (composite / none), as before;
//  - TG_ARGV[1] — the CARRY columns, a JSON array: every route's host-key
//    column and `rows` / `match` keys. `keys` carries their values as text,
//    DISTINCT over the rows the statement touched, as
//    `{ "c": [columns], "r": [[row values]] }` — one array per row, so the
//    columns stay aligned by construction;
//  - TG_ARGV[2] — the GATE columns, a JSON array (empty = no gate): the columns
//    an UPDATE compares old against new — the union of the `columns` of every
//    route that reads FEWER columns than the table has (only such a route can
//    be skipped; comparing a column only whole-table readers read is wasted
//    work on every UPDATE), on a table with a single-column PK.
//
// It differs from `live_state_notify()` in exactly what routing needs:
//
//  - an UPDATE reads BOTH transition tables (its trigger declares `OLD TABLE AS
//    old_rows` too): `ids` and `keys` are DISTINCT over old ∪ new, so a moved
//    key names both of its hosts — a key-changing UPDATE no longer loses the
//    old id;
//  - a DELETE's `keys` come from `old_rows` (the rows are gone);
//  - `unchanged` (an UPDATE on a gated table) is the gate columns whose value
//    is equal in EVERY row, found by joining old and new on the PK and
//    comparing as text (a json column has no equality). A fact about the rows,
//    whatever the gate was: a column not compared is not listed, so the router
//    reads it as possibly changed — a gate can be narrower than the routes
//    without losing an update, and a catch-up can replay it across a deploy
//    that changed the routes. A PK that changed makes the pairing unknown, so
//    `unchanged` is NULL (nothing known);
//  - over the NOTIFY cap, `ids` and `keys` are dropped (FULL, as before) while
//    `unchanged` — column names, bounded by the gate whatever the row count —
//    still lets a bulk UPDATE of columns no route reads reach nothing.
//
// A table no route reads keeps `live_state_notify()` and its PK-only DDL byte
// for byte (`compileTableTriggerDdl` with no layout).
const ROUTED_NOTIFY_FUNCTION_DDL = `
CREATE OR REPLACE FUNCTION live_state_notify_routed() RETURNS trigger AS $live_state$
DECLARE
  pk_col text := TG_ARGV[0];
  carry text[] := ARRAY(SELECT json_array_elements_text(TG_ARGV[1]::json));
  gate text[] := ARRAY(SELECT json_array_elements_text(TG_ARGV[2]::json));
  src text;
  ids text[];
  key_rows json;
  keys json;
  unchanged text[];
  matched bigint;
  total bigint;
  payload text;
  has_rows boolean;
  changed_at bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM old_rows)' INTO has_rows;
  ELSE
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM new_rows)' INTO has_rows;
  END IF;
  IF NOT has_rows THEN
    RETURN NULL;
  END IF;

  -- The rows the statement touched: an UPDATE's old AND new sides.
  src := CASE TG_OP
    WHEN 'DELETE' THEN 'old_rows'
    WHEN 'INSERT' THEN 'new_rows'
    ELSE '(SELECT * FROM old_rows UNION ALL SELECT * FROM new_rows)'
  END;

  IF pk_col <> '' THEN
    EXECUTE format('SELECT array_agg(DISTINCT s.%I::text) FROM %s AS s', pk_col, src) INTO ids;
  END IF;

  IF cardinality(carry) > 0 THEN
    EXECUTE format(
      'SELECT json_agg(json_build_array(%s)) FROM (SELECT DISTINCT %s FROM %s AS s) AS d',
      (SELECT string_agg(format('d.%I', c), ', ') FROM unnest(carry) AS c),
      (SELECT string_agg(format('s.%I::text AS %I', c, c), ', ') FROM unnest(carry) AS c),
      src
    ) INTO key_rows;
    keys := json_build_object('c', to_json(carry), 'r', key_rows);
  END IF;

  IF TG_OP = 'UPDATE' AND pk_col <> '' AND cardinality(gate) > 0 THEN
    EXECUTE 'SELECT count(*) FROM old_rows' INTO total;
    EXECUTE format(
      'SELECT count(*), ARRAY[%s] FROM old_rows AS o JOIN new_rows AS n ON o.%I = n.%I',
      (SELECT string_agg(
         format('CASE WHEN bool_or(o.%I::text IS DISTINCT FROM n.%I::text) THEN NULL ELSE %L END', c, c, c),
         ', ') FROM unnest(gate) AS c),
      pk_col, pk_col
    ) INTO matched, unchanged;
    IF matched = total THEN
      unchanged := array_remove(unchanged, NULL);
    ELSE
      unchanged := NULL;
    END IF;
  END IF;

  payload := json_build_object('t', TG_TABLE_NAME, 'op', left(TG_OP, 1), 'ids', ids, 'k', keys, 'u', unchanged, 'x', pg_current_xact_id()::text, 'at', changed_at)::text;
  IF octet_length(payload) > 7000 THEN
    ids := NULL;
    keys := NULL;
    payload := json_build_object('t', TG_TABLE_NAME, 'op', left(TG_OP, 1), 'ids', NULL, 'k', NULL, 'u', unchanged, 'x', pg_current_xact_id()::text, 'at', changed_at)::text;
    IF octet_length(payload) > 7000 THEN
      unchanged := NULL;
      payload := json_build_object('t', TG_TABLE_NAME, 'op', left(TG_OP, 1), 'ids', NULL, 'k', NULL, 'u', NULL, 'x', pg_current_xact_id()::text, 'at', changed_at)::text;
    END IF;
  END IF;

  PERFORM pg_notify('live_state', payload);

  INSERT INTO live_state_changelog (xid, t, op, ids, keys, unchanged)
  VALUES (pg_current_xact_id()::text::numeric, TG_TABLE_NAME, left(TG_OP, 1), ids, keys::jsonb, unchanged);

  RETURN NULL;
END;
$live_state$ LANGUAGE plpgsql;
`;

/**
 * A routed table's installed layout — what `live_state_notify_routed` emits
 * for it: the carried key columns and the `unchanged` gate. Resolved from the
 * routes' requirement against the table's catalog (`resolveLayout`).
 */
export interface TriggerLayout {
  carry: readonly string[];
  /** The columns an UPDATE compares. Empty = no gate: `unchanged` is NULL. */
  gate: readonly string[];
}

type TableTrigger = { table: string; pkCol: string; layout?: TriggerLayout };

// Quote a SQL identifier (double-quote, escape embedded double-quotes).
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Single-quote a SQL string literal (for passing the PK column as TG_ARGV[0]).
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Deterministic trigger names, one per op so each can declare its own
// transition table.
function triggerName(table: string, op: "i" | "u" | "d"): string {
  return `live_state_${table}_${op}`;
}

// Every catalog column this file reads (`relname`, `attname`, `tgname`) is a
// SCALAR `name` (OID 19), which pg does decode to a string — so these schemas say
// `z.string()` and the SQL needs no cast. It is `name[]` (OID 1003, what an
// uncast `array_agg` over one of these produces) that has no decoder and arrives
// as a raw Postgres literal string; see the sql-rows plugin's CLAUDE.md.
const TableNameRowSchema = z.object({ relname: z.string() });

// Every public-schema user table minus the exclusion set (infra denylist ∪
// derived-table rollups ∪ feature-contributed `ExcludeFromChangeFeed` tables).
async function listPublicTables(
  db: NodePgDatabase,
  exclude: Set<string>,
): Promise<string[]> {
  const rows = await executeRows(db, {
    query: drizzleSql.raw(
      `SELECT relname FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname`,
    ),
    row: TableNameRowSchema,
    label: "listPublicTables",
  });
  return rows.map((r) => r.relname).filter((t) => !exclude.has(t));
}

const KeyColumnRowSchema = z.object({
  relname: z.string(),
  attname: z.string(),
});

// Every public table's single-column primary key, in ONE catalog read (a
// query per table cost a round trip each — ~190 at boot). A table absent
// from the map has a composite or no PK (→ "" → FULL-for-table).
async function singleColumnPks(
  db: NodePgDatabase,
): Promise<Map<string, string>> {
  const rows = await executeRows(db, {
    query: drizzleSql.raw(
      `SELECT c.relname, a.attname
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE n.nspname = 'public' AND i.indisprimary`,
    ),
    row: KeyColumnRowSchema,
    label: "singleColumnPks",
  });
  const keys = new Map<string, string[]>();
  for (const r of rows) {
    keys.set(r.relname, [...(keys.get(r.relname) ?? []), r.attname]);
  }
  const pks = new Map<string, string>();
  for (const [table, [only, ...rest]] of keys) {
    if (only !== undefined && rest.length === 0) pks.set(table, only);
  }
  return pks;
}

// One table's feed: the three per-op triggers, as the one trigger installer
// takes them (`CREATE OR REPLACE`, so a changed layout is replaced in place —
// SHARE ROW EXCLUSIVE, never the ACCESS EXCLUSIVE of a DROP, so the previous
// backend's readers never wait on it).
//
// A table with a `layout` (one a route reads) calls `live_state_notify_routed`
// with its layout as arguments, and its UPDATE trigger declares both transition
// tables; without one the statements are exactly the PK-only feed's, byte for
// byte — an unrouted table's trigger never changes (and is never re-run)
// because routing exists.
export function compileTableTriggerDdl(
  table: string,
  pkCol: string,
  layout?: TriggerLayout,
): DbTriggerDdl[] {
  const tbl = quoteIdent(table);
  const trigger = (
    op: "i" | "u" | "d",
    event: string,
    referencing: string,
    call: string,
  ): DbTriggerDdl => {
    const name = triggerName(table, op);
    return {
      name,
      table,
      ddl: `CREATE OR REPLACE TRIGGER ${quoteIdent(name)} AFTER ${event} ON ${tbl}
           REFERENCING ${referencing}
           FOR EACH STATEMENT EXECUTE FUNCTION ${call}`,
    };
  };
  if (layout !== undefined) {
    const args = [
      quoteLiteral(pkCol),
      quoteLiteral(JSON.stringify(layout.carry)),
      quoteLiteral(JSON.stringify(layout.gate)),
    ].join(", ");
    const call = `live_state_notify_routed(${args})`;
    return [
      trigger("i", "INSERT", "NEW TABLE AS new_rows", call),
      trigger(
        "u",
        "UPDATE",
        "OLD TABLE AS old_rows NEW TABLE AS new_rows",
        call,
      ),
      trigger("d", "DELETE", "OLD TABLE AS old_rows", call),
    ];
  }
  const call = `live_state_notify(${quoteLiteral(pkCol)})`; // '' ⇒ FULL-for-table
  return [
    trigger("i", "INSERT", "NEW TABLE AS new_rows", call),
    trigger("u", "UPDATE", "NEW TABLE AS new_rows", call),
    trigger("d", "DELETE", "OLD TABLE AS old_rows", call),
  ];
}

const ColumnNameRowSchema = z.object({ attname: z.string() });
const TableColumnRowSchema = z.object({
  relname: z.string(),
  attname: z.string(),
});

// Every live (non-dropped, user) column of each of `tables`, by name, in ONE
// catalog read.
async function tablesColumns(
  db: NodePgDatabase,
  tables: readonly string[],
): Promise<Map<string, string[]>> {
  const rows = await executeRows(db, {
    query: drizzleSql`
      SELECT c.relname, a.attname
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (SELECT jsonb_array_elements_text(${JSON.stringify(tables)}::jsonb))
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    row: TableColumnRowSchema,
    label: "tablesColumns",
  });
  const columns = new Map<string, string[]>();
  for (const r of rows) {
    const list = columns.get(r.relname) ?? [];
    list.push(r.attname);
    columns.set(r.relname, list);
  }
  return columns;
}

// A routed table's columns from `tablesColumns`: a listed table with none
// read is one dropped since it was listed — a boot that cannot lay out its
// trigger, loudly.
function routedColumnsOf(
  columns: ReadonlyMap<string, readonly string[]>,
  table: string,
): readonly string[] {
  const found = columns.get(table);
  if (found === undefined) {
    throw new Error(
      `[change-feed] routed table "${table}" has no columns in the catalog — it was dropped while the feed was being installed.`,
    );
  }
  return found;
}

// Every live (non-dropped, user) column of a table, by name.
async function tableColumns(
  db: NodePgDatabase,
  table: string,
): Promise<string[]> {
  const rows = await executeRows(db, {
    query: drizzleSql.raw(
      `SELECT attname FROM pg_attribute
       WHERE attrelid = format('public.%I', ${quoteLiteral(table)})::regclass
         AND attnum > 0 AND NOT attisdropped
       ORDER BY attnum`,
    ),
    row: ColumnNameRowSchema,
    label: "tableColumns",
  });
  return rows.map((r) => r.attname);
}

/**
 * A routed table's installed layout: its routes' requirement checked against
 * the catalog — a carried or read column the table does not have is a route
 * naming nothing, so it throws (loud boot failure, never a silently unscoped
 * route). The gate is the union of the column sets that miss some column of
 * the table: only a route reading fewer columns than the table has can be
 * skipped by `unchanged` (a lookup reading `id, type, enabled` of a table
 * another collection lists whole), so a column only whole-table readers read
 * is never compared — it would be detoasted and compared on every UPDATE to
 * skip nothing. No gate without a single-column PK (old and new rows pair up
 * by it). Whatever the gate, `unchanged` is sound: a column it leaves out is
 * read as possibly changed.
 */
export function resolveLayout(
  requirement: TableLayoutRequirement,
  columns: readonly string[],
  pkCol: string,
): TriggerLayout {
  const known = new Set(columns);
  for (const [what, list] of [
    ["carries", requirement.carry],
    ["reads", requirement.reads.flat()],
  ] as const) {
    const missing = [...new Set(list)].filter((c) => !known.has(c));
    if (missing.length > 0) {
      throw new Error(
        `[change-feed] a route ${what} column(s) ${missing.map((c) => `"${c}"`).join(", ")} of "${requirement.table}", which the table does not have — a compiled route must name the table's own columns.`,
      );
    }
  }
  const gate = new Set<string>();
  if (pkCol !== "") {
    for (const read of requirement.reads) {
      if (read.length < known.size) for (const c of read) gate.add(c);
    }
  }
  return { carry: requirement.carry, gate: [...gate].sort() };
}

/** The feed's trigger set id: its stamps, its install lock, its sweep claim. */
export const CHANGE_FEED_TRIGGER_SET = "change-feed";

// The feed as one `db-triggers` set: both notify functions, and every
// triggered table's three triggers. Ownership is by function, so a
// `live_state_*` trigger left on a table now excluded (opted out, a rollup, a
// produced table) calls one of them and is dropped by the install.
function feedTriggerSet(
  triggers: readonly TableTrigger[],
  adopted: ReadonlySet<string>,
): DbTriggerSet {
  return defineDbTriggers({
    id: CHANGE_FEED_TRIGGER_SET,
    functions: [
      { name: "live_state_notify", args: "", ddl: NOTIFY_FUNCTION_DDL },
      {
        name: "live_state_notify_routed",
        args: "",
        ddl: ROUTED_NOTIFY_FUNCTION_DDL,
      },
    ],
    triggers: triggers.flatMap(({ table, pkCol, layout }) =>
      compileTableTriggerDdl(table, pkCol, layout).map((t) =>
        adopted.has(table) ? { ...t, legacyStamp: null } : t,
      ),
    ),
  });
}

// ── Adopting the feed's own former installer ─────────────────────────────────
//
// Until the feed moved onto `db-triggers`, it DROP+CREATEd each table's
// triggers and kept a per-table signature (sha256 of those statements) in
// `live_state_trigger_state`. A table whose stored signature is exactly the
// one that installer would have stamped for today's layout carries today's
// triggers: they are adopted (COMMENT only) rather than re-created, so the
// first boot of the one installer locks no table. The state table is then
// dropped, so an older build booting on this database (a fork) finds no
// signature and rebuilds rather than trusting rows nothing keeps current.
// Compatibility only: delete this section, and the table's place in the
// derived-views allowlist, once no supported database predates the switch.

/** What the former installer ran for one table — its signature's input. */
function legacyTableStatements(t: TableTrigger): string[] {
  const tbl = quoteIdent(t.table);
  const names = (["i", "u", "d"] as const).map((op) =>
    quoteIdent(triggerName(t.table, op)),
  );
  const drops = names.map((n) => `DROP TRIGGER IF EXISTS ${n} ON ${tbl}`);
  const call =
    t.layout === undefined
      ? `live_state_notify(${quoteLiteral(t.pkCol)})`
      : `live_state_notify_routed(${[
          quoteLiteral(t.pkCol),
          quoteLiteral(JSON.stringify(t.layout.carry)),
          quoteLiteral(JSON.stringify(t.layout.gate)),
        ].join(", ")})`;
  const update =
    t.layout === undefined
      ? "REFERENCING NEW TABLE AS new_rows"
      : "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows";
  return [
    ...drops,
    `CREATE TRIGGER ${names[0]} AFTER INSERT ON ${tbl}
           REFERENCING NEW TABLE AS new_rows
           FOR EACH STATEMENT EXECUTE FUNCTION ${call}`,
    `CREATE TRIGGER ${names[1]} AFTER UPDATE ON ${tbl}
           ${update}
           FOR EACH STATEMENT EXECUTE FUNCTION ${call}`,
    `CREATE TRIGGER ${names[2]} AFTER DELETE ON ${tbl}
           REFERENCING OLD TABLE AS old_rows
           FOR EACH STATEMENT EXECUTE FUNCTION ${call}`,
  ];
}

const SignatureRowSchema = z.object({
  relname: z.string(),
  signature: z.string(),
});

/** The tables whose former signature says their triggers are today's. */
async function adoptableTables(
  db: NodePgDatabase,
  triggers: readonly TableTrigger[],
): Promise<Set<string>> {
  if (!(await relationExists(db, LIVE_STATE_TRIGGER_STATE_TABLE))) {
    return new Set();
  }
  // The first, one-row shape named no table: nothing to adopt from it.
  if (
    !(await tableColumns(db, LIVE_STATE_TRIGGER_STATE_TABLE)).includes(
      "relname",
    )
  ) {
    return new Set();
  }
  const stored = new Map(
    (
      await executeRows(db, {
        query: drizzleSql.raw(
          `SELECT relname, signature FROM "public"."${LIVE_STATE_TRIGGER_STATE_TABLE}"`,
        ),
        row: SignatureRowSchema,
        label: "change-feed: former signatures",
      })
    ).map((r) => [r.relname, r.signature]),
  );
  return new Set(
    triggers
      .filter(
        (t) =>
          stored.get(t.table) ===
          sha256Hex(legacyTableStatements(t).join("\n")),
      )
      .map((t) => t.table),
  );
}

// Cached at boot during rebuildTriggers — the set of public tables we installed
// triggers on. The listener's on-reconnect FULL sweep iterates this set (see
// listener.ts). It is the by-construction-complete table universe; a table no
// route names and no read-set base is reaches nothing, so sweeping all of them
// is safe and total.
//
// Set from the DESIRED set on every boot — `assertRouteTablesCovered` reads it
// via `getCoveredTables()` right after, and the install has just asserted
// every desired trigger is installed as written.
let coveredTables: string[] = [];

export function getCoveredTables(): readonly string[] {
  return coveredTables;
}

// Installs the change-feed trigger layer from source — only the parts that
// differ from the live database.
//
// Deterministic, data-less DDL (NOT a migration): enumerate the live schema,
// then hand the feed's trigger set to the one trigger installer
// (`database/db-triggers`), which re-runs only the stale objects (per-object
// stamps — DDL hash + catalog definition — so a trigger dropped, disabled or
// replaced out of band is re-run, and a steady-state boot takes ZERO table
// locks), drops a `live_state_*` trigger left on a now-excluded table, and
// asserts the set is installed as written. Any failure throws and blocks boot
// loudly rather than running with a half-installed feed.
//
// ONE TRANSACTION PER TABLE (`commit: "per-table"`), never the schema layer's
// one transaction: the feed spans every public table, and the previous backend
// is still serving them during a hot swap. A transaction that only ever locks
// one relation cannot be a node in a wait cycle — it acquires that one lock or
// blocks on exactly one holder — so the deadlock that killed
// build-1784288281433-w62dep (one transaction over an alphabetical prefix of
// the schema, `attempts` ⇄ `conversations`, 40P01) is impossible, not retried.
// The notify functions are committed first, so every trigger, old or new, calls
// the current function; each table's three triggers are replaced together.
//
// REMOVAL IS DEFERRED at boot (`keepUnfed`): a trigger left on a table this
// code no longer feeds (newly `ExcludeFromChangeFeed`, now feed-exempt) stays
// until every process that booted before this one is gone — the previous
// backend's code may still route that table, and it is still serving: briefly
// during a hot swap, for good when the deploy is abandoned after this backend
// booted (2026-11-08: a failed main build dropped `conversations_ext_sdk_agent`'s
// triggers under the old backend, whose stop banner then never moved). The
// change feed's `onReady` then installs again without it (`removeUnfedTriggers`).
// A kept trigger costs only its changelog rows; nothing routes them. A
// produced table's trigger is the exception — dropped at once, since its
// producer routes the same writes (A2′).
//
// `db` is passed in (like rebuildDerivedViews / runMigrations) so this module
// never imports @plugins/database/server — that would cycle (database/server
// calls into the change-feed plugin's onReadyBlocking).
export async function rebuildTriggers(
  db: NodePgDatabase,
  exclusions: TriggerExclusions,
  /**
   * The routed tables' layouts (server-core's `routedTableRequirements()`): each
   * gets the richer trigger, every other table the PK-only one. A requirement
   * naming an excluded or missing table installs nothing — the route-coverage
   * assertion that follows reports it.
   */
  requirements: readonly TableLayoutRequirement[],
  { keepUnfed = false }: { keepUnfed?: boolean } = {},
): Promise<{ kept: number }> {
  const exclude = buildDenylist(exclusions);
  const optedOut = exclusions.optedOut;
  if (optedOut.size > 0) {
    log.publish(
      `[change-feed] ${optedOut.size} table(s) opted out of the feed via ExcludeFromChangeFeed: ${[...optedOut].sort().join(", ")}`,
    );
  }
  if (exclusions.produced.size > 0) {
    log.publish(
      `[change-feed] ${exclusions.produced.size} table(s) fed by an in-process change producer instead: ${[...exclusions.produced].sort().join(", ")}`,
    );
  }

  const tables = await listPublicTables(db, exclude);
  const required = new Map(requirements.map((r) => [r.table, r]));
  const pks = await singleColumnPks(db);
  const routedColumns = await tablesColumns(
    db,
    tables.filter((t) => required.has(t)),
  );
  const triggers: TableTrigger[] = [];
  for (const table of tables) {
    const pkCol = pks.get(table) ?? "";
    const requirement = required.get(table);
    triggers.push(
      requirement === undefined
        ? { table, pkCol }
        : {
            table,
            pkCol,
            layout: resolveLayout(
              requirement,
              routedColumnsOf(routedColumns, table),
              pkCol,
            ),
          },
    );
  }
  coveredTables = triggers.map((t) => t.table);

  // The prelude, in its own transaction: the changelog every notify function
  // INSERTs into, and the end marker (a deferred CONSTRAINT trigger, which the
  // installer does not take: Postgres cannot replace one in place). Neither
  // takes a user-table lock, and `ensureChangelogTable` / `ensureTxnEndTrigger`
  // touch the changelog only for a piece the catalog says is missing —
  // `onReadyBlocking` order makes the feed own the changelog's creation.
  await db.transaction(async (tx) => {
    await ensureChangelogTable(tx);
    await tx.execute(drizzleSql.raw(TXN_END_FUNCTION_DDL));
    await ensureTxnEndTrigger(tx);
  });

  if (triggers.length === 0) {
    // A set is functions and the triggers calling them: with no table to feed
    // there is nothing to install (a throwaway database with no tables).
    log.publish(`[change-feed] no table to feed — nothing installed`);
    return { kept: 0 };
  }
  const set = feedTriggerSet(triggers, await adoptableTables(db, triggers));
  const [install] = await installDbTriggers(db, [set], {
    commit: "per-table",
    ...(keepUnfed
      ? {
          keep: (t) =>
            t.schema === "public" && !exclusions.produced.has(t.table),
        }
      : {}),
  });
  const kept = install?.kept ?? 0;
  if (kept > 0) {
    log.publish(
      `[change-feed] kept ${kept} trigger(s) on tables no longer fed until every older process is gone`,
    );
  }
  await db.execute(
    drizzleSql.raw(
      `DROP TABLE IF EXISTS "public"."${LIVE_STATE_TRIGGER_STATE_TABLE}"`,
    ),
  );
  if (install?.outcome === "unchanged") {
    log.publish(
      `[change-feed] up to date (${coveredTables.length} table(s)) — nothing re-run`,
    );
    return { kept };
  }
  log.publish(
    `[change-feed] installed the live_state trigger set over ${coveredTables.length} table(s) (the db-triggers log names each table re-run)`,
  );
  await warnOnCoverageGaps(db, exclude);
  return { kept };
}

const TriggerNameRowSchema = z.object({ tgname: z.string() });

// Boot-time coverage check (replaces a separate ./equin check, which can't
// reach a live DB). After installing triggers, query which public tables (minus
// denylist) lack all three expected triggers and warn loudly on any gap. With
// by-construction coverage this should always be empty; a non-empty result means
// something drifted (a trigger failed to create, or a table appeared between the
// enumerate and the check) and is the loud signal to investigate.
async function warnOnCoverageGaps(
  db: NodePgDatabase,
  exclude: Set<string>,
): Promise<void> {
  const tables = await listPublicTables(db, exclude);
  const gaps: string[] = [];
  for (const table of tables) {
    const rows = await executeRows(db, {
      query: drizzleSql.raw(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = format('public.%I', ${quoteLiteral(table)})::regclass
           AND NOT tgisinternal
           AND tgname LIKE 'live_state_%'`,
      ),
      row: TriggerNameRowSchema,
      label: "warnOnCoverageGaps",
    });
    const names = new Set(rows.map((r) => r.tgname));
    const expected = [
      triggerName(table, "i"),
      triggerName(table, "u"),
      triggerName(table, "d"),
    ];
    if (!expected.every((n) => names.has(n))) gaps.push(table);
  }

  if (gaps.length > 0) {
    log.publish(
      `[change-feed] WARNING: ${gaps.length} public table(s) missing live_state triggers: ${gaps.join(", ")}`,
      "stderr",
    );
  }
}
