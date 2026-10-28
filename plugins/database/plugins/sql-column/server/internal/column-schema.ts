/**
 * The zod schema a `parsedText` / `parsedJson` column decodes through, as
 * DATA a reader can ask a built column for.
 *
 * A column's decoder is the schema it was handed — so anything that must tell
 * two decoders apart (query-resource's persisted-compile definition, A18 of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md) has to read
 * the schema, not the column's name or SQL type: a change to the schema moves
 * what a read of the column produces while leaving both untouched.
 *
 * Recorded the way `withWire` records its codec (`./wire.ts`): the builder's
 * `build(table)` is shadowed on the ONE builder the factory returns, so the
 * schema is attached to the column it builds whatever the builder chain did in
 * between (`.notNull()`, `.default()` return the same builder).
 */
import type { z } from "zod";
import type { PgColumn, PgColumnBuilderBase } from "drizzle-orm/pg-core";

const schemas = new WeakMap<PgColumn, z.ZodType<unknown>>();

/** Record `schema` as the decoder of the column `builder` builds. Returns `builder`. */
export function recordColumnSchema<B extends PgColumnBuilderBase>(
  builder: B,
  schema: z.ZodType<unknown>,
): B {
  const target = builder as unknown as { build: (table: unknown) => PgColumn };
  const build = target.build.bind(builder);
  target.build = (table) => {
    const column = build(table);
    schemas.set(column, schema);
    return column;
  };
  return builder;
}

/**
 * The schema a built `parsedText` / `parsedJson` column decodes through, or
 * `undefined` for any other column — whose decoder is drizzle's own for its
 * SQL type, the common case, not a failure.
 */
export function columnSchema(column: PgColumn): z.ZodType<unknown> | undefined {
  return schemas.get(column);
}
