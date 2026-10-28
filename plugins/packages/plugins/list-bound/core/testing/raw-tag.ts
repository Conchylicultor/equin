import { LIST_BOUND_TAG } from "../internal/markers";

/**
 * `schema` tagged with `raw` exactly as given — no marker's checks — for a
 * test proving a malformed tag (`{ reason: "" }`, `{ size: 3 }`) fails loudly
 * where the schema is walked. A clone; the source is untouched.
 */
export function withRawListBoundTag<S extends object>(
  schema: S,
  raw: unknown,
): S {
  return LIST_BOUND_TAG.set(schema, raw);
}
