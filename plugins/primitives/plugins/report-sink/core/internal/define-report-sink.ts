/** Fire-and-forget: emit() hands a report to whoever consumes it, now or later. */
export interface ReportSink<TBody> {
  register(fn: ((body: TBody) => void) | null): void;
  emit(body: TBody): void;
}

/** Ask-and-answer: emit() returns the handler's answer, or undefined when nobody is registered. */
export interface RequestSink<TBody, TResult> {
  register(fn: ((body: TBody) => TResult) | null): void;
  emit(body: TBody): TResult | undefined;
}

/** How many reports a sink holds while no handler is registered. */
export const REPORT_SINK_HOLD_CAP = 100;

// A module-level soft-reporter slot. The primitive owning the sink defines its
// own neutral TBody; a domain plugin (e.g. `reports`) registers the mapping to
// report(). emit() is called on error paths, so it never throws — a throw from
// the registered handler is swallowed rather than propagated.
//
// A report emitted while no handler is registered is HELD, not dropped: the
// reporter usually registers from a mount effect, and a failure during boot
// fires before that effect has run. The next register(fn) replays the held
// reports in order, then delivers directly. The same holds for the gap after a
// handler unregisters (an HMR remount) — held, then replayed to its successor.
// register(null) discards whatever is held: a detach means nothing emitted
// before it should reach the next handler (in the app the hold is always empty
// at that point; in a test it keeps one case's reports out of the next).
//
// The hold is bounded — this is an error path, not a queue. It keeps the FIRST
// REPORT_SINK_HOLD_CAP reports (the first failures are usually the cause, the
// rest their cascade) and drops later ones, warning once per overflow.
export function defineReportSink<TBody>(): ReportSink<TBody> {
  const sink = createReportSink<TBody>();
  holdingSinks.add(sink);
  return sink;
}

// Every report sink defined in this process, so a test runner can empty their
// holds between tests (`discardHeldReports`): the hold is process-global, and a
// test process runs many suites one after another — a report one suite's
// background work emitted with no handler would otherwise be replayed into the
// first handler a LATER suite registers (its collector), failing it with
// reports that are not its own.
const holdingSinks = new Set<{ discardHeld(): void }>();

/** Drop every report held by every report sink, with no handler told. */
export function discardHeldReports(): void {
  for (const sink of holdingSinks) sink.discardHeld();
}

function createReportSink<TBody>(): ReportSink<TBody> & {
  discardHeld(): void;
} {
  let handler: ((body: TBody) => void) | null = null;
  let held: TBody[] = [];
  let overflowWarned = false;

  function deliver(fn: (body: TBody) => void, body: TBody): void {
    try {
      fn(body);
      // eslint-disable-next-line promise-safety/no-bare-catch -- reporting must never throw on the error path; a throw from the registered handler is swallowed here
    } catch {
      // ignore
    }
  }

  return {
    discardHeld() {
      held = [];
      overflowWarned = false;
    },
    register(fn) {
      handler = fn;
      const pending = held;
      held = [];
      overflowWarned = false;
      if (fn) for (const body of pending) deliver(fn, body);
    },
    emit(body) {
      if (handler) {
        deliver(handler, body);
      } else if (held.length < REPORT_SINK_HOLD_CAP) {
        held.push(body);
      } else if (!overflowWarned) {
        overflowWarned = true;
        console.warn(
          `[report-sink] ${REPORT_SINK_HOLD_CAP} reports held with no handler registered; dropping newer ones until one registers`,
        );
      }
    },
  };
}

// The same slot for a caller that needs the handler's ANSWER (a task id, "did a
// consumer take this?"). Never held: an answer that arrives after the caller has
// moved on has nobody to go to, and replaying the request later would repeat a
// side effect the caller already fell back from. emit() returns undefined when
// nobody is registered — the caller's explicit "no consumer" branch.
export function defineRequestSink<TBody, TResult>(): RequestSink<
  TBody,
  TResult
> {
  let handler: ((body: TBody) => TResult) | null = null;
  return {
    register(fn) {
      handler = fn;
    },
    emit(body) {
      try {
        return handler?.(body);
        // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- reporting must never throw on the error path; a throw from the registered handler is swallowed here
      } catch {
        return undefined;
      }
    },
  };
}
