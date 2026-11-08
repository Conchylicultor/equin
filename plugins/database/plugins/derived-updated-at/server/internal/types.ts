import type { DbTriggerSet } from "@plugins/database/plugins/db-triggers/server";

// A column's rule for whether a write to it counts as a change of the record,
// moving its `updatedAt`:
//   - `true`  → any change of value (`NEW.c IS DISTINCT FROM OLD.c`);
//   - `false` → never;
//   - `{ into, outOf }` → only a change INTO one of `into` or OUT OF one of
//     `outOf`. Typed against the column's own value type by the declaring
//     side (entities' `TouchedBy`), so a misspelled value is a tsc error.
//   - `{ exceptKeys }` → a jsonb OBJECT column: any change of value other than
//     to the listed top-level keys (`(NEW.c - keys) IS DISTINCT FROM (OLD.c -
//     keys)`). For a presentation key riding inside a content payload (a page's
//     icon inside its block data) that must not count as an edit of the record.
//     The keys are typed against the column's object type, so only a key the
//     value can carry is accepted.
export type TouchRule<T> =
  | boolean
  | { readonly into?: readonly T[]; readonly outOf?: readonly T[] }
  | { readonly exceptKeys: readonly ObjectKeyOf<T>[] };

/**
 * The string keys of `T` when it is an object type (per union arm; `never` for
 * a scalar). An untyped rule (`TouchRule<unknown>`, the compiler's own view)
 * takes any string.
 */
export type ObjectKeyOf<T> = unknown extends T
  ? string
  : T extends Record<string, unknown>
    ? Extract<keyof T, string>
    : never;

// The compiled trigger for one table: plain DDL strings, the sha256 of both
// (what tells two declarations of one table apart), and the db-triggers set
// the boot installer installs them as. Built by `compileDerivedUpdatedAt`.
export interface DerivedUpdatedAtSpec {
  /** Physical table name. */
  readonly table: string;
  /**
   * Physical name of the derived column (`updated_at`) — the one no write may
   * name: the `sql-writes` check reads it to refuse a hand-written SQL write.
   */
  readonly column: string;
  /** Name of both the trigger and its function (`<table>_derive_updated_at`). */
  readonly triggerName: string;
  readonly functionDdl: string;
  readonly triggerDdl: string;
  readonly signature: string;
  /** `updated-at.<table>`: the function and trigger, as `installDbTriggers` takes them. */
  readonly triggerSet: DbTriggerSet;
}
