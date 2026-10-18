import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleEmit } from "./internal/handle-emit";
import { wsHandler } from "./internal/ws-handler";
import { emitLogs } from "../core/endpoints";

export { Log, declaredDurableChannels, defineLogSink } from "./internal/log";
export type { LogChannel, LogStream } from "./internal/log";
export { LogPersistence } from "./internal/persistence";
export type {
  DurableLogChannel,
  LogPersistenceImpl,
  LogSink,
} from "./internal/persistence";

export default {
  portable: true,
  httpRoutes: {
    [emitLogs.route]: handleEmit,
  },
  wsRoutes: {
    "/ws/logs": wsHandler,
  },
} satisfies ServerPluginDefinition;
