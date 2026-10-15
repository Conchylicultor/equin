import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleEmit } from "./internal/handle-emit";
import { wsHandler } from "./internal/ws-handler";
import { emitLogs } from "../core/endpoints";

export { Log, defineLogSink } from "./internal/log";
export type { LogChannel, LogStream } from "./internal/log";
export { clientLogFamily } from "./internal/client-ingress";
export {
  listChannels,
  logsDir,
  logsDirFor,
  readChannelEntries,
  readChannelJson,
  readChannelJsonAsync,
} from "./internal/persist";

export default {
  httpRoutes: {
    [emitLogs.route]: handleEmit,
  },
  wsRoutes: {
    "/ws/logs": wsHandler,
  },
} satisfies ServerPluginDefinition;
