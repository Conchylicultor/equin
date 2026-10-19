import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";
import {
  executeOne,
  executeRows,
} from "@plugins/database/plugins/sql-rows/core";
import { LIVE_STATE_CHANGELOG_TABLE } from "@plugins/database/plugins/derived-views/core";

// The end-of-transaction marker (research/2026-10-19-global-live-compiled-narrowing.md
// B): every transaction that writes the feed ends with ONE `live_state_end`
// NOTIFY, sent at commit after all of its `live_state` ones, so the listener can
// hold a transaction's changes until it has them all (`burst.ts`).
//
// Both notify functions INSERT one changelog row per statement, so the marker is
// a deferred constraint trigger ON the changelog: deferred triggers fire at
// commit, after every statement, so its NOTIFY is the transaction's last. It
// fires once per changelog row and emits on the first only, guarded by a
// transaction-local setting holding the xid; `n` is that xid's changelog row
// count (`live_state_changelog_xid_idx`). All channels share one notification
// queue, so the order holds across channels. Its own channel means a backend
// still running older code during a hot swap, which does not LISTEN on it,
// never sees a payload it cannot read.
//
// Installed with the shared layer (the prelude transaction), and fingerprinted
// with it. `planRebuild` re-verifies the function and the trigger from the
// catalog like every other object of the layer.

/** The channel every table change is NOTIFYed on. */
export const FEED_CHANNEL = "live_state";
/** The channel a transaction's end marker is NOTIFYed on. */
export const TXN_END_CHANNEL = "live_state_end";

export const TXN_END_TRIGGER = "live_state_txn_end";

export const TXN_END_FUNCTION_DDL = `
CREATE OR REPLACE FUNCTION live_state_txn_end() RETURNS trigger AS $live_state$
DECLARE
  tx text := pg_current_xact_id()::text;
  n bigint;
BEGIN
  -- One marker per transaction: the first changelog row's firing sends it,
  -- every later one finds the guard set. The setting is transaction-local.
  IF current_setting('live.txn_end', true) IS NOT DISTINCT FROM tx THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('live.txn_end', tx, true);
  SELECT count(*) INTO n FROM ${LIVE_STATE_CHANGELOG_TABLE} AS c WHERE c.xid = tx::numeric;
  PERFORM pg_notify('${TXN_END_CHANNEL}', json_build_object('x', tx, 'n', n)::text);
  RETURN NULL;
END;
$live_state$ LANGUAGE plpgsql;
`;

export const TXN_END_TRIGGER_DDL = `CREATE CONSTRAINT TRIGGER ${TXN_END_TRIGGER} AFTER INSERT ON ${LIVE_STATE_CHANGELOG_TABLE}
       DEFERRABLE INITIALLY DEFERRED
       FOR EACH ROW EXECUTE FUNCTION live_state_txn_end()`;

/**
 * True when the marker trigger is installed as `TXN_END_TRIGGER_DDL` makes it:
 * on the changelog, calling `live_state_txn_end()`, deferred, enabled. A SQL
 * boolean expression, read by `planRebuild` and `ensureTxnEndTrigger`.
 */
export const TXN_END_INSTALLED_SQL = `EXISTS (
  SELECT 1 FROM pg_trigger t
  WHERE t.tgrelid = to_regclass('public.${LIVE_STATE_CHANGELOG_TABLE}')
    AND t.tgname = '${TXN_END_TRIGGER}'
    AND t.tgfoid = to_regproc('public.live_state_txn_end')
    AND t.tgdeferrable AND t.tginitdeferred
    AND t.tgenabled <> 'D'
)`;

const InstalledRowSchema = z.object({ installed: z.boolean() });

/**
 * Install the marker trigger, only when the catalog says it is missing or not
 * the one we make: `CREATE TRIGGER` locks the changelog (SHARE ROW EXCLUSIVE),
 * which every writer in the database INSERTs into — behind one open writing
 * transaction, they would all queue on it. Runs in the prelude, after the
 * function exists.
 */
export async function ensureTxnEndTrigger(db: NodePgDatabase): Promise<void> {
  const { installed } = await executeOne(db, {
    query: drizzleSql.raw(`SELECT ${TXN_END_INSTALLED_SQL} AS installed`),
    row: InstalledRowSchema,
    label: "ensureTxnEndTrigger",
  });
  if (installed) return;
  await db.execute(
    drizzleSql.raw(
      `DROP TRIGGER IF EXISTS ${TXN_END_TRIGGER} ON ${LIVE_STATE_CHANGELOG_TABLE}`,
    ),
  );
  await db.execute(drizzleSql.raw(TXN_END_TRIGGER_DDL));
}

const DeferredTriggerRowSchema = z.object({
  relname: z.string(),
  tgname: z.string(),
});

/**
 * Boot assertion: no deferred (or deferrable) trigger other than the marker sits
 * on a triggered table or on the changelog. Such a trigger fires at commit too,
 * and a write it makes there would NOTIFY after the marker — a change the
 * listener would route after its transaction's ack. Internal triggers are
 * skipped: a deferrable foreign key or unique constraint only checks (referential
 * actions are never deferred), so it writes nothing.
 */
export async function assertNoOtherDeferredTriggers(
  db: NodePgDatabase,
  tables: readonly string[],
): Promise<void> {
  const relnames = [...new Set([...tables, LIVE_STATE_CHANGELOG_TABLE])];
  const rows = await executeRows(db, {
    query: drizzleSql`
      SELECT c.relname, t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND NOT t.tgisinternal
        AND (t.tgdeferrable OR t.tginitdeferred)
        AND c.relname IN (${drizzleSql.join(
          relnames.map((r) => drizzleSql`${r}`),
          drizzleSql`, `,
        )})
        AND NOT (c.relname = ${LIVE_STATE_CHANGELOG_TABLE} AND t.tgname = ${TXN_END_TRIGGER})
      ORDER BY c.relname, t.tgname
    `,
    row: DeferredTriggerRowSchema,
    label: "assertNoOtherDeferredTriggers",
  });
  if (rows.length > 0) {
    throw new Error(
      `[change-feed] ${rows.length} deferred trigger(s) on a table the feed routes, or on its changelog: ` +
        rows.map((r) => `"${r.tgname}" on "${r.relname}"`).join(", ") +
        ` — a deferred trigger fires at commit, so a write it makes would NOTIFY after the transaction's end marker (live_state_txn_end) and reach readers after the transaction's ack. Make it immediate (NOT DEFERRABLE).`,
    );
  }
}
