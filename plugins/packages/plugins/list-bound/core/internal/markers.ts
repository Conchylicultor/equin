import { defineSchemaTag } from "@plugins/packages/plugins/zod-introspect/core";
import { z } from "zod";

// A list's BOUND, declared where the list is — in its zod schema. Every list a
// live read hands the browser is exactly one of: paged (a live declaration's
// own form, not a schema's), capped (a checked `max`) or whole (loaded entire,
// with a written reason). The two schema forms are built here.
//
// The tag rides the schema object itself (zod-introspect's defineSchemaTag,
// a namespaced key on the schema's def), never a side WeakMap or a zod
// registry: a marker stamps it on a CLONE of the schema it just built, and
// zod carries the def over on every clone it makes (`.max()`, `.min()`,
// `.describe()`, `.nonempty()`, `.refine()`, `.brand()`), while a wrapper
// (`.optional()`, `.nullable()`, `.default()`, …) holds the tagged schema as
// its inner one, where the walk reads it. The key is a plain string, so a
// schema built in one copy of this module (or of zod) is read by another —
// web artifacts may each bundle their own.

/**
 * The tag a marker leaves on its schema: a checked cap, or a reason the list
 * is loaded whole. An array's cap is zod's own `.max(n)` — read off the
 * schema's size checks, never tagged — so only a record carries `{ max }`.
 */
export type ListBoundTag =
  { readonly max: number } | { readonly reason: string };

/**
 * The tag itself. Its value is read back as `unknown` and checked by the
 * walk: a hand-set tag (a test's malformed one) must fail loudly, not pass.
 */
export const LIST_BOUND_TAG = defineSchemaTag<unknown>("list-bound");

/**
 * A list of at most `max` items: `z.array(item).max(max)` — a native `.max(n)`
 * is a cap too, and the walk reads it the same way. The parse enforces it on
 * every end that parses the payload.
 */
export function cappedList<T extends z.ZodType>(
  item: T,
  opts: { max: number },
): z.ZodArray<T> {
  return z.array(item).max(checkMax("cappedList", opts.max));
}

/** A list loaded whole, with the reason that is honest (`"one config file's keys"`). */
export function wholeList<T extends z.ZodType>(
  item: T,
  opts: { reason: string },
): z.ZodArray<T> {
  return tagged(z.array(item), {
    reason: checkReason("wholeList", opts.reason),
  });
}

/**
 * A tuple whose `.rest()` items are loaded whole: `z.tuple(items).rest(rest)`,
 * tagged — the at-least-N list (`[string, string, ...string[]]`) a plain
 * {@link wholeList} cannot type.
 */
export function wholeTuple<
  Items extends readonly [z.core.SomeType, ...z.core.SomeType[]],
  Rest extends z.ZodType,
>(items: Items, rest: Rest, opts: { reason: string }): z.ZodTuple<Items, Rest> {
  return tagged(z.tuple(items, rest), {
    reason: checkReason("wholeTuple", opts.reason),
  });
}

/**
 * A string-keyed record of at most `max` entries. zod has no native record
 * cap, so the record is tagged `{ max }` and refined (the parse refuses one
 * entry more).
 */
export function cappedRecord<V extends z.ZodType>(
  value: V,
  opts: { max: number },
): z.ZodRecord<z.ZodString, V> {
  const max = checkMax("cappedRecord", opts.max);
  return tagged(z.record(z.string(), value), { max }).superRefine((r, ctx) => {
    const n = Object.keys(r).length;
    if (n > max) {
      ctx.addIssue({
        code: "too_big",
        maximum: max,
        inclusive: true,
        origin: "record",
        message: `a record capped at ${max} entries holds ${n}`,
      });
    }
  });
}

/** A string-keyed record loaded whole, with the reason that is honest. */
export function wholeRecord<V extends z.ZodType>(
  value: V,
  opts: { reason: string },
): z.ZodRecord<z.ZodString, V> {
  return tagged(z.record(z.string(), value), {
    reason: checkReason("wholeRecord", opts.reason),
  });
}

/**
 * {@link wholeRecord} over a key schema of its own (a refined string, say):
 * `z.record(key, value)`, tagged.
 */
export function wholeKeyedRecord<
  K extends z.core.$ZodRecordKey,
  V extends z.ZodType,
>(key: K, value: V, opts: { reason: string }): z.ZodRecord<K, V> {
  return tagged(z.record(key, value), {
    reason: checkReason("wholeKeyedRecord", opts.reason),
  });
}

/** A tagged clone of `schema` (a fresh schema the caller just built), never the source mutated. */
function tagged<S extends z.ZodType>(schema: S, tag: ListBoundTag): S {
  return LIST_BOUND_TAG.set(schema, tag);
}

/** A cap is a positive safe integer — a 0 or fractional cap is a typo, not a bound. */
export function checkMax(where: string, max: unknown): number {
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) {
    throw new Error(
      `${where}: max ${String(max)} is not a positive integer — a cap is how ` +
        `many items the list may hold.`,
    );
  }
  return max;
}

/** A reason is a non-blank string — it is what a reader of the declaration is told. */
export function checkReason(where: string, reason: unknown): string {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error(
      `${where}: an empty reason — say why loading the whole list is honest ` +
        `(how big it gets, and what bounds it).`,
    );
  }
  return reason;
}
