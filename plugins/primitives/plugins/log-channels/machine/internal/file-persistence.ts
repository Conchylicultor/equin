import { openDynamicSink } from "@plugins/infra/plugins/file-sink/core";
import { isUnderDuress } from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import {
  declaredDurableChannels,
  type LogPersistenceImpl,
} from "@plugins/primitives/plugins/log-channels/server";
import {
  channelFileSink,
  logEnvelope,
  logsDir,
} from "@plugins/primitives/plugins/log-channels/plugins/log-files/server";

/** The desktop's log persistence: per-worktree `<channel>.jsonl` files, one
 *  `{t,stream,line}` envelope per line (log-files owns the format and the read
 *  path that parses it back). */
export const filePersistence: LogPersistenceImpl = {
  sinkFor(channel) {
    const file = channelFileSink(channel);
    return { appendAll: (lines) => file.appendAll(lines.map(logEnvelope)) };
  },
  // The browser's open-ended channel family shares one rotation through
  // `openDynamicSink`, bounded by the declared `client-log` family entry
  // (`clientLogFamily`, log-files) rather than one registry entry per id.
  clientSinkFor(channelId) {
    const file = openDynamicSink(logsDir(), channelId);
    return { appendAll: (lines) => file.appendAll(lines.map(logEnvelope)) };
  },
  clientIngressPaused: isUnderDuress,
};

/**
 * Declare the file sink of every durable channel at boot, before any has
 * written a line — so `getFileSinks()` (retention's growth bounds, Debug →
 * Logs) lists each one with its description from the start. A channel
 * declared later (a module loaded after boot) gets its sink on first publish.
 */
export const declareDurableFileSinks = {
  _kind: "log-file-sinks",
  register() {
    for (const channel of declaredDurableChannels()) channelFileSink(channel);
  },
};
