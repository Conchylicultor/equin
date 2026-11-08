import { desc, inArray } from "drizzle-orm";
import type {
  PgColumn,
  PgDatabase,
  PgQueryResultHKT,
  PgTable,
} from "drizzle-orm/pg-core";

/** Any drizzle Postgres handle — `db`, a transaction, a test fixture's. */
type TrimExecutor = Pick<
  PgDatabase<PgQueryResultHKT, Record<string, never>>,
  "select" | "delete"
>;

/**
 * Bound a ring table to its newest `keep` rows: the DELETE of every row past
 * the first `keep` in `newestFirst` order (ties broken by `key`), as a drizzle
 * builder — await it, or hand it to `writeAtomically` as one arm.
 *
 * The typed spelling of the hand-written `DELETE … WHERE id IN (SELECT id …
 * ORDER BY … OFFSET n)` every capped log used to carry (claude-cli's call log,
 * the event-emission ring, the dead-job archive): the table and both columns
 * are handles, so a renamed column is a tsc error rather than a runtime 42703.
 */
export function trimToNewest(
  exec: TrimExecutor,
  table: PgTable,
  opts: {
    /** The row's key (unique, not null): what the DELETE matches on. */
    readonly key: PgColumn;
    /** The column "newest" is read off, descending. */
    readonly newestFirst: PgColumn;
    readonly keep: number;
  },
) {
  if (!Number.isInteger(opts.keep) || opts.keep < 0)
    throw new Error(
      `trimToNewest: keep must be a non-negative integer, got ${opts.keep}`,
    );
  const beyond = exec
    .select({ key: opts.key })
    .from(table)
    .orderBy(desc(opts.newestFirst), desc(opts.key))
    .offset(opts.keep);
  return exec.delete(table).where(inArray(opts.key, beyond));
}
