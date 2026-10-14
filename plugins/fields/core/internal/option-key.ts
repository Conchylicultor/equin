// An option set labels EVERY value of a field's domain — not only strings: a
// probe verdict's `true` / `false` (Online / Offline), a missing side row's
// `null` (By hand). Options are keyed by each value's CANONICAL SPELLING: a
// string is itself, a boolean or a number its `String`, `null` the key
// `"null"`. One spelling, so a declaration (`options: { true, false, null }`),
// a live option read (`{ value: "null", label: "By hand" }`), a chip lookup and
// a filter operand all name a value the same way — and the filter lowering
// reads the spelling back to the value it names (`"null"` is "no value").

/** A field value an option can label. */
export type OptionValue = string | number | boolean | null;

/** The canonical spelling of `V`'s values — what an option set over `V` is keyed by. */
export type OptionKey<V> = V extends string
  ? V
  : V extends boolean | number
    ? `${V}`
    : V extends null
      ? typeof NULL_OPTION_KEY
      : never;

/** The key of the option labelling `null` (no value). */
export const NULL_OPTION_KEY = "null";

/** The canonical spelling of one value (see the file comment). */
export function optionKey(value: OptionValue): string {
  return value === null ? NULL_OPTION_KEY : String(value);
}
