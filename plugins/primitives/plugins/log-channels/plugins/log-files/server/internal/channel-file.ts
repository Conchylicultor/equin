import { join } from "node:path";
import {
  defineFileSink,
  sanitizeChannel,
  type FileSink,
} from "@plugins/infra/plugins/file-sink/core";
import { logsDir, type LogStream } from "./persist";

/** One stored line: the on-disk JSONL envelope the read path parses back. */
export function logEnvelope(entry: {
  t: number;
  stream: LogStream;
  line: string;
}): string {
  return JSON.stringify({ t: entry.t, stream: entry.stream, line: entry.line });
}

// One declared file sink per durable channel id — a channel id names one file.
const sinks = new Map<string, FileSink>();

/**
 * The bounded-append file sink of one durable channel (128 MB × 3 rotation,
 * `infra/file-sink`), declared on first ask, so `getFileSinks()` lists it with
 * its description. Its PATH resolves lazily, on first write: resolving the
 * per-worktree logs dir asks for this process's runtime namespace. The file is
 * `<logsDir>/<id>.jsonl`; the read path (`readChannelEntries`) rebuilds the
 * same name, both through `sanitizeChannel`.
 *
 * Shared by the desktop's `LogPersistence` (log-channels#machine) and the
 * threads that write a channel with no plugin graph behind them (the
 * sentinel's worker).
 */
export function channelFileSink(channel: {
  id: string;
  description: string;
}): FileSink {
  let sink = sinks.get(channel.id);
  if (sink === undefined) {
    sink = defineFileSink({
      id: channel.id,
      description: channel.description,
      path: () => join(logsDir(), sanitizeChannel(channel.id) + ".jsonl"),
    });
    sinks.set(channel.id, sink);
  }
  return sink;
}
