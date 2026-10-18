import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  listChannels,
  logsDir,
  logsDirFor,
  readChannelEntries,
  readChannelJson,
  readChannelJsonAsync,
} from "./internal/persist";
export { clientLogFamily } from "./internal/client-log-family";
export { channelFileSink, logEnvelope } from "./internal/channel-file";
export type { LogStream } from "./internal/persist";

export default {
  description:
    "The desktop's log-channel files: where each worktree's <channel>.jsonl lives (logsDir / logsDirFor), the bounded read path (readChannelEntries / readChannelJson), and the client-log family bound. Desktop-only: it reads the filesystem.",
} satisfies ServerPluginDefinition;
