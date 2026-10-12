// The CollectedDir marker. A plugin declares itself a collected runtime by
// calling this function with its dir-name string inside its core/; codegen
// regex-scans core files for that call and generates the runtime's registry.
// (Do NOT write that quoted call form in a comment here — the scanner would match
// it and emit a bogus registry. Use the helper's own name only.)
//
// This is the single canonical home for the marker (previously copy-pasted as a
// local one-liner in every runtime's collected-dir.ts, and defined in codegen/core
// — which the runtimes could not import without forming a cycle through
// plugin-tree/facets).
//
// The name must be a declared plugin folder (`PluginFolder`, owned by
// plugin-id/core), so a collected dir cannot exist without its row in the
// boundary table. Codegen's discovery enforces the same for call sites tsc
// cannot type.

import type { PluginFolder } from "@plugins/framework/plugins/plugin-id/core";

/**
 * Which plugins a collected dir's committed registry lists.
 *
 * - `"composition"` (the default): the `singularity` composition's closure —
 *   what the app ships. Every runtime registry (web, server, check, lint, …) is
 *   this: an excluded plugin's contribution must not load.
 * - `"checkout"`: every plugin the checkout declares, excluded ones included.
 *   For a registry that describes SOURCE rather than the app — one whose
 *   consumers (checks, lint rules) scan every plugin on disk, so its set must
 *   be the scanned set. `exempt/` is the case: a check that scans an excluded
 *   plugin's file must be able to read that plugin's own exemption of it.
 */
export type CollectedDirMembership = "composition" | "checkout";

export interface CollectedDirDef {
  readonly dir: PluginFolder;
  readonly membership: CollectedDirMembership;
  readonly _brand: "CollectedDirDef";
}

export function defineCollectedDir(
  dir: PluginFolder,
  options?: { membership: CollectedDirMembership },
): CollectedDirDef {
  return {
    dir,
    membership: options?.membership ?? "composition",
    _brand: "CollectedDirDef",
  };
}

export function isCollectedDirDef(value: unknown): value is CollectedDirDef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as CollectedDirDef)._brand === "CollectedDirDef"
  );
}
