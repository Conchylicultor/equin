import { z } from "zod";

// A list's BOUND, declared where the list is — in its zod schema. Every list a
// live read hands the browser is exactly one of: paged (a live declaration's
// own form, not a schema's), capped (a checked `max`) or whole (loaded entire,
// with a written reason). The two schema forms are built here.
//
// The tag rides the schema's own `_def` (`_def.listBound`), never a side
// WeakMap: zod 3 clones `_def` on `.max()`, `.min()`, `.describe()`,
// `.nonempty()` (a new instance over `{ ...this._def, … }`) and wraps on
// `.optional()` / `.nullable()`, so the tag survives every one of them — and a
// schema built in one copy of this module is read by another (web artifacts
// may each bundle their own).

/**
 * The tag a marker leaves on its schema's `_def`: a checked cap, or a reason
 * the list is loaded whole. An array's cap is zod's own `.max(n)` — read off
 * `_def.maxLength`, never tagged — so only a record carries `{ max }`.
 */
export type ListBoundTag =
  { readonly max: number } | { readonly reason: string };

/** The `_def` field the tag is stored under. */
export const LIST_BOUND_DEF_KEY = "listBound";

/**
 * A list of at most `max` items: `z.array(item).max(max)` — a native `.max(n)`
 * is a cap too, and the walk reads it the same way. The parse enforces it on
 * every end that parses the payload.
 */
export function cappedList<T extends z.ZodTypeAny>(
  item: T,
  opts: { max: number },
): z.ZodArray<T> {
  return z.array(item).max(checkMax("cappedList", opts.max));
}

/** A list loaded whole, with the reason that is honest (`"one config file's keys"`). */
export function wholeList<T extends z.ZodTypeAny>(
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
  Items extends z.ZodTupleItems,
  Rest extends z.ZodTypeAny,
>(items: Items, rest: Rest, opts: { reason: string }): z.ZodTuple<Items, Rest> {
  return tagged(z.tuple(items).rest(rest), {
    reason: checkReason("wholeTuple", opts.reason),
  });
}

/**
 * A string-keyed record of at most `max` entries. zod has no native record
 * cap, so the record is tagged `{ max }` and refined (the parse refuses one
 * entry more).
 */
export function cappedRecord<V extends z.ZodTypeAny>(
  value: V,
  opts: { max: number },
): z.ZodEffects<z.ZodRecord<z.ZodString, V>> {
  const max = checkMax("cappedRecord", opts.max);
  return tagged(z.record(z.string(), value), { max }).superRefine((r, ctx) => {
    const n = Object.keys(r).length;
    if (n > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: max,
        inclusive: true,
        type: "array",
        message: `a record capped at ${max} entries holds ${n}`,
      });
    }
  });
}

/** A string-keyed record loaded whole, with the reason that is honest. */
export function wholeRecord<V extends z.ZodTypeAny>(
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
export function wholeKeyedRecord<K extends z.KeySchema, V extends z.ZodTypeAny>(
  key: K,
  value: V,
  opts: { reason: string },
): z.ZodRecord<K, V> {
  return tagged(z.record(key, value), {
    reason: checkReason("wholeKeyedRecord", opts.reason),
  });
}

/** `schema` with `tag` on its `_def` (a fresh schema the caller just built). */
function tagged<S extends z.ZodTypeAny>(schema: S, tag: ListBoundTag): S {
  (schema._def as Record<string, unknown>)[LIST_BOUND_DEF_KEY] = tag;
  return schema;
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
