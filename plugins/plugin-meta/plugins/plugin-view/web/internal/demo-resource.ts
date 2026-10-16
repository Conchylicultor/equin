import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { pluginTree } from "../../core";

/** Inside a demo scope: No plugins: a demo transcript's code spans are never claimed as plugin links. */
export const pluginTreeDemo = demoResource("plugin-view", (s) => [
  s.serveValue(pluginTree, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    loader: () => ({
      pluginsRoot: "plugins",
      plugins: [],
      totals: { plugins: 0, loadBearing: 0, umbrellas: 0 },
    }),
  }),
]);
