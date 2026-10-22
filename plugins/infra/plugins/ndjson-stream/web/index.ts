import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { readNdjson } from "./internal/read-ndjson";

export default {
  description:
    "Client NDJSON stream reader: an async generator yielding one parsed JSON frame per line from a streamed endpoint over the caller's transport (readNdjson(transport, route, url, init)), guarding res.ok and reporting via EndpointError.",
  contributions: [],
} satisfies PluginDefinition;
