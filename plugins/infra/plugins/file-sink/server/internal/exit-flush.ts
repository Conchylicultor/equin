import { flushQueuedAppendsSync } from "../../core";

/**
 * A backend's queued appends are written when the process exits, not dropped:
 * a `process.exit`, a fatal report or an uncaught exception ends the process
 * between an `append` and its write. The listener is synchronous because an
 * `exit` listener cannot wait — the process is ending, so nothing is frozen.
 */
export const exitFlush = {
  _kind: "file-sink-exit-flush",
  register(): void {
    process.once("exit", flushQueuedAppendsSync);
  },
};
