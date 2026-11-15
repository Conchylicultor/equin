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
  | { readonly fn: "fallback"; readonly value: FallbackValue }
  | { readonly fn: "wire-transparent" };

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

/** A {@link wireTransparent} step's output serialized to other JSON than its input. */
export class WireTransparencyError extends Error {}

/**
 * A transform (or preprocess) whose output SERIALIZES to its input: a value
 * object over its wire form (`RankSchema`: a raw key in, a `Rank` whose
 * `toJSON` is that key out). The body fixed here runs `fn`, then checks
 * `JSON.stringify(output) === JSON.stringify(input)` and throws a
 * {@link WireTransparencyError} otherwise — so whatever `fn` does, what any
 * JSON reader of the output sees (a wire frame, a row hash, a stored value)
 * is the input, and `describeSchema` describes the step as
 * `{ kind: "transform", fn: "wire-transparent" }` rather than blinding it.
 * Its body can change freely without moving any description that relies on
 * it: a change that breaks transparency fails every parse, loudly.
 */
export function wireTransparent<I, O>(fn: (input: I) => O): (input: I) => O {
  const step = (input: I): O => {
    const output = fn(input);
    if (JSON.stringify(output) !== JSON.stringify(input)) {
      throw new WireTransparencyError(
        `wireTransparent: ${JSON.stringify(input)} became ${JSON.stringify(output)} — the step must serialize back to its input.`,
      );
    }
    return output;
  };
  described.set(step, { fn: "wire-transparent" });
  return step;
}
