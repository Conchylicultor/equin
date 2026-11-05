// A server plugin's handler on a one-handler sink (`primitives/report-sink`'s
// `ReportSink` / `RequestSink`), declared as data on the plugin
// (`sinkHandlers: [sinkHandler(sink, () => handler)]`) rather than registered
// from a lifecycle hook the plugin picks.
//
// Why the framework owns the phase: a sink HOLDS what is emitted with no
// handler (a report sink) or answers "no consumer" (a request sink), so a
// handler registered in a phase some process never runs fails silently there.
// The case that forced this: `database/query-deadline` registered in `onReady`,
// which an exec child (a supervised job's body, where much background DB work
// runs) skips — every deadline missed there was held and dropped when the child
// exited, with no report and no log line. The framework attaches every handler
// in the `onReadyBlocking` phase (after its plugin's `dependsOn` parents', just
// before its own hook — a migrated DB for a handler that files reports), which
// every boot mode runs, and detaches it after the process's `onShutdown` hooks.
// `report-sink/no-direct-sink-register` forbids the hand-rolled `.register(fn)`
// outside the browser.

/** The one-handler slot of a report or request sink, read structurally. */
interface HandlerSlot<H> {
  register(fn: H | null): void;
}

/** A handler on a sink, attached and detached by the framework. */
export interface SinkHandler {
  /** Called by the framework in the `onReadyBlocking` phase. Never from plugin code. */
  attach(): void;
  /** Called by the framework after every `onShutdown`. Never from plugin code. */
  detach(): void;
}

/**
 * Declare `make()`'s handler on `sink`, for a server plugin's `sinkHandlers`.
 * `make` runs once, when the framework attaches it — so building the handler
 * (closing over other plugins' functions) costs nothing at module eval.
 */
export function sinkHandler<H>(
  sink: HandlerSlot<H>,
  make: () => H,
): SinkHandler {
  const handler: SinkHandler = {
    attach() {
      // One slot per sink: a second plugin attaching would silently evict the
      // first plugin's handler, and its reports would stop. (The same handler
      // again — a second boot of one graph in a process — is a re-attach.)
      const current = attached.get(sink);
      if (current !== undefined && current !== handler) {
        throw new Error(
          "[sink-handler] two sinkHandlers attached to one sink — a sink has one handler slot; only one plugin may declare a handler on it",
        );
      }
      sink.register(make());
      attached.set(sink, handler);
    },
    detach() {
      if (attached.get(sink) !== handler) return;
      attached.delete(sink);
      sink.register(null);
    },
  };
  return handler;
}

// The sinks a handler is attached to now, and which.
const attached = new WeakMap<object, SinkHandler>();

/** Whether a `sinkHandlers` entry is attached to `sink` now. */
export function hasAttachedSinkHandler(sink: object): boolean {
  return attached.has(sink);
}
