import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  ndjsonResponse,
  type NdjsonEmit,
  type NdjsonResponseOptions,
} from "./internal/ndjson-response";
export {
  ndjsonFrames as readNdjson,
  NdjsonParseError,
} from "../shared/ndjson-lines";

export default {
  description:
    "NDJSON (application/x-ndjson) streaming Response builder and reader: ndjsonResponse wraps a frame-emitting producer into a chunked stream (the producer handed an AbortSignal that fires when the reader goes away), for a mutation whose steps the caller shows as they run or a host-only stream a peer process reads; readNdjson(body, signal) parses a streamed body one JSON frame per line, failing loudly on a malformed line. A progressive read is a notified live value instead.",
} satisfies ServerPluginDefinition;
