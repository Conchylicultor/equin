import { createHash } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import {
  executeOne,
  executeRows,
} from "@plugins/database/plugins/sql-rows/core";
import {
  MIGRATIONS_TABLE_NAME,
  LIVE_STATE_CHANGELOG_TABLE,
  LIVE_STATE_SNAPSHOT_TABLE,
  LIVE_STATE_TRIGGER_STATE_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import type { TableLayoutRequirement } from "@plugins/framework/plugins/server-core/core";
import { changeFeedLog as log } from "./log-sink";
import {
  ensureTxnEndTrigger,
  TXN_END_FUNCTION_DDL,
  TXN_END_INSTALLED_SQL,
  TXN_END_TRIGGER,
  TXN_END_TRIGGER_DDL,
} from "./txn-end";

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
// `live_state_trigger_state` (this layer's own content signature — see
// `rebuildTriggers`) is denylisted for the same reason as the snapshot table: it
// is written only by the rebuild itself and read only at boot, so it is pure
// plumbing no live-state loader ever reads. Triggering on it would also make the
// rebuild's own signature write re-enter the feed.
function buildDenylist(exclusions: TriggerExclusions): Set<string> {
  return new Set<string>([
    MIGRATIONS_TABLE_NAME,
    LIVE_STATE_CHANGELOG_TABLE,
    LIVE_STATE_SNAPSHOT_TABLE,
    LIVE_STATE_TRIGGER_STATE_TABLE,
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

// L2 durable outbox DDL. Created INSIDE rebuildTriggers' transaction, before the
// trigger function is (re)defined, so the table the function INSERTs into is
// guaranteed to exist before any data-change trigger can fire. Derived-state
// table (CREATE TABLE IF NOT EXISTS on boot, like __singularity_derived_view_state)
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
// DDL — created with CREATE OR REPLACE on every boot (never a migration), exactly
// like derived-views.
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

// Deterministic trigger names so DROP IF EXISTS + CREATE is idempotent across
// boots. One trigger per op so each can declare its own transition table.
function triggerName(table: string, op: "i" | "u" | "d"): string {
  return `live_state_${table}_${op}`;
}

// Every catalog column this file reads (`relname`, `attname`, `tgname`) is a
// SCALAR `name` (OID 19), which pg does decode to a string — so these schemas say
// `z.string()` and the SQL needs no cast. It is `name[]` (OID 1003, what an
// uncast `array_agg` over one of these produces) that has no decoder and arrives
// as a raw Postgres literal string; see the sql-rows plugin's CLAUDE.md.
const TableNameRowSchema = z.object({ relname: z.string() });

// One installed `live_state_*` trigger and the table it sits on. Shared by the
// stale-trigger discovery and the rebuild plan, which read the same catalog
// query.
const LiveStateTriggerRowSchema = z.object({
  tgname: z.string(),
  relname: z.string(),
});

// Every public-schema user table minus the exclusion set (infra denylist ∪
// derived-table rollups ∪ feature-contributed `ExcludeFromChangeFeed` tables).
// The caller passes the set (built once via `buildDenylist(…)`) so the same
// snapshot drives table enumeration, the stale-trigger drop, and the coverage
// check within one rebuild.
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

const PkColumnRowSchema = z.object({ attname: z.string() });

// The single-column primary key of a table, or "" for composite/no PK
// (→ FULL-for-table). Exactly one row from this query ⇒ single-column PK.
async function singleColumnPk(
  db: NodePgDatabase,
  table: string,
): Promise<string> {
  const rows = await executeRows(db, {
    query: drizzleSql.raw(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = format('public.%I', ${quoteLiteral(table)})::regclass
         AND i.indisprimary`,
    ),
    row: PkColumnRowSchema,
    label: "singleColumnPk",
  });
  const row = rows.length === 1 ? rows[0] : undefined;
  return row ? row.attname : "";
}

// The statements that install one table's feed: a DROP IF EXISTS + CREATE per op,
// so the pair is idempotent across boots. Compiled once and used for BOTH
// execution and the content signature, so the fingerprint can never drift from the
// SQL we actually emit — change this template and every table's signature changes,
// forcing the rebuild that the change requires (mirrors derived-views compiling
// `compileCreateView` once and hashing that same string).
//
// A table with a `layout` (one a route reads) calls `live_state_notify_routed`
// with its layout as arguments, and its UPDATE trigger declares both transition
// tables; without one the statements are exactly the PK-only feed's, byte for
// byte — an unrouted table's trigger never changes (and never rebuilds) because
// routing exists.
export function compileTableTriggerDdl(
  table: string,
  pkCol: string,
  layout?: TriggerLayout,
): string[] {
  const tbl = quoteIdent(table);
  const ti = triggerName(table, "i");
  const tu = triggerName(table, "u");
  const td = triggerName(table, "d");
  if (layout !== undefined) {
    const args = [
      quoteLiteral(pkCol),
      quoteLiteral(JSON.stringify(layout.carry)),
      quoteLiteral(JSON.stringify(layout.gate)),
    ].join(", ");
    return [
      `DROP TRIGGER IF EXISTS ${quoteIdent(ti)} ON ${tbl}`,
      `DROP TRIGGER IF EXISTS ${quoteIdent(tu)} ON ${tbl}`,
      `DROP TRIGGER IF EXISTS ${quoteIdent(td)} ON ${tbl}`,
      `CREATE TRIGGER ${quoteIdent(ti)} AFTER INSERT ON ${tbl}
           REFERENCING NEW TABLE AS new_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify_routed(${args})`,
      `CREATE TRIGGER ${quoteIdent(tu)} AFTER UPDATE ON ${tbl}
           REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify_routed(${args})`,
      `CREATE TRIGGER ${quoteIdent(td)} AFTER DELETE ON ${tbl}
           REFERENCING OLD TABLE AS old_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify_routed(${args})`,
    ];
  }
  const arg = quoteLiteral(pkCol); // empty string ⇒ FULL-for-table
  return [
    `DROP TRIGGER IF EXISTS ${quoteIdent(ti)} ON ${tbl}`,
    `DROP TRIGGER IF EXISTS ${quoteIdent(tu)} ON ${tbl}`,
    `DROP TRIGGER IF EXISTS ${quoteIdent(td)} ON ${tbl}`,
    `CREATE TRIGGER ${quoteIdent(ti)} AFTER INSERT ON ${tbl}
           REFERENCING NEW TABLE AS new_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify(${arg})`,
    `CREATE TRIGGER ${quoteIdent(tu)} AFTER UPDATE ON ${tbl}
           REFERENCING NEW TABLE AS new_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify(${arg})`,
    `CREATE TRIGGER ${quoteIdent(td)} AFTER DELETE ON ${tbl}
           REFERENCING OLD TABLE AS old_rows
           FOR EACH STATEMENT EXECUTE FUNCTION live_state_notify(${arg})`,
  ];
}

const ColumnNameRowSchema = z.object({ attname: z.string() });

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

type CompiledTable = { table: string; stmts: string[]; signature: string };

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

// Bookkeeping for the trigger layer's content signatures — the twin of
// derived-views' `derived_view_state`, created idempotently here (not via a
// migration) because, like the triggers it tracks, it is derived-layer state,
// not schema in the migration chain. It lives in the DB so a worktree fork
// carries the signatures with its triggers (`CREATE DATABASE … TEMPLATE` copies
// the rows), avoiding a spurious first-boot rebuild on every fork.
//
// ONE ROW PER OBJECT, so a change rebuilds only what it changed: a row per
// triggered table (its compiled statements' hash, stamped in the same
// transaction that installs them — so the row is exactly what is installed,
// whatever boot dies where), and the `LAYER_ROW` row for the shared layer (the
// two notify functions and the changelog DDL, stamped in the prelude that
// creates them). A route adding a column to one table's layout rebuilds that
// table alone; every other table's triggers are left untouched.
const TRIGGER_STATE_DDL = `
CREATE TABLE IF NOT EXISTS "public"."${LIVE_STATE_TRIGGER_STATE_TABLE}" (
  relname   text PRIMARY KEY,
  signature text NOT NULL
)`;
// The shared layer's row — never a table name (Postgres has no empty identifier).
const LAYER_ROW = "";

// The state table in its per-object shape. The first shape was ONE row
// (`id boolean PRIMARY KEY`, one whole-layer signature): it is dropped and
// recreated, which costs one rebuild of every table — its own signature said
// nothing about which table was up to date. Only the rebuild reads or writes
// this table, so replacing it locks nothing anyone else is waiting on.
async function ensureTriggerStateTable(db: NodePgDatabase): Promise<void> {
  if (
    (await relationExists(db, LIVE_STATE_TRIGGER_STATE_TABLE)) &&
    !(await tableColumns(db, LIVE_STATE_TRIGGER_STATE_TABLE)).includes(
      "relname",
    )
  ) {
    await db.execute(
      drizzleSql.raw(`DROP TABLE "public"."${LIVE_STATE_TRIGGER_STATE_TABLE}"`),
    );
  }
  await db.execute(drizzleSql.raw(TRIGGER_STATE_DDL));
}

// Record one object's signature — inside the transaction that installed it.
async function stampSignature(
  tx: NodePgDatabase,
  relname: string,
  signature: string,
): Promise<void> {
  await tx.execute(
    drizzleSql`
      INSERT INTO "public".${drizzleSql.raw(`"${LIVE_STATE_TRIGGER_STATE_TABLE}"`)} (relname, signature)
      VALUES (${relname}, ${signature})
      ON CONFLICT (relname) DO UPDATE SET signature = EXCLUDED.signature
    `,
  );
}

// Cached at boot during rebuildTriggers — the set of public tables we installed
// triggers on. The listener's on-reconnect FULL sweep iterates this set (see
// listener.ts). It is the by-construction-complete table universe; a table no
// route names and no read-set base is reaches nothing, so sweeping all of them
// is safe and total.
//
// Set from the DESIRED set on every boot, including the skip-when-unchanged path
// (where "desired" is proven to equal "installed") — `assertRouteTablesCovered`
// reads it via `getCoveredTables()` immediately after, so it must be populated
// whether or not we rebuilt.
let coveredTables: string[] = [];

export function getCoveredTables(): readonly string[] {
  return coveredTables;
}

// Rebuilds the change-feed trigger layer from source — only the parts whose
// compiled DDL changed.
//
// Deterministic, data-less DDL (NOT a migration) — mirrors rebuildDerivedViews:
// enumerate the live schema, CREATE OR REPLACE the functions, then DROP+CREATE
// the per-table triggers. Any failure throws and blocks boot loudly rather than
// running with a half-installed feed.
//
// `db` is passed in (like rebuildDerivedViews / runMigrations) so this module
// never imports @plugins/database/server — that would cycle (database/server
// calls into the change-feed plugin's onReadyBlocking).
//
// SKIP WHAT IS UNCHANGED, PER OBJECT — the trigger layer is a pure function of
// (schema, denylist, routed layouts, emitted DDL). Each table's compiled
// statements are fingerprinted on their own, and so is the shared layer (the
// two functions and the changelog DDL); `planRebuild` compares each against
// its stored signature AND the catalog, and only what differs is rebuilt. A
// steady-state restart — the overwhelming majority of boots — takes ZERO table
// locks; a new table, a dropped exclusion or a route's changed layout locks
// exactly the tables whose triggers change. (A whole-layer signature rebuilt
// every table, each taking an exclusive lock in turn during the hot swap,
// whenever any one of them changed — and routes change layouts far more often
// than the schema does.)
//
// SINGLE-RELATION TRANSACTIONS — a rebuild is one `db.transaction` PER TABLE
// (plus the prelude), never one transaction over the whole schema.
// `DROP+CREATE TRIGGER` takes an AccessExclusive lock on its table until commit;
// the old one-transaction rebuild held exclusive locks on an alphabetically-
// ordered PREFIX of the database while still asking for more — textbook
// hold-and-wait. During a hot-swap restart the PREVIOUS backend is still serving
// reads (the swap is ready-gated) holding AccessShare locks on those same tables,
// so a reader touching two tables in the opposite order closed a lock cycle;
// Postgres shot the rebuild transaction, the exception escaped onReadyBlocking,
// and the deploy failed with the old code still live
// (build-1784288281433-w62dep died this way: attempts ⇄ conversations,
// SQLSTATE 40P01). A transaction that only ever holds ONE relation's exclusive
// lock cannot be a node in a wait cycle — it acquires that one lock or blocks on
// exactly one holder (an old-backend reader, which is not waiting on us for a
// second relation). The wait-for graph is a forest by construction; the deadlock
// is impossible, not retried. A per-table tx can still BLOCK briefly on a live
// reader's AccessShare lock, but the old backend's reads are short (ms), so this
// is a wait, not a hang. (Each per-table tx also upserts that table's own row of
// the state table, which only the rebuild touches.)
//
// Self-healing (see change-feed/CLAUDE.md): each table's DROP+CREATE is in one tx
// so it always has a COMPLETE trigger set (old or new, never none); the notify
// functions are committed FIRST so old and new triggers both call the current
// function (no feed event lost — a mid-rebuild write fires whichever trigger
// version is installed, both emitting a compatible NOTIFY); and every signature
// is stamped IN the transaction that installs what it describes, so a stored
// signature is always the installed one — a boot that dies anywhere leaves each
// object either rebuilt and stamped or untouched with its old stamp, and the
// next boot rebuilds exactly the rest.
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
): Promise<void> {
  // Infra plumbing + derived-table rollups + feature `ExcludeFromChangeFeed`
  // opt-outs, all unioned. One snapshot drives enumeration, the stale-trigger
  // drop below, and the coverage check.
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
  const triggers: TableTrigger[] = [];
  for (const table of tables) {
    const pkCol = await singleColumnPk(db, table);
    const requirement = required.get(table);
    triggers.push(
      requirement === undefined
        ? { table, pkCol }
        : {
            table,
            pkCol,
            layout: resolveLayout(
              requirement,
              await tableColumns(db, table),
              pkCol,
            ),
          },
    );
  }

  // Compile once — this is both what we execute below and what we fingerprint,
  // so a signature can never drift from the SQL it describes.
  const compiled: CompiledTable[] = triggers.map(({ table, pkCol, layout }) => {
    const stmts = compileTableTriggerDdl(table, pkCol, layout);
    return { table, stmts, signature: sha256(stmts.join("\n")) };
  });
  const layerSignature = sha256(
    [
      NOTIFY_FUNCTION_DDL,
      ROUTED_NOTIFY_FUNCTION_DDL,
      CHANGELOG_TABLE_DDL,
      CHANGELOG_INDEX_DDL,
      JSON.stringify(CHANGELOG_LATER_COLUMNS),
      TXN_END_FUNCTION_DDL,
      TXN_END_TRIGGER_DDL,
    ].join("\n--\n"),
  );

  // Populated on BOTH paths — assertRouteTablesCovered reads it right after.
  coveredTables = triggers.map((t) => t.table);

  const plan = await planRebuild(db, layerSignature, compiled, exclude);
  if (
    !plan.layer &&
    plan.tables.length === 0 &&
    plan.stale.size === 0 &&
    plan.forget.length === 0
  ) {
    log.publish(
      `[change-feed] up to date (${coveredTables.length} table(s), signatures unchanged) — skipping rebuild`,
    );
    // The plan just PROVED every expected trigger is installed, which is the
    // same property warnOnCoverageGaps queries for — so the coverage sweep
    // below would be a guaranteed-empty re-verification. Skip it too.
    return;
  }

  // PHASE 1 — Prelude tx, only when the shared layer changed or lost an
  // object. The changelog the trigger functions INSERT into MUST exist before
  // the functions are defined, and the functions MUST exist and be COMMITTED
  // before any per-table trigger that references them is created. Both are set
  // up here in their own transaction, committed before phase 2 opens. Neither
  // takes a user-table lock (`ensureChangelogTable` touches the changelog only
  // for a piece the catalog says is missing; CREATE OR REPLACE FUNCTION locks
  // no table), so the prelude cannot be part of a deadlock cycle.
  // `onReadyBlocking` hooks run in parallel, so change-feed owns the
  // changelog's creation itself rather than relying on any other plugin's boot
  // ordering.
  if (plan.layer) {
    await db.transaction(async (tx) => {
      await ensureChangelogTable(tx);
      await tx.execute(drizzleSql.raw(NOTIFY_FUNCTION_DDL));
      await tx.execute(drizzleSql.raw(ROUTED_NOTIFY_FUNCTION_DDL));
      // The end-of-transaction marker (./txn-end): its function, then its
      // deferred trigger on the changelog — created only when the catalog says
      // it is missing, since CREATE TRIGGER locks the changelog every writer
      // INSERTs into.
      await tx.execute(drizzleSql.raw(TXN_END_FUNCTION_DDL));
      await ensureTxnEndTrigger(tx);
      await stampSignature(tx, LAYER_ROW, layerSignature);
    });
  }

  // PHASE 2 — Per-relation txs. Each transaction touches exactly ONE table's
  // triggers, so it holds at most that one relation's AccessExclusive lock and
  // can never be a node in a wait cycle. `plan.tables` only holds DESIRED
  // (non-excluded) tables and `plan.stale` only excluded ones, so no table is
  // touched by two of these transactions.
  //
  // Stale-drop: one tx per now-excluded table, dropping just its live_state_*
  // triggers (and forgetting its signature).
  for (const [relname, tgnames] of plan.stale) {
    await db.transaction(async (tx) => {
      for (const tgname of tgnames) {
        await tx.execute(
          drizzleSql.raw(
            `DROP TRIGGER IF EXISTS ${quoteIdent(tgname)} ON ${quoteIdent(relname)}`,
          ),
        );
      }
      await forgetSignatures(tx, [relname]);
    });
  }

  // Desired: one tx per changed table, running that table's full DROP+CREATE
  // set (3 DROP IF EXISTS + 3 CREATE) together — so the table always has a
  // COMPLETE trigger set (the DROPs and CREATEs commit atomically, never leaving
  // it trigger-less) — and stamping the signature of what it installed.
  for (const { table, stmts, signature } of plan.tables) {
    await db.transaction(async (tx) => {
      for (const stmt of stmts) {
        await tx.execute(drizzleSql.raw(stmt));
      }
      await stampSignature(tx, table, signature);
    });
  }

  // Signatures of tables no longer triggered (dropped, or excluded with no
  // trigger left to drop): bookkeeping only, no table lock.
  if (plan.forget.length > 0) {
    await forgetSignatures(db, plan.forget);
  }

  log.publish(
    `[change-feed] rebuilt the live_state triggers of ${plan.tables.length} of ${coveredTables.length} table(s)` +
      (plan.layer ? " and the shared layer" : "") +
      (plan.stale.size > 0
        ? ` (dropped stale triggers on ${plan.stale.size} now-excluded table(s))`
        : ""),
  );

  await warnOnCoverageGaps(db, exclude);
}

async function forgetSignatures(
  db: NodePgDatabase,
  relnames: readonly string[],
): Promise<void> {
  await db.execute(
    drizzleSql`
      DELETE FROM "public".${drizzleSql.raw(`"${LIVE_STATE_TRIGGER_STATE_TABLE}"`)}
      WHERE relname IN (${drizzleSql.join(
        relnames.map((r) => drizzleSql`${r}`),
        drizzleSql`, `,
      )})
    `,
  );
}

// One stored signature per object (`relname`, the shared layer under LAYER_ROW).
const SignatureRowSchema = z.object({
  relname: z.string(),
  signature: z.string(),
});

// `to_regproc` / `to_regclass` return NULL when the object does not exist — which
// is exactly what this query asks — so both columns are nullable text.
const LayerObjectsRowSchema = z.object({
  fn: z.string().nullable(),
  routedFn: z.string().nullable(),
  changelog: z.string().nullable(),
  txnEndFn: z.string().nullable(),
  /** The end marker's trigger is installed as the prelude makes it. */
  txnEnd: z.boolean(),
});

/** What a rebuild must do — each part only what differs from the live layer. */
interface RebuildPlan {
  /** The shared layer (functions, changelog, end marker) must be (re)created. */
  layer: boolean;
  /** The desired tables whose triggers must be (re)installed. */
  tables: CompiledTable[];
  /** Now-excluded tables still carrying `live_state_*` triggers, by table. */
  stale: Map<string, string[]>;
  /** Stored signatures of tables that are no longer triggered at all. */
  forget: string[];
}

// Which parts of the live trigger layer are NOT already the desired ones.
//
// A stored signature alone is never trusted — it only says "the transaction that
// installed this object emitted this DDL". Everything it asserts about the
// CURRENT database is re-verified from the catalog: the functions and the
// changelog exist, and each table's three triggers are physically present — so
// anything dropped out of band (a manual DROP TRIGGER, a restored dump, a
// half-cleaned fork) is rebuilt: this mirrors derived-views' `allPresent` guard.
// Reads only catalogs + the signature rows — no user-table locks, which is the
// entire point.
async function planRebuild(
  db: NodePgDatabase,
  layerSignature: string,
  compiled: CompiledTable[],
  exclude: Set<string>,
): Promise<RebuildPlan> {
  await ensureTriggerStateTable(db);

  const stored = new Map(
    (
      await executeRows(db, {
        query: drizzleSql.raw(
          `SELECT relname, signature FROM "public"."${LIVE_STATE_TRIGGER_STATE_TABLE}"`,
        ),
        row: SignatureRowSchema,
        label: "planRebuild/signatures",
      })
    ).map((r) => [r.relname, r.signature]),
  );

  // The trigger functions and the changelog table they INSERT into must all
  // still exist — a trigger whose function vanished would fire and error on
  // every write — and so must the end marker's function and deferred trigger:
  // without it every transaction's changes wait out the listener's deadline.
  // A `SELECT` with no `FROM` returns exactly one row, so this is `executeOne`.
  const objs = await executeOne(db, {
    query: drizzleSql.raw(
      `SELECT to_regproc('public.live_state_notify')::text        AS fn,
              to_regproc('public.live_state_notify_routed')::text AS "routedFn",
              to_regclass('public.${LIVE_STATE_CHANGELOG_TABLE}')::text AS changelog,
              to_regproc('public.live_state_txn_end')::text       AS "txnEndFn",
              ${TXN_END_INSTALLED_SQL} AS "txnEnd"`,
    ),
    row: LayerObjectsRowSchema,
    label: "planRebuild/objects",
  });
  const layer =
    stored.get(LAYER_ROW) !== layerSignature ||
    !objs.fn ||
    !objs.routedFn ||
    !objs.changelog ||
    !objs.txnEndFn ||
    !objs.txnEnd;

  // Every installed live_state_* trigger, by table — but the end marker on
  // the changelog, which belongs to the shared layer (verified above), not to
  // a table's feed: the changelog is denylisted, so it would read as stale.
  const installedRows = await executeRows(db, {
    query: drizzleSql.raw(
      `SELECT t.tgname, c.relname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND NOT t.tgisinternal
         AND t.tgname LIKE 'live_state_%'
         AND NOT (c.relname = '${LIVE_STATE_CHANGELOG_TABLE}' AND t.tgname = '${TXN_END_TRIGGER}')`,
    ),
    row: LiveStateTriggerRowSchema,
    label: "planRebuild/installed",
  });
  const installed = new Set(installedRows.map((r) => r.tgname));

  // A desired table is rebuilt when its signature moved or a trigger is gone.
  const tables = compiled.filter(
    (c) =>
      stored.get(c.table) !== c.signature ||
      !(["i", "u", "d"] as const).every((op) =>
        installed.has(triggerName(c.table, op)),
      ),
  );

  // A live_state_* trigger lingering on a now-excluded table — e.g. a table
  // that had a feed on prior boots and was just opted out via
  // ExcludeFromChangeFeed. Catalog-driven (find-then-drop by name) so it names
  // no specific table and self-heals a rename/drift, mirroring how the rest of
  // this layer is rebuilt from the live schema rather than tracked.
  const stale = new Map<string, string[]>();
  for (const { tgname, relname } of installedRows) {
    if (!exclude.has(relname)) continue;
    const names = stale.get(relname) ?? [];
    names.push(tgname);
    stale.set(relname, names);
  }

  const desired = new Set(compiled.map((c) => c.table));
  const forget = [...stored.keys()].filter(
    (r) => r !== LAYER_ROW && !desired.has(r) && !stale.has(r),
  );

  return { layer, tables, stale, forget };
}

const TriggerNameRowSchema = z.object({ tgname: z.string() });

// Boot-time coverage check (replaces a separate ./singularity check, which can't
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
