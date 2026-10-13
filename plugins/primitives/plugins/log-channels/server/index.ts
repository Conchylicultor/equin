import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleChannels } from "./internal/handle-channels";
import { handleEmit } from "./internal/handle-emit";
import { wsHandler } from "./internal/ws-handler";
import { getLogChannels, emitLogs } from "../core/endpoints";

export { Log, defineLogSink } from "./internal/log";
export type { LogChannel, LogStream } from "./internal/log";
export {
  listChannels,
  logsDirFor,
  readChannelEntries,
  readChannelJson,
  readChannelJsonAsync,
} from "./internal/persist";

export default {
  httpRoutes: {
    [getLogChannels.route]: handleChannels,
    [emitLogs.route]: handleEmit,
  },
  wsRoutes: {
    "/ws/logs": wsHandler,
  },
} satisfies ServerPluginDefinition;
