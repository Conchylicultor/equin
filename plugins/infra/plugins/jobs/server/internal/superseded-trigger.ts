import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { escapeLiteral, type PoolClient } from "pg";
import { z } from "zod";
import { queryRows } from "@plugins/database/plugins/sql-rows/core";

// The one spelling of the flag our trigger writes into graphile's own `flags`
// column when graphile RETIRES a row that is still locked — the moment a newer
// copy of the same job key is queued (`add_jobs`) or the key is removed
// (`remove_job`) while this row is mid-run. The trigger below writes it and the
// queue introspection (`machine/internal/introspection.ts`) reads it, both
// through this constant, so the writer and every reader cannot disagree about
// the name.
//
// graphile reads `flags` only when `forbiddenFlags` is configured, and this repo
// configures none; a retired row also has `attempts = max_attempts`, so it is
// never fetched again anyway. See jobs/CLAUDE.md, "Superseded rows".
export const SUPERSEDED_FLAG = "singularity.superseded";

// ── Marking a row superseded at the one moment it can be told apart ───────────
//
// graphile retires a keyed row that is not `is_available` whenever the same key
// is queued again (`add_jobs`, sql/000018.sql:103-116) or removed (`remove_job`):
// `key = null, attempts = max_attempts, updated_at = now()`. When the row was
// LOCKED at that moment, a newer copy of the job now exists and will run — the old
// row is superseded, not dead. But the retire UPDATE writes exactly the columns a
// genuinely dead row has, and touches neither `revision` nor `flags`, so once the
// row is unlocked (a restart's sweep, a graceful-shutdown timeout, a failing
// overrun) nothing about it says which of the two it was.
//
// "Key is null on a keyed job" is NOT that evidence. graphile retires EVERY
// unavailable row with the key, a dead-lettered one included, so the next cron
// tick of a job that really died would clear its key too and hide it from the
// dead list. The one fact that separates the two is whether the row was locked
// WHEN it was retired, and that is only observable inside the retire UPDATE —
// hence a row trigger, and hence this file.
//
// The `WHEN` clause keeps it off every hot path: Postgres evaluates it before
// calling the function, and `UPDATE OF key` means it is not even considered for
// an UPDATE that does not name `key` — fetch, complete, fail, reschedule and our
// own sweeper never do. Only graphile's two retire-while-locked writes match.
//
// The function lives in `graphile_worker` beside the table it guards, so a
// worktree fork (which copies that schema's DDL and drops only its data — see
// `ExcludeSchemaDataFromFork` in `../index.ts`) is born with it installed.

const FUNCTION_NAME = "singularity_mark_superseded";
/** Exported for the regression suite, which drops it out of band to prove a
 * missing trigger is reinstalled. */
export const SUPERSEDED_TRIGGER_NAME = "singularity_mark_superseded";
const TRIGGER_NAME = SUPERSEDED_TRIGGER_NAME;

// `escapeLiteral` rather than a bound parameter because this is DDL: a function
// body is a string constant, and DDL takes no parameters.
const FUNCTION_DDL = `CREATE OR REPLACE FUNCTION graphile_worker.${FUNCTION_NAME}()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
begin
  new.flags := coalesce(new.flags, '{}'::jsonb) || jsonb_build_object(${escapeLiteral(SUPERSEDED_FLAG)}::text, true);
  return new;
end;
$$`;

// `CREATE OR REPLACE TRIGGER` (PG 14+) rather than DROP + CREATE: it takes the
// same SHARE ROW EXCLUSIVE lock as a plain CREATE, never the ACCESS EXCLUSIVE a
// DROP needs, and swaps the definition atomically.
const TRIGGER_DDL = `CREATE OR REPLACE TRIGGER ${TRIGGER_NAME}
  BEFORE UPDATE OF key ON graphile_worker._private_jobs
  FOR EACH ROW
  WHEN (OLD.locked_at IS NOT NULL AND OLD.key IS NOT NULL AND NEW.key IS NULL)
  EXECUTE FUNCTION graphile_worker.${FUNCTION_NAME}()`;

// Content signature of the DDL above, stored as the trigger's own COMMENT. It is
// what "its definition differs" means here, and it is compared rather than
// `pg_get_triggerdef`'s output on purpose: that text is Postgres's normalization
// of what we wrote (extra parens, `old.`/`new.` casing, and a spelling that has
// changed across major versions), so matching it against our source would either
// need a hand-maintained copy of the normalized form or would silently mismatch
// on every boot — re-running the DDL, and taking the table lock this file exists
// to avoid, forever. The comment lives ON the trigger, so a trigger dropped out of
// band takes its signature with it and is reinstalled. Same idea as the
// change-feed's trigger-layer signature.
const SIGNATURE = sha256Hex(`${FUNCTION_DDL}\n--\n${TRIGGER_DDL}`);

const InstalledRowSchema = z.object({
  signature: z.string().nullable(),
  // A trigger disabled by hand (`ALTER TABLE … DISABLE TRIGGER`) keeps its
  // comment but stops capturing the evidence; `CREATE OR REPLACE TRIGGER`
  // re-enables it, so a disabled one counts as out of date.
  enabled: z.boolean(),
  function_present: z.boolean(),
});

/**
 * Is the trigger (and its function) already exactly the one this file would
 * install? Reads catalogs only — no lock on `_private_jobs`.
 */
async function isUpToDate(client: PoolClient): Promise<boolean> {
  const rows = await queryRows(client, {
    row: InstalledRowSchema,
    sql: `SELECT obj_description(t.oid, 'pg_trigger')                                  AS signature,
                 t.tgenabled = 'O'                                                     AS enabled,
                 to_regprocedure('graphile_worker.${FUNCTION_NAME}()') IS NOT NULL     AS function_present
            FROM pg_trigger t
           WHERE t.tgrelid = 'graphile_worker._private_jobs'::regclass
             AND t.tgname = $1`,
    params: [TRIGGER_NAME],
  });
  const row = rows[0];
  if (!row) return false;
  return row.signature === SIGNATURE && row.enabled && row.function_present;
}

/**
 * Install the superseded-row trigger on `graphile_worker._private_jobs`, or do
 * nothing when it is already installed as written. Must run after graphile's
 * own migrations, which create the table.
 *
 * Returns what happened, so a regression test can assert that a second call is
 * a genuine no-op rather than a silent reinstall.
 *
 * Why the no-op path matters: every backend calls this at boot, including the
 * one coming up while the outgoing backend's workers are still fetching. The
 * catalog read above takes no table lock, so a boot that finds the trigger
 * already in place touches nothing. Only a first install (or a changed
 * definition) runs the DDL, which briefly takes SHARE ROW EXCLUSIVE on the
 * table — blocking writers for the length of one statement.
 *
 * The slow path is serialized with a transaction-scoped advisory lock and
 * re-checks under it, so two installers racing on one database (a backend
 * booting while a `worktree-db` test process installs against the same
 * database) do not both run the DDL. The two-int lock form lives in a different
 * `pg_locks` key space (`objsubid = 2`) from the per-job locks (`objsubid = 1`,
 * `jobLockHeldExpr`), so it can never be mistaken for a live worker.
 */
export async function installSupersededTrigger(
  client: PoolClient,
): Promise<"installed" | "unchanged"> {
  if (await isUpToDate(client)) return "unchanged";

  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('graphile_worker'), hashtext($1))",
      [TRIGGER_NAME],
    );
    if (await isUpToDate(client)) {
      await client.query("COMMIT");
      return "unchanged";
    }
    await client.query(FUNCTION_DDL);
    await client.query(TRIGGER_DDL);
    await client.query(
      `COMMENT ON TRIGGER ${TRIGGER_NAME} ON graphile_worker._private_jobs IS ${escapeLiteral(SIGNATURE)}`,
    );
    await client.query("COMMIT");
    return "installed";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
