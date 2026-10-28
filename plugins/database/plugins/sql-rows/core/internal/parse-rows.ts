import type { ZodError, z } from "zod";
import type { SqlResult } from "./types";
import { SqlRowError, runtimeTypeOf, type SqlRowFailure } from "./errors";

/**
 * Walk a zod issue path into the raw row to recover the value that actually
 * arrived.
 *
 * Stops as soon as the path leaves object/array territory and returns what it
 * found there — which is exactly the interesting case. For the incident this
 * plugin exists for, the path is `["tables"]` and the value is the raw literal
 * string; for a nested `["meta", "a"]` where `meta` itself is a string, the
 * string is what the author needs to see, not `undefined`.
 */
function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return current;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/**
 * Parse every row of a result against `row`, or throw {@link SqlRowError}.
 *
 * Every row, not just the first: nullability and jsonb content vary row to row,
 * so a first-row spot check is the same assertion this plugin exists to remove.
 *
 * A non-`ZodError` thrown from inside a schema (a `.transform()` that throws,
 * say) propagates untouched — `safeParse` only ever reports validation failures,
 * and this function adds no catch of its own.
 */
export function parseRows<T>(
  result: SqlResult,
  row: z.ZodType<T>,
  ctx: { sql?: string },
): T[] {
  const parsed: T[] = [];
  for (let index = 0; index < result.rows.length; index++) {
    const raw = result.rows[index];
    const outcome = row.safeParse(raw);
    if (outcome.success) {
      parsed.push(outcome.data);
      continue;
    }
    throw sqlRowError(outcome.error, raw, index, result, ctx.sql);
  }
  return parsed;
}

function sqlRowError(
  error: ZodError,
  raw: unknown,
  rowIndex: number,
  result: SqlResult,
  sql: string | undefined,
): SqlRowError {
  // The first issue is the one to explain. A row with a wrong column usually
  // reports one issue, and when it reports several the first is where the
  // author starts reading anyway.
  const issue = error.issues[0];
  if (issue === undefined) {
    // zod does not produce an empty issue list, but the type allows it and a
    // silent `undefined` here would be exactly the class of miss this file is
    // about.
    throw error;
  }

  const head = issue.path[0];
  const column = typeof head === "string" ? head : undefined;
  const received = valueAtPath(raw, issue.path);

  const failure: SqlRowFailure = {
    rowIndex,
    column,
    dataTypeID:
      column === undefined
        ? undefined
        : result.fields?.find((field) => field.name === column)?.dataTypeID,
    expected: issue.code === "invalid_type" ? issue.expected : undefined,
    receivedType: runtimeTypeOf(received),
    received,
    issueMessage: issue.message,
    sql,
  };

  return new SqlRowError(failure, error);
}
