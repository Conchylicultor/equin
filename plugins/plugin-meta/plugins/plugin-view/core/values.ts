import { liveValue } from "@plugins/network/plugins/live/core";
import { pluginTreePayloadSchema } from "./schema";

/**
 * This checkout's plugin tree, structure only (every node's `facets` is `{}`)
 * — the cheap skeleton the explorer, chips and Settings read. On-demand (the
 * payload is large): each tab reads it over HTTP, and the server tells it to
 * read again only when the structure changed — a plugin added or removed, a
 * barrel or package.json edited (an unchanged generation answers 304).
 */
export const pluginTree = liveValue("plugin-view.tree", {
  schema: pluginTreePayloadSchema,
  load: "on-demand",
  // Read from this checkout's `plugins/` on disk: only the desktop app answers
  // it, and a reader under an in-browser server gets `unavailable`.
  needsMachine: { feature: "Reading the plugin tree" },
});

/**
 * The same tree with every facet extracted and related (exports, routes,
 * `importedBy`, …) — the heavy build, for the plugin detail pane and Studio
 * Contributions. On-demand; told to read again after ANY file under
 * `plugins/` changes (throttled 2 s), since facets read every file.
 */
export const pluginFacetsTree = liveValue("plugin-view.facets-tree", {
  schema: pluginTreePayloadSchema,
  load: "on-demand",
  needsMachine: { feature: "Reading the plugin tree" },
});
