import type { z } from "zod";
import { parseRows } from "./parse-rows";
import type { ParsedResult, SqlExecutable, SqlQueryable } from "./types";

/**
 * The front doors. Each one reads rows AND parses them in the same call, so
 * there is no spelling of any door that hands back an unparsed row: `row` is
 * required, and a `z.ZodType<T>` cannot be produced by writing a type argument.
 *
 * `queryResult` / `executeResult` are the widest pair — they surface `fields`
 * and `rowCount` alongside the parsed rows — and the rows-only doors are thin
 * wrappers over them, so exactly one parse runs no matter which door is used.
 */

const SQL_LABEL_MAX = 200;

function label(sql: string | undefined): string {
  if (sql === undefined) return "";
  const flat = sql.replace(/\s+/g, " ").trim();
  const shown =
    flat.length <= SQL_LABEL_MAX ? flat : `${flat.slice(0, SQL_LABEL_MAX)}…`;
  return `\n  sql: ${shown}`;
}

/**
 * Exactly one row, or a throw. Never `T | undefined`: "no row" is a failure of
 * the caller's expectation, not an empty success it can absorb.
 */
function exactlyOne<T>(rows: T[], sql: string | undefined): T {
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one row from a SQL result, got ${rows.length}.${label(sql)}`,
    );
  }
  const [only] = rows;
  if (only === undefined) {
    // `noUncheckedIndexedAccess` cannot see the length check above. A row that
    // genuinely parsed to `undefined` is a schema bug, and staying quiet about
    // it is the exact class of miss this plugin exists to remove.
    throw new Error(
      `the single row of a SQL result parsed to \`undefined\`.${label(sql)}`,
    );
  }
  return only;
}

/**
 * Run `sql` on a pg-shaped client and hand back the parsed rows together with
 * the result's `fields` and `rowCount`.
 *
 * Reach for this when you need the column descriptors or the count — arbitrary
 * agent-authored SQL whose columns are not known ahead of time, say. It is not
 * an escape hatch: `rows` is parsed exactly as {@link queryRows} parses it.
 */
export async function queryResult<T>(
  client: SqlQueryable,
  opts: { sql: string; params?: unknown[]; row: z.ZodType<T> },
): Promise<ParsedResult<T>> {
  const result = await client.query(opts.sql, opts.params);
  return {
    rows: parseRows(result, opts.row, { sql: opts.sql }),
    rowCount: result.rowCount,
    fields: result.fields ?? [],
  };
}

/** Run `sql` on a pg-shaped client and parse every row. */
export async function queryRows<T>(
  client: SqlQueryable,
  opts: { sql: string; params?: unknown[]; row: z.ZodType<T> },
): Promise<T[]> {
  return (await queryResult(client, opts)).rows;
}

/** {@link queryRows}, for a query whose contract is exactly one row. */
export async function queryOne<T>(
  client: SqlQueryable,
  opts: { sql: string; params?: unknown[]; row: z.ZodType<T> },
): Promise<T> {
  return exactlyOne(await queryRows(client, opts), opts.sql);
}

/**
 * {@link queryResult} for a drizzle raw query (the `sql\`…\`` escape hatch):
 * the parsed rows plus `fields` and `rowCount`.
 *
 * There is no SQL string to quote here — drizzle holds the query object — so
 * `label` is what the diagnostic names the query by. Give it one whenever the
 * call site is not obvious from the stack.
 */
export async function executeResult<T, Q>(
  db: SqlExecutable<Q>,
  opts: { query: Q; row: z.ZodType<T>; label?: string },
): Promise<ParsedResult<T>> {
  const result = await db.execute(opts.query);
  return {
    rows: parseRows(result, opts.row, { sql: opts.label }),
    rowCount: result.rowCount,
    fields: result.fields ?? [],
  };
}

/** {@link executeResult}, for a caller that only wants the rows. */
export async function executeRows<T, Q>(
  db: SqlExecutable<Q>,
  opts: { query: Q; row: z.ZodType<T>; label?: string },
): Promise<T[]> {
  return (await executeResult(db, opts)).rows;
}

/** {@link executeRows}, for a query whose contract is exactly one row. */
export async function executeOne<T, Q>(
  db: SqlExecutable<Q>,
  opts: { query: Q; row: z.ZodType<T>; label?: string },
): Promise<T> {
  return exactlyOne(await executeRows(db, opts), opts.label);
}
