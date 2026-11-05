// The process's crash listeners — `uncaughtException` / `unhandledRejection` —
// owned by the framework, never by a plugin.
//
// Why the framework owns them: a listener is process-wide state, and a plugin
// installing it from a lifecycle hook installs it only where that hook runs.
// The reports engine installed its crash hooks in `onReady`, which an exec
// child (a supervised job's body) skips, so an uncaught throw or an unhandled
// rejection in a child was filed nowhere — the same class as the handler
// registered in `onReady` that `./sink-handler.ts` closed. So each process
// entry point (`bin/serve.ts`, `cli/run-exec.ts`) installs these listeners
// (`./process-crash-listeners.ts`) before it boots the graph, and they dispatch
// to `processCrashSink`, whose handler a plugin declares in its `sinkHandlers`
// (attached in the phase every boot mode runs).
// `server-core/no-process-crash-listener` forbids a hand-installed listener
// anywhere else.
//
// This file is the portable half — the sink and its question — in the core
// barrel; the listeners need the `process` global, so they are a file of their
// own that only the two process entry points import (by path, never through
// the barrel, which a browser host loads).

import { defineRequestSink } from "@plugins/primitives/plugins/report-sink/core";
import { hasAttachedSinkHandler } from "./sink-handler";

export type ProcessCrashEvent = "uncaughtException" | "unhandledRejection";

export interface ProcessCrash {
  event: ProcessCrashEvent;
  error: Error;
}

/**
 * A crash the process's own listeners caught. A REQUEST sink, never held: an
 * uncaught exception exits on the next statement, so the handler must make its
 * write durable synchronously, and answers whether it landed. The reports
 * engine handles it (a `sinkHandlers` entry), so it is attached in every boot
 * mode from the `onReadyBlocking` phase on.
 */
export const processCrashSink = defineRequestSink<ProcessCrash, boolean>();

/**
 * Whether a crash now belongs to `processCrashSink`'s handler. Before one is
 * attached, another listener may own the process's crashes — the serving
 * backend's boot-crash filer (`debug/boot-events`) — and asks this to know when
 * to stand down, so exactly one of them files each crash.
 */
export function isProcessCrashHandled(): boolean {
  return hasAttachedSinkHandler(processCrashSink);
}
