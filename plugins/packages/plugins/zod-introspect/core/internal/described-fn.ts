// Functions this plugin mints with a body fixed HERE and every parameter
// recorded as data, so `describeSchema` can describe a transform or a catch
// built from one by what it does — where any other function is opaque (its
// body could change with nothing a description reads moving). Keyed by the
// function object: a function minted by another module instance (a web
// artifact bundling its own copy) is simply not found, and reads opaque.
const described = new WeakMap<object, DescribedFn>();

/** What a minted function is, as data. */
export type DescribedFn =
  | { readonly fn: "retype" }
  | { readonly fn: "fallback"; readonly value: FallbackValue };

/** A value {@link fallbackTo} may answer: a JSON scalar, so no reader can mutate it. */
export type FallbackValue = string | number | boolean | null;

/**
 * An identity transform that only RETYPES its value (a brand cast):
 * `z.string().transform(retype<Id<"task">>)`. Its output is its input, so
 * `describeSchema` describes it as `{ kind: "transform", fn: "retype" }`
 * rather than blinding it.
 */
export function retype<T>(value: unknown): T {
  return value as T;
}
described.set(retype, { fn: "retype" });

/**
 * A catch function that answers `value` for every failed parse:
 * `schema.catch(fallbackTo("user", report))`. `onFailure` is told the failed
 * input first — for reporting only: its return is ignored, so it cannot pick
 * another answer (a throw fails the parse loudly, never a different value).
 * `describeSchema` describes the catch as `{ fallback: value }` — unless the
 * schema under it holds a refinement, whose verdict then picks the output.
 * Throws unless `value` is a JSON scalar (a finite number).
 */
export function fallbackTo<const T extends FallbackValue>(
  value: T,
  onFailure?: (input: unknown) => void,
): (ctx: { readonly input: unknown }) => T {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`fallbackTo: ${value} is not a JSON number.`);
  }
  const fn = (ctx: { readonly input: unknown }): T => {
    onFailure?.(ctx.input);
    return value;
  };
  described.set(fn, { fn: "fallback", value });
  return fn;
}

/** What `fn` is, when this module minted it; else undefined (opaque). */
export function describedFn(fn: unknown): DescribedFn | undefined {
  return typeof fn === "function" ? described.get(fn) : undefined;
}
