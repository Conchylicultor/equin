/**
 * The one statement of *parse a value crossing the driver boundary, or throw
 * naming the column*.
 *
 * Every decoded column type in this plugin — `parsedText`, `parsedJson` — makes
 * the same claim in the same two directions, so the claim is written once here
 * rather than once per column type. A second copy is how the two would drift:
 * the qualified label, the direction, and the "the first issue is the one to
 * explain" rule are all measured behaviour, and measured behaviour restated
 * twice is measured behaviour that disagrees with itself later.
 */
import { Column, getTableName, is } from "drizzle-orm";
import type { ZodError, z } from "zod";
import {
  runtimeTypeOf,
  SqlColumnError,
  type SqlColumnDirection,
  type SqlColumnFailure,
} from "./errors";

/**
 * Parse a value crossing the driver boundary, or throw naming the column.
 *
 * `self` is whatever drizzle called the decoder with as `this` — the built
 * column when the call is a method call, which is where the qualified
 * `table.column` label comes from (see {@link columnLabel}).
 */
export function crossBoundary<T>(
  self: unknown,
  declaredName: string,
  schema: z.ZodType<T>,
  value: unknown,
  direction: SqlColumnDirection,
): T {
  const outcome = schema.safeParse(value);
  if (outcome.success) return outcome.data;
  throw sqlColumnError(
    outcome.error,
    value,
    direction,
    columnLabel(self, declaredName),
  );
}

/**
 * `table.column` when drizzle called us as a method on the built column, the
 * bare declared name otherwise.
 *
 * The fallback exists so this **degrades, never lies**: a future drizzle that
 * detaches the call costs the message its table qualifier and nothing else.
 * Each decoder's test pins the qualified form through a real `pgTable`, so the
 * degrade is a failing test rather than a quietly worse error.
 */
function columnLabel(self: unknown, declaredName: string): string {
  if (!is(self, Column)) return declaredName;
  return `${getTableName(self.table)}.${self.name}`;
}

function sqlColumnError(
  error: ZodError,
  received: unknown,
  direction: SqlColumnDirection,
  label: string,
): SqlColumnError {
  // The first issue is the one to explain — it is where the author starts
  // reading. An empty issue list is not something zod produces, but the type
  // allows it, and a silent `undefined` here would be exactly the class of miss
  // this plugin exists to remove.
  const issue = error.issues[0];
  if (issue === undefined) throw error;

  const failure: SqlColumnFailure = {
    label,
    direction,
    receivedType: runtimeTypeOf(received),
    received,
    issueMessage: issue.message,
  };
  return new SqlColumnError(failure, error);
}
