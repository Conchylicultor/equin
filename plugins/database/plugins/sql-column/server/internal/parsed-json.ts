/**
 * A `jsonb` column whose shape comes from a decoder that actually runs.
 *
 * `jsonb("x").$type<T>()` is the same pure assertion `text("x").$type<Union>()`
 * was — `$type` is `return this` and changes no runtime behaviour — with one
 * difference that reads like a defence and is not: Postgres genuinely decodes
 * the JSON, so the *value* really is a JS value. What was never checked is its
 * **shape**. A row written by older code, by hand, or by a worktree on different
 * code is handed to typed code as if it matched `T`.
 *
 * {@link parsedJson} is {@link parsedText}'s sibling and works the same way: the
 * column's select type is `z.infer` of the schema it is handed, `T` is inferred
 * from that argument and from nowhere else, and the same schema runs on every
 * read *and* every write. Everything `parsed-text.ts` documents about the
 * `this`-bound label, nullability, and the encoder's reach applies verbatim.
 *
 * ## It normalizes, it does not only check
 *
 * A `z.object` **strips keys it does not declare** — on read and on write alike.
 * So a row carrying an extra key comes back without it, and a write carrying one
 * stores it stripped. That is the point rather than a side effect: it is what
 * makes the declared type *true* instead of merely asserted. Where every key
 * matters, say so in the schema (`.passthrough()`, or a `z.record`, which keeps
 * every key by construction).
 *
 * ## What it costs — the schema is the dial
 *
 * A zod parse costs what the **schema's** depth costs, not what the payload's
 * size costs. `traces.snapshot` is the largest jsonb value in the repo (avg
 * 123 KB, max 536 KB), and its schema is eight scalars plus
 * `events: z.record(z.string(), z.unknown())` — the engine deliberately never names a key.
 * Decoding one ~96 KB snapshot: `JSON.parse` (which pg already pays) 561 µs, the
 * real schema **1.7 µs**, a deep schema fully describing the same bytes 481 µs.
 *
 * So a schema that declines to describe a payload declines to pay for it, and
 * the opt-in dial is the schema itself. There is deliberately no second knob:
 * one that could disagree with the schema would be a knob for declaring a type
 * you do not check, which is the hole this closes.
 *
 * ## Two differences from `parsedText`, both forced by jsonb
 *
 *  1. `toDriver` returns `JSON.stringify(parsed)` — what drizzle's own
 *     `PgJsonb.mapToDriverValue` does (`pg-core/columns/jsonb.js:21`).
 *  2. **No string-branch on read.** `pg` decodes jsonb itself
 *     (`pg-types.getTypeParser(3802)` is `JSON.parse`), so `fromDriver` receives
 *     an already-decoded JS value and never a string. Drizzle's own
 *     `PgJsonb.mapFromDriverValue` re-parses a string and, on failure, **returns
 *     the raw string** — an absorbed failure, and ambiguous besides, since a
 *     jsonb column may legitimately hold a JSON string. The driver value goes
 *     straight to the schema instead: if it is ever a string where an object was
 *     declared, the schema says so, loudly, naming the column.
 *
 * `getSQLType()` is `"jsonb"`, drizzle-kit reads it into the snapshot with no
 * branch on the column class, and `"jsonb"` is on its native-type whitelist — so
 * this column is byte-identical in DDL and snapshot to `jsonb("x")` and swapping
 * one for the other generates no migration.
 */
import type { z } from "zod";
import { customType } from "drizzle-orm/pg-core";
import { recordColumnSchema } from "./column-schema";
import { crossBoundary } from "./cross-boundary";

/**
 * A `jsonb` column whose values are exactly what `schema` produces.
 *
 * ```ts
 * export const _traces = pgTable("traces", {
 *   snapshot: parsedJson("snapshot", TraceSnapshotSchema).notNull(),
 *   //        ^? select type = z.infer<typeof TraceSnapshotSchema>,
 *   //           and that schema is what decodes it — and normalizes it
 * });
 * ```
 *
 * `T` is unconstrained, unlike `parsedText`'s `T extends string`: jsonb really
 * does hold any JSON value, so an array, an object, a discriminated union and a
 * bare number all have a spelling here. A nullable schema is still the wrong
 * thing to hand it — nullability is declared by leaving `.notNull()` off the
 * builder, and a decoder is never handed a `null` in either direction.
 */
export function parsedJson<T>(name: string, schema: z.ZodType<T>) {
  const codec = customType<{ data: T; driverData: unknown }>({
    dataType() {
      return "jsonb";
    },
    // Deliberately `function`, not an arrow: drizzle calls these as methods on
    // the built column, which is where the qualified `table.column` label in a
    // failure comes from (`parsed-text.ts`, fact 1).
    fromDriver(this: unknown, value: unknown): T {
      return crossBoundary(this, name, schema, value, "read");
    },
    toDriver(this: unknown, value: T): string {
      return JSON.stringify(crossBoundary(this, name, schema, value, "write"));
    },
  });
  return recordColumnSchema(codec(name), schema);
}
