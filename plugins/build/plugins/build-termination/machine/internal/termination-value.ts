import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { acquireDirWatch } from "@plugins/infra/plugins/file-watcher/server";
import {
  readSignalOriginLinesAsync,
  SIGNAL_ORIGIN_FILE,
} from "@plugins/packages/plugins/signal-origin/plugins/sink/core";
import { buildRunTermination } from "../../core";
import { selectTermination } from "./select-termination";

const SINK_DIR = dirname(SIGNAL_ORIGIN_FILE);
const SINK_FILE = basename(SIGNAL_ORIGIN_FILE);

/** The sink file or one of its rotations (`signal-origin.jsonl.1`, `.2`). */
function isSinkFile(path: string): boolean {
  const name = basename(path);
  return name === SINK_FILE || name.startsWith(`${SINK_FILE}.`);
}

/**
 * One run's termination record, folded out of the host-global sink.
 *
 * `notified`, by a watch on the sink for as long as a tuple is read: the dying
 * CLI appends its line from a signal handler / exit hook, so a live run's
 * record changes exactly when the sink is written — a supervised build's and a
 * hand-run one's alike (the run-terminal signal never announces a hand-run
 * build) — and a run that ended already is never written about again, so for
 * it the watch is silent: immutable once terminal, without the loader reading
 * the ledger row to tell the two apart (the `release.run-logs` shape). The
 * sink is shared by every run on the host, so another run's line costs each
 * subscribed tuple one re-read that answers the same; a fatal signal is rare.
 *
 * Read through the sink's own positioned, bounded reader, asynchronously: the
 * loader runs inside the shared flush cycle, where a synchronous read would
 * freeze every other loader each time any run's line lands.
 */
export const buildRunTerminationServed = serveValue(buildRunTermination, {
  source: "external",
  changes: "notified",
  loader: async ({ id }) =>
    selectTermination(await readSignalOriginLinesAsync(), id),
  // A children-scope watch of the sink's own directory through the shared dir
  // hub. The directory is created if absent: it is the sink's home (its writer
  // creates the same one), and a host that never caught a signal still has a
  // valid, empty answer to watch.
  whileSubscribed: async (_params, notify) => {
    await mkdir(SINK_DIR, { recursive: true });
    const release = await acquireDirWatch({
      dir: SINK_DIR,
      scope: "children",
      onChange: (events) => {
        if (events.some((e) => isSinkFile(e.path))) notify();
      },
    });
    // No trailing re-read: the runtime awaits this start before the tuple's
    // first load, so that load already runs with the watch open.
    return release;
  },
});
