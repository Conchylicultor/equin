import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { BASE_EXCLUSIONS_ID } from "@plugins/infra/plugins/namespace/core";
import type { EntryPattern } from "@plugins/plugin-meta/plugins/closure/plugins/entry-pattern/core";
import type { CompositionManifest } from "./types";

/**
 * Resolve a manifest's `extends` chain into a single flat manifest. The result's
 * `entryPoints` + `selectedContributors` are the UNION of this manifest's own,
 * every transitively-extended composition's, and the base-exclusions row's, with
 * `extends` cleared (`[]`). Everything the engine consumes
 * (`resolveComposition`, the causality queries, the `composition-closure` check)
 * operates on a flattened manifest, so `extends` is a pure pre-resolution
 * rewrite — never a special case downstream.
 *
 * Conservative + total, mirroring the rest of the engine:
 * - **Diamond/cycle-safe** — a `visited` set over composition NAMES means each
 *   composition is folded in at most once, so `a extends b`, `b extends a`, or two
 *   paths to the same pack all terminate and union cleanly.
 * - **Unknown names pass inertly** — an `extends` entry with no matching manifest
 *   in `registry` contributes nothing (exactly like an unknown plugin id in
 *   `entryPoints` flows inertly through `expandEntrySeeds`). Whether the name
 *   resolves is the `composition-closure` check's job, not resolution's.
 *
 * `name` and any other fields are carried from the root manifest unchanged.
 */
export function flattenManifest(
  manifest: CompositionManifest,
  registry: Iterable<CompositionManifest>,
): CompositionManifest {
  const byName = new Map<string, CompositionManifest>();
  for (const m of registry) byName.set(m.name, m);

  const entryPoints = new Set<EntryPattern>();
  const selectedContributors = new Set<PluginId>();
  const visited = new Set<string>();

  const visit = (m: CompositionManifest): void => {
    if (visited.has(m.name)) return;
    visited.add(m.name);
    for (const e of m.entryPoints) entryPoints.add(e);
    for (const c of m.selectedContributors) selectedContributors.add(c);
    for (const name of m.extends ?? []) {
      const ext = byName.get(name);
      if (ext) visit(ext);
    }
  };
  visit(manifest);

  // The base-exclusions row is folded into EVERY composition, unconditionally —
  // it is not something a manifest opts into via `extends`. That is the whole
  // point: an exclusion the repo has decided on holds by construction, not by
  // each new composition remembering to reference it. A composition that wants
  // one of those plugins back names it explicitly, and the negative pass's
  // protection rule makes that local positive win.
  //
  // Looked up by `name` because that is how `extends` already resolves a
  // reference, and the base row's name equals its id. The row is optional in the
  // registry: a synthetic registry that has none flattens exactly as before,
  // inertly — same rule as an unknown `extends` name.
  if (manifest.name !== BASE_EXCLUSIONS_ID) {
    const base = byName.get(BASE_EXCLUSIONS_ID);
    if (base) visit(base);
  }

  return {
    ...manifest,
    entryPoints: [...entryPoints],
    selectedContributors: [...selectedContributors],
    extends: [],
  };
}
