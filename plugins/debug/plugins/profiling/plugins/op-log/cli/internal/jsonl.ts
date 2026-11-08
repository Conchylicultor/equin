import { opLogSink } from "@plugins/debug/plugins/profiling/plugins/op-log/server";

/**
 * Append one record to the op log, on disk before this returns: a CLI op's
 * event must survive the process dying on its next statement (a SIGKILL, an
 * exit right after `completed`).
 */
export function appendOpLogSync(record: unknown): void {
  opLogSink.appendSync(JSON.stringify(record));
}
