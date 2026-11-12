import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { ALL_EXCLUSIONS_ID } from "@plugins/infra/plugins/namespace/core";
import type { EntryPattern } from "@plugins/plugin-meta/plugins/closure/plugins/entry-pattern/core";
import type { CompositionManifest } from "./types";

/**
 * Resolve a manifest's `extends` chain into a single flat manifest. The result's
 * `entryPoints` + `selectedContributors` are the UNION of this manifest's own,
 * every transitively-extended composition's, and its exclusion set's (the row
 * `manifest.exclusions` names, else `ALL_EXCLUSIONS_ID`, with that set's own
 * `extends` chain), with `extends` cleared (`[]`). Everything the engine consumes
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

  // The exclusion set is folded into EVERY composition — the one it names, and
  // the strictest (`ALL_EXCLUSIONS_ID`) when it names none. Not something a
  // manifest opts into via `extends`: an exclusion the repo has decided on holds
  // by construction, not by each new composition remembering to reference it,
  // and a row can only trade the default for a narrower set by saying so. Every
  // set extends `base-exclusions` (`composition-closure` holds that), so no row
  // can drop the repo-wide removals. A composition that wants one of those
  // plugins back names it explicitly, and the negative pass's protection rule
  // makes that local positive win.
  //
  // Looked up by `name`, as `extends` resolves a reference (a set's name equals
  // its id), and visited like one: the set's own `extends` chain comes with it,
  // and a set flattening itself is already visited. The set is optional in the
  // registry: a synthetic registry without it flattens exactly as before,
  // inertly — same rule as an unknown `extends` name.
  const set = byName.get(manifest.exclusions ?? ALL_EXCLUSIONS_ID);
  if (set) visit(set);

  return {
    ...manifest,
    entryPoints: [...entryPoints],
    selectedContributors: [...selectedContributors],
    extends: [],
  };
}
