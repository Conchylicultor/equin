// The process's crash listeners — the half of `./process-crash.ts` that needs
// the `process` global. Imported by path by the two process entry points
// (`bin/serve.ts`, `cli/run-exec.ts`) only, never through the core barrel: a
// browser host loads that barrel and has no `process`.

import { isProcessCrashHandled, processCrashSink } from "./process-crash";
import type { ProcessCrashEvent } from "./process-crash";

let installed = false;

/**
 * Install the process's crash listeners. Called by a process entry point
 * (`serve`, `runExec`) before the plugin graph loads — not from the graph
 * (`bootPluginGraph` is also booted inside a test runner, whose own crash
 * handling must stay its own).
 *
 * What a crash does:
 * - **a handler is attached**: it files the crash; then an uncaught exception
 *   exits 1 (the runtime's own behaviour, which a listener replaces) and an
 *   unhandled rejection does not — rejections are recoverable in practice;
 * - **no handler yet, another listener installed**: that listener owns it
 *   (`isProcessCrashHandled()` is false for it too);
 * - **no handler, no other listener**: the runtime's default — printed, exit 1
 *   — saying it was not filed.
 *
 * The error is printed in every case: stderr is the transcript a supervised
 * child's run keeps (its end becomes the run's error when the child recorded
 * none) and what the gateway quotes back to a build.
 */
export function installProcessCrashListeners(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (err: unknown) =>
    onProcessCrash("uncaughtException", err),
  );
  process.on("unhandledRejection", (reason: unknown) =>
    onProcessCrash("unhandledRejection", reason),
  );
}

/** One crash, as a listener receives it (exported for its test). */
export function onProcessCrash(event: ProcessCrashEvent, raw: unknown): void {
  const error = raw instanceof Error ? raw : new Error(String(raw));
  // Asked BEFORE dispatching, never read off the answer: a request sink
  // answers `undefined` for a handler that threw too, and that crash is ours.
  const handled = isProcessCrashHandled();
  // No handler yet, and another listener installed — the serving backend's
  // boot-crash filer, the one other listener the lint admits: it owns this.
  if (!handled && process.listenerCount(event) > 1) return;
  const filed = handled ? processCrashSink.emit({ event, error }) : undefined;
  console.error(`[process-crash] ${event}:`, raw);
  if (filed !== true) {
    console.error(
      `[process-crash] this ${event} was NOT filed (${
        !handled
          ? "no handler attached to processCrashSink"
          : filed === undefined
            ? "its handler threw"
            : "its durable write failed"
      })`,
    );
  }
  // A rejection is survived once a handler owns crashes (a failed write was
  // said above); with none, it is the runtime's default — a crash.
  if (event === "uncaughtException" || !handled) process.exit(1);
}
