import type {
  LiveFieldIds,
  LiveFields,
  LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import type { FieldOverride, FieldOverrides } from "./types";

/** The row type of a collection. */
type RowOf<C> = C extends LiveRowsCollection<infer R> ? R : never;

/**
 * A list's changes to the fields it derives from `collection`, by field id —
 * typed against the collection's own (an id it does not declare is a tsc
 * error) and asserted against the DataView's collection at mount:
 *
 * ```ts
 * overrides={fieldOverrides(conversationsActive, { status: { groupable: false } })}
 * ```
 */
export function fieldOverrides<
  C extends { readonly key: string; readonly fields: LiveFields | null },
>(
  collection: C,
  // `NoInfer`: `C` is inferred from the collection alone, so a `cell(row)` /
  // `onEdit(row, next)` written here is contextually typed by the settled row.
  byId: NoInfer<{
    readonly [K in LiveFieldIds<C>]?: FieldOverride<RowOf<C>>;
  }>,
): FieldOverrides<RowOf<C>> {
  return Object.freeze({
    collection: collection.key,
    byId: Object.freeze({ ...byId }) as Readonly<
      Record<string, FieldOverride<RowOf<C>>>
    >,
  });
}
