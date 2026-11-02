import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { serveTranscriptFold } from "./internal/serve-fold";

export default {
  description:
    "serveTranscriptFold: serves a transcript stat's fold of everything before the page's window, which the strip continues over the loaded rows.",
  contributions: [],
} satisfies ServerPluginDefinition;
