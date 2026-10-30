// Public tables created imperatively (outside drizzle's tracked schema), so they
// are NOT present in the drizzle snapshot. The `orphaned-db-tables` check treats
// these as declared, and the sites that create them reference these constants so
// the allowlist can never drift from reality.
//
// That last invariant is STATICALLY ENFORCED by the `imperative-create-table-
// allowlisted` check (plugins/database/plugins/migrations/check/): every real-code
// `CREATE TABLE` must name one of the IMPERATIVE_PUBLIC_TABLES constants on its
// line, so an unallowlisted imperative table cannot land at the push gate (the
// DB-side orphaned-db-tables check only catches it later, on a reachable DB). To
// add an imperative table: add its name constant below, add it to the
// IMPERATIVE_PUBLIC_TABLES record BY SHORTHAND (`{ MY_TABLE }`, never
// `{ ALIAS: MY_TABLE }` — see that record's doc comment), and interpolate that
// constant on the CREATE TABLE line at the create site.
//
// This list is for tables in the REAL worktree DB only. A test that just needs a
// scratch table must NOT be added here: provision a throwaway database with
// `createTestDb` (@plugins/database/plugins/db-test-fixture/server/testing) and create the
// table on that instead. Such a database is dropped in teardown and is never what
// orphaned-db-tables scans, so the check exempts those create sites — while an
// entry here would make orphaned-db-tables treat a test fixture's name as declared
// schema of a database it does not exist in.
//
// Lives in the derived-views CORE leaf — the shared sink every consumer already
// depends on (migrations → derived-views, change-feed → derived-views,
// database/server → derived-views, and the migrations check). It is deliberately
// NOT in `@plugins/database/core`: importing that from migrations/derived-views
// server code (which `database/server` depends on) would close a cross-plugin
// import cycle. The derived-views core leaf has no such back-edge.
//
// Pure module: no imports that pull in a DB pool, so it stays import-safe for
// tooling/check subprocesses (which declare no runtime namespace).

import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

/**
 * Public table created imperatively by the migration runner
 * (`plugins/database/plugins/migrations/server/internal/runner.ts`) — the
 * applied-state ledger keyed by migration hash. Not present in the drizzle
 * snapshot; the orphaned-db-tables check treats it as declared.
 */
export const MIGRATIONS_TABLE_NAME = `__${LEGACY_IDS.dbObjectPrefix}_migrations`;

/**
 * Public table created imperatively by the derived-view rebuilder
 * (`plugins/database/plugins/derived-views/server/internal/rebuild.ts`) — holds
 * the derived-view layer's content signature. Not present in the drizzle
 * snapshot; the orphaned-db-tables check treats it as declared.
 */
export const DERIVED_VIEW_STATE_TABLE_NAME = "derived_view_state";

/**
 * The L2 durable change outbox, created imperatively by change-feed inside its
 * trigger-rebuild transaction
 * (`plugins/database/plugins/change-feed/server/internal/triggers.ts`) — the
 * `live_state_notify()` trigger function INSERTs into it on every commit. Not
 * present in the drizzle snapshot; the orphaned-db-tables check treats it as
 * declared.
 */
export const LIVE_STATE_CHANGELOG_TABLE = "live_state_changelog";

/**
 * Public table created imperatively by the change-feed trigger rebuilder
 * (`plugins/database/plugins/change-feed/server/internal/triggers.ts`) — holds
 * the trigger layer's content signature, the twin of
 * `DERIVED_VIEW_STATE_TABLE_NAME`. It is what lets a steady-state restart skip
 * the rebuild (and its whole-database AccessExclusive lock window) entirely. Not
 * present in the drizzle snapshot; the orphaned-db-tables check treats it as
 * declared.
 */
export const LIVE_STATE_TRIGGER_STATE_TABLE = "live_state_trigger_state";

/**
 * The L2 persisted live-state materialization, created imperatively by
 * live-state-snapshot
 * (`plugins/database/plugins/live-state-snapshot/server/internal/tables-ddl.ts`)
 * — the durable snapshot + xmin watermark read at cold boot. Not present in the
 * drizzle snapshot; the orphaned-db-tables check treats it as declared.
 */
export const LIVE_STATE_SNAPSHOT_TABLE = "live_state_snapshot";

/**
 * The L2 changelog's prune horizon, created imperatively by live-state-snapshot
 * (`plugins/database/plugins/live-state-snapshot/server/internal/tables-ddl.ts`)
 * — one row: the highest changelog xid the prune ever deleted, written by the
 * prune's own statement. Catch-up reads it to tell "history at or after this
 * floor was pruned" (backstop) from "no change happened since it" (replay). Not
 * present in the drizzle snapshot; the orphaned-db-tables check treats it as
 * declared.
 */
export const LIVE_STATE_CHANGELOG_HORIZON_TABLE =
  "live_state_changelog_horizon";

/**
 * Public table created imperatively by live-state-snapshot
 * (`server/internal/tables-ddl.ts`): the epoch handoff — one row per backend
 * boot that shut down cleanly, the tuples it vouched for at its feed cut and
 * the cut's xid, read by its successor to answer a replayed sub `up-to-date`
 * across the restart. Kept an hour. Not present in the drizzle snapshot; the
 * orphaned-db-tables check treats it as declared.
 */
export const LIVE_STATE_HANDOFF_TABLE = "live_state_handoff";

/**
 * Public table created imperatively by the derived-table rebuilder
 * (`plugins/database/plugins/derived-tables/server/internal/rebuild.ts`) — holds
 * the rollup layer's DEFINITION signatures, one row per object (each rollup's
 * maintain functions, each source table's rollup triggers), the twin of
 * `DERIVED_VIEW_STATE_TABLE_NAME` and `LIVE_STATE_TRIGGER_STATE_TABLE`.
 * It gates only the definition half: each rollup's reconcile still runs on
 * every boot, because a rollup holds ROWS and can drift from its source with its
 * definition unchanged. Not present in the drizzle snapshot; the
 * orphaned-db-tables check treats it as declared.
 */
export const DERIVED_TABLE_OBJECT_STATE_TABLE = "derived_table_object_state";

/**
 * LEGACY: the rollup layer's former ONE-ROW whole-layer signature table
 * (`id boolean, signature`), still read and written by builds before
 * `defineRollup`. The derived-table rebuilder keeps it in that shape and only
 * empties it every boot, so an older build booting on this database (a revert
 * of main, a branch on a fork of main) finds no signature and reinstalls its
 * own triggers instead of trusting a stale one. Created only by those older
 * builds; drop it once no supported build reads it. Not present in the drizzle
 * snapshot; the orphaned-db-tables check treats it as declared.
 */
export const DERIVED_TABLE_STATE_TABLE = "derived_table_state";

/**
 * A trigger-maintained materialized rollup ("hand-rolled IVM"): the latest
 * non-system conversation per task, maintained incrementally by STATEMENT
 * triggers on `conversations` and rebuilt from source on boot. Created
 * imperatively by the boot schema layer (`rebuildDerivedTables`, from the
 * `defineRollup` declaration in
 * `plugins/conversations/plugins/agents/server/internal/rollup-spec.ts`). Not
 * present in the drizzle snapshot; the orphaned-db-tables check treats it as
 * declared. `defineRollup` generates its `CREATE TABLE` from the read handle,
 * so the line carries `assertImperativePublicTable(…)` instead of this constant.
 */
export const TASK_LATEST_CONVERSATION_TABLE = "task_latest_conversation";

/**
 * A trigger-maintained materialized rollup ("hand-rolled IVM"): the per-attempt
 * conversation aggregate (has-conversation / has-live-conversation / max ended_at)
 * backing `attempts_v`, maintained incrementally by STATEMENT triggers on
 * `conversations` and reconciled from source on boot. Created imperatively by
 * `rebuildDerivedTables` (from the `defineRollup` declaration in
 * `plugins/tasks/plugins/tasks-core/server/internal/rollup-spec.ts`). Not present
 * in the drizzle snapshot; the orphaned-db-tables check treats it as declared.
 * `defineRollup` generates its `CREATE TABLE` from the read handle, so the line
 * carries `assertImperativePublicTable(…)` instead of this constant.
 */
export const ATTEMPT_CONV_AGG_TABLE = "attempt_conv_agg";

/**
 * A trigger-maintained materialized rollup ("hand-rolled IVM"): the per-attempt
 * push aggregate (has-push / min created_at) backing `attempts_v`, maintained
 * incrementally by STATEMENT triggers on `pushes` and rebuilt from source on
 * boot. Created imperatively by `rebuildDerivedTables` (from the `defineRollup`
 * declaration in `plugins/tasks/plugins/tasks-core/server/internal/rollup-spec.ts`).
 * Not present in the drizzle snapshot; the orphaned-db-tables check treats it as
 * declared. `defineRollup` generates its `CREATE TABLE` from the read handle, so
 * the line carries `assertImperativePublicTable(…)` instead of this constant.
 */
export const ATTEMPT_PUSH_AGG_TABLE = "attempt_push_agg";

/**
 * A trigger-maintained materialized rollup ("hand-rolled IVM"): per page, the
 * newest `updated_at` over its live content blocks (`page_id = P`, sub-page
 * rows included), which the `pages.tree` set joins to give every page row its
 * `editedAt`. Maintained incrementally by STATEMENT triggers on `page_blocks`
 * and reconciled from source on boot. Created imperatively by
 * `rebuildDerivedTables` (from the `defineRollup` declaration in
 * `plugins/page/plugins/editor/server/internal/rollup-spec.ts`). Not present in
 * the drizzle snapshot; the orphaned-db-tables check treats it as declared.
 * `defineRollup` generates its `CREATE TABLE` from the read handle, so the line
 * carries `assertImperativePublicTable(…)` instead of this constant.
 */
export const PAGE_CONTENT_EDITED_AT_TABLE = "page_content_edited_at";

/**
 * The full allowlist of public tables created imperatively (outside drizzle),
 * keyed BY THE NAME OF THE CONSTANT that holds each table name.
 *
 * The shorthand form is load-bearing, not cosmetic. Two static checks enforce a
 * TEXTUAL coupling on these constants:
 *   - `imperative-create-table-allowlisted` — the create site must interpolate
 *     the constant on its `CREATE TABLE` line (the table name itself never
 *     appears there).
 *   - `table-defs-in-schema-glob` — a `pgTable(...)` READ handle outside the
 *     drizzle schema glob must pass the constant, never a string literal.
 * Both therefore need the identifier NAMES, which a plain `string[]` of values
 * does not publish — so each check used to regex them back out of THIS FILE'S
 * TEXT, with two independently hand-rolled array-literal parsers that could
 * silently disagree. Writing each entry as shorthand (`{ FOO }`, not
 * `{ BAR: FOO }`) is what makes each key the identifier a call site must spell,
 * so the names are declared data instead of a parse.
 *
 * `imperative-create-table-allowlisted` PROVES the shorthand invariant: every
 * key must name an export of the `derived-views/core` barrel holding that exact
 * value. A non-shorthand entry — or a constant missing from the barrel every
 * create site imports it from — fails there, loudly, at the push gate.
 */
export const IMPERATIVE_PUBLIC_TABLES = {
  MIGRATIONS_TABLE_NAME,
  DERIVED_VIEW_STATE_TABLE_NAME,
  LIVE_STATE_TRIGGER_STATE_TABLE,
  LIVE_STATE_CHANGELOG_TABLE,
  LIVE_STATE_SNAPSHOT_TABLE,
  LIVE_STATE_CHANGELOG_HORIZON_TABLE,
  LIVE_STATE_HANDOFF_TABLE,
  DERIVED_TABLE_STATE_TABLE,
  DERIVED_TABLE_OBJECT_STATE_TABLE,
  TASK_LATEST_CONVERSATION_TABLE,
  ATTEMPT_CONV_AGG_TABLE,
  ATTEMPT_PUSH_AGG_TABLE,
  PAGE_CONTENT_EDITED_AT_TABLE,
} as const satisfies Record<string, string>;

/**
 * The imperative table NAMES (the record's values). What a DB-side scan compares
 * against `pg_stat_user_tables`: the orphaned-db-tables check subtracts these
 * from the live-table set so they are never flagged as orphans.
 */
export const IMPERATIVE_PUBLIC_TABLE_NAMES: readonly string[] = Object.values(
  IMPERATIVE_PUBLIC_TABLES,
);

/**
 * The constant IDENTIFIERS (the record's keys). What a create site must
 * interpolate on its `CREATE TABLE` line, and what a sanctioned `pgTable(...)`
 * read handle must pass — i.e. what the two static checks match textually.
 */
export const IMPERATIVE_PUBLIC_TABLE_CONSTS: readonly string[] = Object.keys(
  IMPERATIVE_PUBLIC_TABLES,
);

/**
 * The RUNTIME half of the allowlist, for a create site that cannot spell its
 * table's constant on the `CREATE TABLE` line because it GENERATES the DDL from
 * data (derived-tables' `defineRollup`, which renders a rollup's table from its
 * drizzle read handle). Returns `name` unchanged when it is an allowlisted
 * imperative table, and throws otherwise — so an unallowlisted generated table
 * fails at module eval (where `defineRollup` calls it) and again at the create
 * site, never silently at a later orphaned-db-tables scan.
 *
 * The `imperative-create-table-allowlisted` check accepts a `CREATE TABLE` line
 * that CALLS this function in place of naming a constant: the call is the
 * line's evidence that its table name is checked against this same record.
 */
export function assertImperativePublicTable(name: string): string {
  if (!IMPERATIVE_PUBLIC_TABLE_NAMES.includes(name)) {
    throw new Error(
      `"${name}" is not an imperative public table: add a name constant for it to IMPERATIVE_PUBLIC_TABLES (plugins/database/plugins/derived-views/core/internal/imperative-tables.ts, by shorthand) and re-export it from the derived-views core barrel.`,
    );
  }
  return name;
}
