// Which plugins the `base-exclusions` row negates — the providers of a host
// without the computer. Shared by the browser-host derivation
// (`browser-host-gen.ts`) and the `host-services:provider-placement` check. The
// text parsers (what a module declares, what a barrel provides) are
// parse-utils' (`parseHostServiceDeclarations`, `providedServiceNames`).

import {
  asFsPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  matchEntryPattern,
  parseEntryPattern,
  type EdgeGraph,
} from "@plugins/plugin-meta/plugins/closure/core";
import type { CompositionManifestItem } from "@plugins/plugin-meta/plugins/composition/core";
import { BASE_EXCLUSIONS_ID } from "@plugins/infra/plugins/namespace/core";

/**
 * The server barrels of every plugin a `base-exclusions` negative names — the
 * plugins no desktop composition ships, which is where a host without the
 * computer finds its providers. Matched against the edge graph, so a subtree
 * negative covers its descendants. Repo-relative, sorted; only barrels that
 * exist (`has`).
 */
export function baseExclusionServerBarrels(
  graph: EdgeGraph,
  manifests: readonly CompositionManifestItem[],
  has: (path: string) => boolean,
): string[] {
  const row = manifests.find((m) => m.id === BASE_EXCLUSIONS_ID);
  if (row === undefined) {
    throw new Error(
      `No "${BASE_EXCLUSIONS_ID}" row in the composition manifests — the host-service providers of a host without the computer are named by its negatives (plugins/plugin-meta/plugins/composition/core/config.ts).`,
    );
  }
  const ids = new Set<PluginId>();
  for (const raw of row.entryPoints) {
    const p = parseEntryPattern(raw);
    if (!p.negate) continue;
    for (const id of matchEntryPattern(p, graph)) ids.add(id);
  }
  return [...ids]
    .map((id) => `plugins/${asFsPath(id)}/server/index.ts`)
    .filter(has)
    .sort();
}
