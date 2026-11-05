import { escapeLiteral } from "pg";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { defineDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

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
export const SUPERSEDED_FLAG = `${LEGACY_IDS.dbObjectPrefix}.superseded`;

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

const FUNCTION_NAME = `${LEGACY_IDS.dbObjectPrefix}_mark_superseded`;
/** Exported for the regression suite, which drops it out of band to prove a
 * missing trigger is reinstalled. */
export const SUPERSEDED_TRIGGER_NAME = `${LEGACY_IDS.dbObjectPrefix}_mark_superseded`;
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

// Installed by the one trigger installer (`database/db-triggers`), from
// `installQueueSchema` rather than the boot schema layer: it hangs off
// graphile's table, which graphile's own migrations create, and every database
// that gets a queue schema — main's boot, a graphile bump, every `createTestDb`
// throwaway — gets it there. The installer's stamp (the DDL's hash plus the
// catalog definition's, in the trigger's COMMENT — never `pg_get_triggerdef`
// compared against our source, which is Postgres's normalisation of it) makes
// every later install a catalog read with no lock on `_private_jobs`; a trigger
// dropped or disabled out of band is reinstalled. A first install (or a changed
// definition) takes SHARE ROW EXCLUSIVE for one statement, under the set's
// advisory lock — whose two-int key space (`objsubid = 2`) cannot be mistaken
// for a live worker's per-job lock (`objsubid = 1`, `jobLockHeldExpr`).
export const supersededTriggers = defineDbTriggers({
  id: "jobs.superseded",
  functions: [
    {
      schema: "graphile_worker",
      name: FUNCTION_NAME,
      args: "",
      ddl: FUNCTION_DDL,
    },
  ],
  triggers: [
    {
      name: TRIGGER_NAME,
      schema: "graphile_worker",
      table: "_private_jobs",
      ddl: TRIGGER_DDL,
      // What this file stamped before the one installer: adopted, not re-run.
      legacyStamp: sha256Hex(`${FUNCTION_DDL}\n--\n${TRIGGER_DDL}`),
    },
  ],
});
