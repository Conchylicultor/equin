import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DbExecutor } from "./current-tx-id";

/**
 * One write of an atomic group: a drizzle `insert` / `update` / `delete`
 * builder (built on any executor — it is rendered, never run), or a
 * ``sql`INSERT …` ``. `null` is a write the caller decided not to make
 * (`rows.length > 0 ? db.insert(t).values(rows) : null`).
 */
export type AtomicWrite = SQLWrapper | null;

/**
 * Run several writes atomically, in ONE statement — the way a background
 * writer makes a group of writes that read nothing in between, instead of a
 * `db.transaction` of round trips (`database/no-pure-write-transaction`).
 *
 * Between two statements of a transaction the server sits idle in
 * transaction, holding the locks the first one took, while the app does its
 * next round trip; a stalled or lost app there queues every writer of those
 * rows (the 2026-11-03 incident,
 * research/2026-11-04-global-db-connection-failure-vision.md, point 5). One
 * statement has no such window: the writes become the arms of a data-modifying
 * CTE, `WITH w0 AS (…), w1 AS (…) SELECT 1`, which Postgres runs to completion
 * and commits (or rolls back) as one. Each arm fires its own triggers (row
 * triggers such as derived `updatedAt`, the change feed's statement triggers),
 * and foreign keys are checked at the end of the statement, so a child row may
 * reference a parent another arm inserts.
 *
 * What one statement asks of its arms — Postgres's rules for data-modifying
 * CTEs, not this helper's:
 * - **Every arm sees the same snapshot**, taken before any of them runs: no
 *   arm sees another's effects. An arm whose input is another's output is not
 *   a pure write — spell it as one statement yourself (`… RETURNING` feeding
 *   the next arm), or keep the transaction.
 * - **No row is modified by two arms**, and no key is deleted by one arm and
 *   re-inserted by another (the insert's uniqueness check still sees the old
 *   row): fold them into one arm (an upsert) instead.
 * - **All arms share one statement's 65 535 bind parameters.** A large batch
 *   is several calls, each atomic on its own.
 *
 * Every arm must be an INSERT, UPDATE or DELETE, and the group must fit the
 * parameter budget: both are checked before the round trip, and throw. One
 * write runs as itself; none is no round trip at all.
 */
export async function writeAtomically(
  exec: DbExecutor,
  writes: readonly AtomicWrite[],
): Promise<void> {
  // `.getSQL()`, never the builder itself: drizzle parenthesises an embedded
  // builder, and a parenthesised CTE body is a syntax error.
  const arms = writes.flatMap((w) => (w === null ? [] : [w.getSQL()]));
  const [only] = arms;
  if (only === undefined) return;
  if (arms.length === 1) {
    await exec.execute(only);
    return;
  }
  assertWriteArms(arms);
  await exec.execute(atomicStatement(arms));
}

/** Postgres's cap on one statement's bind parameters (an Int16 count). */
export const MAX_BIND_PARAMETERS = 65_535;

const dialect = new PgDialect();
const WRITE_ARM = /^\s*(insert|update|delete)\b/i;

/**
 * Fail before the round trip on the two mistakes the CTE would hide: an arm
 * that is not a write (a SELECT arm nobody reads is never even evaluated, so it
 * would silently do nothing) and a group past one statement's bind parameters
 * (pg reports that as a confusing protocol mismatch, not as what it is).
 * Rendering the arms here costs microseconds against a round trip.
 */
function assertWriteArms(arms: readonly SQL[]): void {
  let params = 0;
  for (const [i, arm] of arms.entries()) {
    const query = dialect.sqlToQuery(arm);
    if (!WRITE_ARM.test(query.sql)) {
      throw new Error(
        `writeAtomically: arm ${i} is not an INSERT, UPDATE or DELETE: ${query.sql.slice(0, 120)}`,
      );
    }
    params += query.params.length;
  }
  if (params > MAX_BIND_PARAMETERS) {
    throw new Error(
      `writeAtomically: ${arms.length} writes bind ${params} parameters, past one statement's ${MAX_BIND_PARAMETERS} — split the group into calls that are each atomic on their own`,
    );
  }
}

/** `WITH w0 AS (a0), w1 AS (a1), … SELECT 1` — every arm runs, none is read. */
export function atomicStatement(arms: readonly SQL[]): SQL {
  const ctes = sql.join(
    arms.map((arm, i) => sql`${sql.raw(`w${i}`)} AS (${arm})`),
    sql`, `,
  );
  return sql`WITH ${ctes} SELECT 1`;
}
