import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { ndjsonResponse } from "./internal/ndjson-response";

export default {
  description:
    "NDJSON (application/x-ndjson) streaming Response builder: wrap a frame-emitting producer into a chunked stream that survives Bun's idle timeout, for a mutation whose steps the caller shows as they run (a progressive read is a notified live value instead).",
} satisfies ServerPluginDefinition;
