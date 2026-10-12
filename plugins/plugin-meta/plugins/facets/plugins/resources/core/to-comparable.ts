import type { ResourceDef, ResourceFacetData } from "./types";

/**
 * How a resource's mode reads wherever it is shown — `"push"`, `"keyed"`, or
 * `"keyed, window"` / `"keyed, point"` when the descriptor declares a bounded
 * membership, and `", unbounded: <reason>"` appended for a collection-shaped
 * Postgres value that declared why it is not a collection. An external value
 * adds its declared freshness (`changes`): `"push, fixed"`,
 * `"invalidate, snapshot"`, `"push, notified"`.
 *
 * One function rather than four spellings, because the four surfaces (doc,
 * detail pane, contributions table, PR diff) each render the same fact and a
 * membership added to one of them would otherwise be missing from the rest.
 * A window and a point resource are both `mode: "keyed"` at runtime, so without
 * the suffix none of the surfaces can tell a bounded resource from the legacy
 * unbounded keyed form the working-set contract is migrating away from.
 */
export function resourceModeLabel(r: ResourceDef): string {
  const membership = r.membership ? `${r.mode}, ${r.membership}` : r.mode;
  const base =
    r.changes !== undefined ? `${membership}, ${r.changes}` : membership;
  return r.unbounded !== undefined
    ? `${base}, unbounded: ${r.unbounded}`
    : base;
}

/** Diff projection: one "key (mode)" string per resource, server before central. */
export function resourcesToComparable(data: ResourceFacetData): string[] {
  return [...data.server, ...data.central].map(
    (r) => `${r.key} (${resourceModeLabel(r)})`,
  );
}
