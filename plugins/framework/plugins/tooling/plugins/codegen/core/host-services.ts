// The host providers' server barrels — the providers of a host without the
// computer. Shared by the browser-host derivation (`browser-host-gen.ts`) and
// the `host-services:provider-placement` check. The text parsers (what a module
// declares, what a barrel provides) are parse-utils' (`parseHostServiceDeclarations`,
// `providedServiceNames`).

import {
  asFsPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import type { EdgeGraph } from "@plugins/plugin-meta/plugins/closure/core";

/**
 * The server barrel of every HOST PROVIDER (`EdgeGraph.hostProviders`: a
 * plugin whose `server/index.ts` provides a host service) — the plugins no
 * composition bundles, which is where a host without the computer finds its
 * providers. Repo-relative, sorted.
 */
export function hostProviderServerBarrels(graph: EdgeGraph): string[] {
  return [...graph.hostProviders.keys()]
    .map((id: PluginId) => `plugins/${asFsPath(id)}/server/index.ts`)
    .sort();
}
