/**
 * `decodedRow` — a raw statement's row, decoded the way drizzle's builder
 * decodes a selected row.
 *
 * A builder query (`db.select({ … })`) decodes each field through its column
 * or its `.mapWith()` decoder (drizzle's `mapResultRow`). A raw statement
 * (`db.execute(sql`…`)`) — a union whose outer order keys are expressions, a
 * recursive CTE: shapes the builder cannot render — hands back the driver's
 * values UNDECODED: a `timestamptz` as its string, a `numeric` as text. The
 * projection that built the statement already knows each field's decoder, so
 * the row is decoded from the same declaration:
 *
 * ```ts
 * const rows = await executeRows(db, {
 *   query,                                            // SELECT … AS "id", … AS "createdAt"
 *   row: decodedRow({ id: tasks.id, createdAt: tasks.createdAt, label: String }),
 *   label: "runs.union",
 * });
 * //    ^? { id: string; createdAt: Date; label: string }[]
 * ```
 *
 * - **The exact key set** (A31 of
 *   research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md): a row
 *   missing a projected field, or carrying one the projection does not name,
 *   fails the parse — a statement and its projection that drifted apart (a
 *   renamed alias, a column a `SELECT *` grew) can never be read as a row with
 *   a silently absent or stray field.
 * - **A NULL skips the decoder**, as in drizzle's own mapping — but only where
 *   the field's type admits it: a column that is not NOT NULL (its type adds
 *   `| null`, as drizzle's select type does) or a `nullable(…)` decoder. Any
 *   other field (a NOT NULL column, `Number`, `parsed(…)`) types as non-null,
 *   so a NULL there is a zod issue on the field — never a `null` typed as a
 *   `Date`. (A union arm's typed-NULL column is how one gets there: declare
 *   the field `nullable(…)`.)
 *
 * A decoder that throws (`parsed`'s `SqlProjectionError`) propagates as is —
 * it names the projection; a key-set mismatch is a zod issue on the field,
 * which `sql-rows` reports with the result's column OID.
 */
import type { Column, GetColumnData, GetDecoderResult } from "drizzle-orm";
import { z } from "zod";
import { admitsNull, toMapper, type SqlDecoderLike } from "./decoders";

/** The row a projection decodes to: a column's data (`| null` unless NOT NULL), else the decoder's result. */
export type DecodedRow<M extends Readonly<Record<string, SqlDecoderLike>>> = {
  -readonly [K in keyof M]: M[K] extends Column
    ? GetColumnData<M[K]>
    : GetDecoderResult<M[K]>;
};

/**
 * The parser of a raw statement's rows over `projection` (field → its decoder:
 * a column, a drizzle decoder, or a function such as `Number` / `parsed(…)`) —
 * see the header. Pass it as `row` to sql-rows' `executeRows`.
 */
export function decodedRow<
  const M extends Readonly<Record<string, SqlDecoderLike>>,
>(projection: M): z.ZodType<DecodedRow<M>> {
  const mappers = Object.entries(projection).map(
    ([key, decoder]) => [key, toMapper(decoder), admitsNull(decoder)] as const,
  );
  const keys = new Set(mappers.map(([key]) => key));
  return z.unknown().transform((raw, ctx): DecodedRow<M> => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      ctx.addIssue({
        code: "custom",
        message: "a row is an object of the projection's fields",
      });
      return z.NEVER;
    }
    const row = raw as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (!keys.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `column "${key}" is not in the projection — a raw read's row is exactly its projection's fields (A31)`,
        });
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, map, nullOk] of mappers) {
      if (!(key in row)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `the row has no column "${key}", which the projection names — a raw read's row is exactly its projection's fields (A31)`,
        });
        continue;
      }
      const value = row[key];
      if (value === null && !nullOk) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `column "${key}" is NULL, but its decoder's type is non-null (a NOT NULL column, or a decoder not wrapped in nullable(…))`,
        });
        continue;
      }
      out[key] = value === null ? null : map(value);
    }
    return out as DecodedRow<M>;
  });
}
