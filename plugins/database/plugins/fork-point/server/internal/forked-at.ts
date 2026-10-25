import { db } from "@plugins/database/server";
import {
  executeOne,
  type SqlExecutable,
} from "@plugins/database/plugins/sql-rows/core";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { FORKED_AT_SETTING } from "../../core";

// Epoch milliseconds as float8, which pg decodes to a JS number — a raw-SQL
// `timestamptz` would arrive as text in the session's own format.
const ForkedAtRowSchema = z.object({ forked_at_ms: z.number().nullable() });

/**
 * When this database was forked from another: every row created at or before
 * it was copied in from the source, every row created after it is this
 * database's own. `null` for a database that was never forked — main's, a
 * composition's, a release's, one restored from a backup — all of whose rows
 * are its own.
 *
 * Read from the database itself (see `FORKED_AT_SETTING`), never inferred from
 * the namespace: a name can be renamed, and a release is not main yet owns
 * every row it holds.
 *
 * `exec` reads whichever database it is connected to (a test's throwaway one).
 */
export async function databaseForkedAt(
  exec: SqlExecutable<SQL> = db,
): Promise<Date | null> {
  // `true`: an unset setting reads NULL rather than raising; `nullif` covers
  // one a session RESET to the empty string.
  const { forked_at_ms } = await executeOne(exec, {
    query: sql.raw(
      `SELECT (extract(epoch FROM nullif(current_setting('${FORKED_AT_SETTING}', true), '')::timestamptz) * 1000)::float8 AS forked_at_ms`,
    ),
    row: ForkedAtRowSchema,
    label: "databaseForkedAt",
  });
  return forked_at_ms === null ? null : new Date(forked_at_ms);
}
