import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export type { ScoreCoverRequest } from "./internal/serve-cover";
export { serveScoreCover } from "./internal/serve";

export default {
  description:
    "Serves Sonata song covers: a content-addressed SVG cache (rendered on request, deduped while in flight), immutable while the URL's version is current.",
} satisfies ServerPluginDefinition;
