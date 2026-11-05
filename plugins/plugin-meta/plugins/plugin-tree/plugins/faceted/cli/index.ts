import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * Build this checkout's faceted plugin tree and write it as JSON
 * (`pluginTreeToJson`) to `<out>`. What a serving backend runs to read the
 * faceted tree (`plugin-tree/server`'s `getFacetsTreeCached`): building it
 * loads every facet extractor — build tooling — so it happens in this
 * process, never in the backend's (`boot:closure-digestable`).
 */
export default defineCliCommand<[string], object>({
  name: "plugin-tree-facets",
  description:
    "Write this checkout's faceted plugin tree as JSON to <out> (what the backend's Studio and deploy-secrets surfaces read)",
  arguments: [
    { name: "out", description: "the file the tree's JSON is written to" },
  ],
  run: () => import("./run"),
});
