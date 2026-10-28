/**
 * The two decoders that drizzle does not ship, and why each has to exist.
 *
 * In drizzle every *column* carries a decoder (`mapFromDriverValue`), so its
 * declared type and its runtime mapping come from the same object and cannot
 * disagree. A raw ``sql`…` `` projection is the one field kind whose decoder is
 * `noopDecoder` — the identity function — which is what makes ``sql<T>`…` `` a
 * pure assertion: whatever the driver produced is handed to typed code as if it
 * matched.
 *
 * `.mapWith(decoder)` is drizzle's own answer, and it is the right one:
 * `mapWith<TDecoder>(d): SQL<GetDecoderResult<TDecoder>>` **computes** the type
 * from the decoder, so the type cannot be chosen independently of the runtime
 * behaviour. What is missing from `.mapWith` alone is exactly two things:
 *
 *  - **nullability.** `GetDecoderResult<Column>` is the column's data type with
 *    no `| null`, and drizzle short-circuits `null` before ever calling a
 *    decoder (`utils.js` `mapResultRow`: `rawValue === null ? null : decode`).
 *    So a column decoder alone cannot spell `SQL<Date | null>` — {@link nullable}
 *    does, and its job is mostly type-level.
 *  - **checking a composite shape.** `Boolean` / `Number` / `String` coerce, and
 *    there is no coercion for "an array of strings" or "one of these six
 *    literals" — which is precisely the incident class: `array_agg` over a
 *    `name` column produces `name[]` (OID 1003), for which pg has no decoder, so
 *    the raw Postgres literal *string* arrives where `string[]` was declared.
 *    {@link parsed} is what catches that.
 *
 * A decoder can therefore make the declared **shape** true by construction, but
 * it can never police nullability — that stays the author's claim, spelled with
 * {@link nullable}.
 */
import {
  Column,
  is,
  type DriverValueDecoder,
  type GetDecoderResult,
} from "drizzle-orm";
import type { ZodError, z } from "zod";
import {
  SqlProjectionError,
  runtimeTypeOf,
  type SqlProjectionFailure,
} from "./errors";

/** A drizzle projection decoder: the driver's value in, the declared type out. */
export type SqlDecoder<T> = (value: unknown) => T;

/**
 * Exactly what `SQL.mapWith()` accepts — written as drizzle's own constraint
 * rather than an approximation of it, so {@link nullable} can never drift from
 * the thing it wraps.
 */
// The `any`s are copied verbatim from drizzle's own `mapWith` constraint
// (sql/sql.d.ts). Narrowing them here would reject decoders `.mapWith` accepts,
// which is the opposite of the point.
export type SqlDecoderLike =
  | DriverValueDecoder<any, any>
  | DriverValueDecoder<any, any>["mapFromDriverValue"];

/**
 * Any decoder `.mapWith()` accepts, as a plain function. A drizzle `Column`
 * decodes through a method, so keep `this` bound.
 */
export function toMapper(decoder: SqlDecoderLike): (value: unknown) => unknown {
  return typeof decoder === "function"
    ? (decoder as (value: unknown) => unknown)
    : (value) => decoder.mapFromDriverValue(value);
}

/** The decoders {@link nullable} made — the functions whose type admits NULL. */
const nullableDecoders = new WeakSet<SqlDecoderLike>();

/**
 * What a decoder IS, as data — so a reader that must tell two decoders apart
 * ACROSS PROCESSES (a persisted compile's definition) never keys on a
 * function's identity or source:
 *
 * - `column` — a drizzle column, decoding as that column does everywhere;
 * - `builtin` — one of the native coercions (`Number`, `String`, `Boolean`,
 *   `BigInt`), recognised by identity with the global;
 * - `parsed` — a {@link parsed} decoder: its schema and label;
 * - `nullable` — a {@link nullable} decoder: the decoder it wraps;
 * - `opaque` — any other function: nothing about it can be read as data.
 */
export type DecoderOrigin =
  | { kind: "column"; column: Column }
  | { kind: "builtin"; name: BuiltinDecoderName }
  | { kind: "parsed"; schema: z.ZodType<unknown>; label: string }
  | { kind: "nullable"; inner: SqlDecoderLike }
  | { kind: "opaque" };

type BuiltinDecoderName = "Number" | "String" | "Boolean" | "BigInt";

const BUILTIN_DECODERS: ReadonlyMap<unknown, BuiltinDecoderName> = new Map<
  unknown,
  BuiltinDecoderName
>([
  [Number, "Number"],
  [String, "String"],
  [Boolean, "Boolean"],
  [BigInt, "BigInt"],
]);

/** The origins {@link parsed} and {@link nullable} record for what they make. */
const decoderOrigins = new WeakMap<object, DecoderOrigin>();

/**
 * The {@link DecoderOrigin} of any decoder `.mapWith()` accepts — or of the
 * `{ mapFromDriverValue }` object `.mapWith(fn)` stores, which is unwrapped to
 * the function it holds.
 */
export function decoderOrigin(decoder: SqlDecoderLike): DecoderOrigin {
  if (is(decoder, Column)) return { kind: "column", column: decoder };
  if (typeof decoder !== "function") {
    // Read as a property, not a method: only its identity is looked at.
    const held = (decoder as { mapFromDriverValue: unknown })
      .mapFromDriverValue;
    return typeof held === "function"
      ? decoderOrigin(held as SqlDecoder<unknown>)
      : { kind: "opaque" };
  }
  const recorded = decoderOrigins.get(decoder);
  if (recorded !== undefined) return recorded;
  const builtin = BUILTIN_DECODERS.get(decoder);
  return builtin === undefined
    ? { kind: "opaque" }
    : { kind: "builtin", name: builtin };
}

/**
 * `decoder`, and `NULL` is a legitimate value for this projection.
 *
 * ```ts
 * finishedAt: sql`CASE … END`.mapWith(nullable(pushes.createdAt)).as("finished_at")
 * //          ^? SQL<Date | null>, decoded by the same mapper as pushes.createdAt
 * ```
 *
 * The runtime null-guard is belt-and-braces: drizzle never calls a decoder with
 * `null`, so under `.mapWith` this only ever runs on real values. It is kept so
 * the returned function is correct on its own, wherever it is called from.
 */
export function nullable<D extends SqlDecoderLike>(
  decoder: D,
): SqlDecoder<GetDecoderResult<D> | null> {
  const map = toMapper(decoder);
  const out: SqlDecoder<GetDecoderResult<D> | null> = (value) =>
    value === null || value === undefined
      ? null
      : (map(value) as GetDecoderResult<D>);
  nullableDecoders.add(out);
  decoderOrigins.set(out, { kind: "nullable", inner: decoder });
  return out;
}

/**
 * Whether a decoder's result type admits NULL — the runtime twin of its
 * type: a column that is not NOT NULL (`GetColumnData` adds `| null`), or a
 * {@link nullable} decoder. Every other decoder's type is non-null, so a
 * reader that skips it on NULL (drizzle's own mapping) must refuse the NULL
 * rather than hand it on as the non-null type.
 */
export function admitsNull(decoder: SqlDecoderLike): boolean {
  if (is(decoder, Column)) return !decoder.notNull;
  return nullableDecoders.has(decoder);
}

/**
 * A zod schema as a projection decoder: the declared type is `z.infer` of the
 * schema, and a value that disagrees throws {@link SqlProjectionError}.
 *
 * ```ts
 * status: sql`CASE … END`.mapWith(parsed(TaskStatusSchema, "tasks_v.status")).as("status")
 * //      ^? SQL<TaskStatus>
 * ```
 *
 * `label` is **required**, not decorative. The throw happens inside drizzle's
 * result mapping, several frames from the file that declared the projection, so
 * the stack cannot say which projection failed — only the label can.
 *
 * `T extends {}` rejects a nullable schema (`parsed(z.string().nullable(), …)`
 * is a tsc error) so nullability has exactly one spelling:
 * `nullable(parsed(schema, label))`.
 */
export function parsed<T extends NonNullable<unknown>>(
  schema: z.ZodType<T>,
  label: string,
): SqlDecoder<T> {
  const decode: SqlDecoder<T> = (value) => {
    const outcome = schema.safeParse(value);
    if (outcome.success) return outcome.data;
    throw sqlProjectionError(outcome.error, value, label);
  };
  decoderOrigins.set(decode, {
    kind: "parsed",
    schema: schema as z.ZodType<unknown>,
    label,
  });
  return decode;
}

function sqlProjectionError(
  error: ZodError,
  received: unknown,
  label: string,
): SqlProjectionError {
  // The first issue is the one to explain — it is where the author starts
  // reading. An empty issue list is not something zod produces, but the type
  // allows it, and a silent `undefined` here would be exactly the class of miss
  // this plugin exists to remove.
  const issue = error.issues[0];
  if (issue === undefined) throw error;

  const failure: SqlProjectionFailure = {
    label,
    // A JSON value has no symbol key; a symbol is named, never dropped.
    path: issue.path.map((k) => (typeof k === "symbol" ? String(k) : k)),
    expected: issue.code === "invalid_type" ? issue.expected : undefined,
    receivedType: runtimeTypeOf(received),
    received,
    issueMessage: issue.message,
  };
  return new SqlProjectionError(failure, error);
}
