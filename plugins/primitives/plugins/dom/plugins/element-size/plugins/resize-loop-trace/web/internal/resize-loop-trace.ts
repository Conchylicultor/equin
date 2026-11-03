import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

// "ResizeObserver loop completed with undelivered notifications." (Chrome,
// Firefox, Safari) or the older "ResizeObserver loop limit exceeded". The
// browser raises it as a bare ErrorEvent — no Error, so no stack — once a
// rendering step ends with a resize it could not deliver: an observer callback
// in that step resized an element at or above the depth of the ones just
// delivered. Nothing in the event says which callback, or which element.
const LOOP_MESSAGE_PREFIX = "ResizeObserver loop";

// A pass is the observer callbacks of one rendering step. Past this many the
// rest are counted, not kept: this runs on every callback of the page.
const PASS_CAP = 50;

/** One observer callback: where the observer was created, and what it was
 * handed — each entry's target and the content size it reported. */
export interface ResizeLoopObservation {
  /** The first frames of the stack that created the observer, or null when
   * the engine gave none. */
  site: string | null;
  entries: readonly { target: Element; width: number; height: number }[];
}

/** A loop error, with what caused it: `pass` is every callback of the step
 * that raised it; `deferred` the callbacks of the next step, which carry the
 * notifications that were held back — the element whose resize the loop
 * could not deliver is among the shallowest of them. */
export interface ResizeLoopReport {
  message: string;
  pass: readonly ResizeLoopObservation[];
  omittedPass: number;
  deferred: readonly ResizeLoopObservation[];
  omittedDeferred: number;
}

export const resizeLoopReportSink = defineReportSink<ResizeLoopReport>();

type Recorded = {
  created: Error;
  entries: readonly ResizeObserverEntry[];
};

type Pass = { kept: Recorded[]; omitted: number };

// The loop errors an installed tracer took — marked by its capture listener,
// which runs before any bubble-phase listener on the window.
const claimed = new WeakSet<ErrorEvent>();

/** Whether a tracer took this window error and will report it itself, so the
 * window-error reporter must not file it a second time. */
export function claimsResizeLoopError(e: ErrorEvent): boolean {
  return claimed.has(e);
}

function isLoopError(e: ErrorEvent): boolean {
  return (
    e.error == null &&
    typeof e.message === "string" &&
    e.message.startsWith(LOOP_MESSAGE_PREFIX)
  );
}

/**
 * Replaces the page's `ResizeObserver` with a subclass that remembers each
 * callback of the current rendering step, and reports every loop error on
 * {@link resizeLoopReportSink}. Call it once, before anything creates an
 * observer (main.tsx imports it first). Returns the uninstall.
 */
export function installResizeLoopTrace(): () => void {
  const Native = globalThis.ResizeObserver;

  let pass: Pass = { kept: [], omitted: 0 };
  let passEndScheduled = false;
  // The next steps' callbacks, one list per loop error still waiting for
  // the notifications it held back.
  const captures = new Set<Pass>();

  function push(into: Pass, recorded: Recorded): void {
    if (into.kept.length < PASS_CAP) into.kept.push(recorded);
    else into.omitted++;
  }

  function record(created: Error, entries: ResizeObserverEntry[]): void {
    const recorded = { created, entries };
    push(pass, recorded);
    for (const capture of captures) push(capture, recorded);
    // Every callback of a step — and the loop error closing it — runs inside
    // one task, so the pass ends with the next one. Scheduled once per step
    // that delivered anything.
    if (!passEndScheduled) {
      passEndScheduled = true;
      setTimeout(() => {
        pass = { kept: [], omitted: 0 };
        passEndScheduled = false;
      }, 0);
    }
  }

  class TracedResizeObserver extends Native {
    constructor(callback: ResizeObserverCallback) {
      // Its stack is read only when a loop is reported.
      const created = new Error();
      super((entries, observer) => {
        record(created, entries);
        callback.call(observer, entries, observer);
      });
    }
  }

  function onError(e: ErrorEvent): void {
    if (!isLoopError(e)) return;
    claimed.add(e);
    // A copy: the step's pass keeps filling until its task ends.
    const raised: Pass = { kept: [...pass.kept], omitted: pass.omitted };
    const deferred: Pass = { kept: [], omitted: 0 };
    captures.add(deferred);
    // The loop error fires after this frame's animation callbacks: the first
    // runs at the start of the next frame, before its observers deliver what
    // was held back; the second at the start of the one after.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        captures.delete(deferred);
        resizeLoopReportSink.emit({
          message: e.message,
          pass: raised.kept.map(observation),
          omittedPass: raised.omitted,
          deferred: deferred.kept.map(observation),
          omittedDeferred: deferred.omitted,
        });
      }),
    );
  }

  globalThis.ResizeObserver = TracedResizeObserver;
  window.addEventListener("error", onError, true);
  return () => {
    window.removeEventListener("error", onError, true);
    globalThis.ResizeObserver = Native;
  };
}

function observation({ created, entries }: Recorded): ResizeLoopObservation {
  return {
    site: creationSite(created),
    entries: entries.map((e) => ({
      target: e.target,
      width: e.contentRect.width,
      height: e.contentRect.height,
    })),
  };
}

// The frames above the TracedResizeObserver constructor: V8 heads a stack with
// the message line, Firefox and Safari do not; the first frame is always the
// constructor itself.
function creationSite(created: Error): string | null {
  const frames = (created.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at ") || line.includes("@"));
  const callers = frames.slice(1, 4);
  return callers.length > 0 ? callers.join("\n") : null;
}
