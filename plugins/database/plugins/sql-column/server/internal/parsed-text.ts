/**
 * A `text` column whose narrower type comes from a decoder that actually runs.
 *
 * `text("status").$type<"a" | "b">()` is a pure assertion: `$type` changes **no**
 * runtime behaviour at all, so whatever the row holds is handed to typed code as
 * if it matched. It is `sql-rows`' `pool.query<Row>(sql)` hole and
 * `sql-projection`'s ``sql<T>`…` `` hole a layer lower — on the column itself —
 * and unlike the projection case there is no `.mapWith` to reach for, because a
 * column IS drizzle's decoder rather than something you attach one to.
 *
 * `customType` is the answer, and it is drizzle's own: the column's select type
 * is computed from the `data` type parameter, and {@link parsedText} binds that
 * parameter to `z.infer` of the schema it is handed. `T` is inferred from the
 * schema argument and from nowhere else, so the declared type cannot be chosen
 * independently of what runs.
 *
 * ## Four measured facts this rests on (drizzle-orm 0.36.4)
 *
 *  1. `PgCustomColumn.mapFromDriverValue(v)` is `this.mapFrom(v)` and
 *     `mapToDriverValue(v)` is `this.mapTo(v)` (`pg-core/columns/custom.js:33-38`).
 *     Those are **method calls**, so a non-arrow `fromDriver`/`toDriver` receives
 *     the built column as `this` — which is the only way an error thrown from
 *     inside drizzle's result mapping can name `table.column`.
 *  2. `getSQLType()` returns `dataType()` verbatim, drizzle-kit reads
 *     `column.getSQLType()` into the snapshot with no branch on the column class,
 *     and `"text"` is on its native-type whitelist. So this column is
 *     **byte-identical in DDL and snapshot** to `text("x")`: swapping one for the
 *     other generates no migration.
 *  3. **A decoder never sees `null`**, in either direction: reads guard
 *     `rawValue === null ? null : decode` (`utils.js:28`) and writes guard
 *     `chunk.value === null ? null : encode` (`sql/sql.js:131`). So the decoder
 *     states the column's *shape*; nullability stays drizzle's own, derived from
 *     whether the builder chain calls `.notNull()` — exactly as for `text()`.
 *  4. The encoder runs on INSERT `.values()`, UPDATE `.set()`, and every bound
 *     comparison param (`eq` / `inArray` / …). One schema therefore covers both
 *     directions, which is the whole claim: *this column's values are exactly
 *     what this schema produces.*
 *
 * ## Strict or tolerant is the author's choice
 *
 * `parsedText` takes any `z.ZodType<T>`, so the two policies this repo already
 * has are both spellable with no new vocabulary:
 *
 * ```ts
 * // closed set, private to one engine — an outsider is a bug, so throw
 * status: parsedText("status", ExecutionStatusSchema).notNull().default("pending"),
 *
 * // evolving set — ids get renamed and old rows outlive them, so normalize + report
 * autoStartModel: parsedText("auto_start_model", StoredModelSchema).notNull(),
 * ```
 *
 * `StoredModelSchema` is `tolerantEnum(...)` from `primitives/live-state/core`.
 * Putting it on the **column** rather than only on the live-state resource is
 * what makes it reach the server-side readers too — the wire guard protects the
 * browser and nothing else.
 */
import type { z } from "zod";
import { customType } from "drizzle-orm/pg-core";
import { recordColumnSchema } from "./column-schema";
import { crossBoundary } from "./cross-boundary";

/**
 * A `text` column whose values are exactly what `schema` produces.
 *
 * ```ts
 * export const _jobWaits = pgTable("job_waits", {
 *   status: parsedText("status", JobWaitStatusSchema).notNull(),
 *   //      ^? select type = z.infer<typeof JobWaitStatusSchema>
 * });
 * ```
 *
 * `T extends string` is what makes this a *text* column's decoder: a schema
 * producing a `Date`, a number or an object has no spelling here. It also means
 * a nullable schema is rejected — nullability is declared by leaving `.notNull()`
 * off the builder, not by widening the decoder (fact 3 above).
 */
export function parsedText<T extends string>(
  name: string,
  schema: z.ZodType<T>,
) {
  const codec = customType<{ data: T; driverData: string }>({
    dataType() {
      return "text";
    },
    // Deliberately `function`, not an arrow: drizzle calls these as methods on
    // the built column (fact 1), which is where the qualified label comes from.
    fromDriver(this: unknown, value: string): T {
      return crossBoundary(this, name, schema, value, "read");
    },
    toDriver(this: unknown, value: T): string {
      return crossBoundary(this, name, schema, value, "write");
    },
  });
  return recordColumnSchema(codec(name), schema);
}
