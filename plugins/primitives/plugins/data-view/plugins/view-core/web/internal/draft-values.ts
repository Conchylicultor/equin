import type { VariantValue } from "@plugins/fields/plugins/variant/core";

/**
 * The working copies of a drafted surface's views: one `view` blob per view id
 * whose edits have not been saved. A view with no entry shows its saved blob.
 */
export type DraftMap = Readonly<Record<string, VariantValue>>;

/** The map with `id`'s draft set to `view`, or dropped when `view` is `null`.
 *  The same map when nothing changes, so no write and no re-render follow. */
export function withDraft(
  map: DraftMap,
  id: string,
  view: VariantValue | null,
): DraftMap {
  if (view === null) {
    if (!(id in map)) return map;
    const rest = { ...map };
    delete rest[id];
    return rest;
  }
  return map[id] === view ? map : { ...map, [id]: view };
}

/** `view` without its `undefined` keys — what a write means by "remove this
 *  key", and what the saved row's mirror does to the same write. */
export function cleanView(view: VariantValue): VariantValue {
  return Object.fromEntries(
    Object.entries(view).filter(([, v]) => v !== undefined),
  ) as VariantValue;
}

/**
 * One spelling per JSON value: object keys sorted, `undefined` members
 * dropped (as `JSON.stringify` drops them). Two blobs are the same view when
 * their canonical forms are equal, whatever order their keys were written in.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, member]) => member !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

/**
 * Whether two `view` blobs are the same view: equal canonical JSON after the
 * consumer's `canonical` projection (which drops what does not make two views
 * different to it — data-view's filter-node ids). The engine itself names no
 * key of the blob.
 */
export function sameView(
  a: VariantValue,
  b: VariantValue,
  canonical: ((view: VariantValue) => unknown) | undefined,
): boolean {
  const project = canonical ?? ((v: VariantValue) => v);
  return canonicalJson(project(a)) === canonicalJson(project(b));
}
