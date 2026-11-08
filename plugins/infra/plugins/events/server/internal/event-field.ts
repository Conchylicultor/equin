/**
 * A field of a trigger's `with` that names a field of the event it is bound to,
 * rather than a constant: `with: { pageId: eventField("pageId") }`. Delivery
 * replaces it with that field of the emitted payload before the target's input
 * is parsed, so the target receives a plain `{ pageId }` — exactly what a direct
 * `.enqueue({ pageId })` gives it.
 *
 * Which is what lets a per-subject job be ONE job for every caller — the
 * trigger, a backfill, a button — keyed (and settled) on its input like any
 * other keyed job (`dedup: { key, settle }`). Before, a trigger's input was its
 * constant `with`, the subject arrived only in `event`, and a key — a function
 * of the input — could not see it: a trigger-bound per-subject job could only be
 * `"none"` (one run per emit) or `"singleton"` (drops other subjects).
 *
 * Data, not a closure: the reference is stored as is in the trigger row's
 * `job_with` JSON (`{ "$eventField": "pageId" }`), so it works the same for a
 * declared `Trigger` contribution and a runtime `trigger()` row.
 */
export interface EventField<K extends string> {
  readonly $eventField: K;
}

export function eventField<K extends string>(field: K): EventField<K> {
  return { $eventField: field };
}

/** The fields of event payload `P` whose value fits an input field of type `V`. */
type FieldsFitting<P, V> = Extract<
  { [K in keyof P]: P[K] extends V ? K : never }[keyof P],
  string
>;

/**
 * A trigger's `with` for target input `I` and event payload `P`: each input
 * field is its value, or an {@link eventField} naming a payload field whose
 * type fits it.
 */
export type TriggerWith<I, P> = {
  [F in keyof I]: I[F] | EventField<FieldsFitting<P, I[F]>>;
};

function isEventField(v: unknown): v is EventField<string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return (
    keys.length === 1 &&
    keys[0] === "$eventField" &&
    typeof (v as { $eventField: unknown }).$eventField === "string"
  );
}

/** A stored `with` resolved against one emitted payload — or the event fields
 *  it names that the payload does not carry (contract drift). */
export type ResolvedWith =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; missing: string[] };

/** Replace every {@link eventField} of a stored `with` by the payload's field. */
export function resolveEventFields(
  jobWith: Record<string, unknown>,
  payload: Record<string, unknown>,
): ResolvedWith {
  const input: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [field, value] of Object.entries(jobWith)) {
    if (!isEventField(value)) {
      input[field] = value;
      continue;
    }
    if (!Object.hasOwn(payload, value.$eventField)) {
      missing.push(value.$eventField);
      continue;
    }
    input[field] = payload[value.$eventField];
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, input };
}
