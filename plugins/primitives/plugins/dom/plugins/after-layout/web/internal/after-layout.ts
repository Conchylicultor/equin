import { flushSync } from "react-dom";

/**
 * A layout read: runs once the frame is styled and laid out. It may set React
 * state (committed before paint, with every other read's) and may return a
 * WRITE — a DOM mutation that depends on what it read — which runs after every
 * read of the batch, so no write sits between two reads.
 */
export type AfterLayoutRead = () => void | (() => void);

interface Entry {
  read: AfterLayoutRead;
  live: boolean;
}

/**
 * Passes one phase may take before it is a loop: each pass's commit may mount
 * readers that queue the next. Real trees settle in two or three; reaching the
 * cap means a read keeps re-queueing itself, which would otherwise freeze the
 * frame forever.
 */
const MAX_PASSES = 50;

let pending: Entry[] = [];
let inPhase = false;
let armed = false;
let trigger: ResizeObserver | null = null;

/**
 * A DOM without a layout engine (jsdom, which says so in its user agent) has
 * no frame to wait for and nothing a read could force: its reads run at once,
 * where they are queued — the synchronous measure a test asserts right after
 * render. Not a fallback: there is no "after layout" in such a document.
 */
const atOnce =
  typeof navigator !== "undefined" && navigator.userAgent.includes("jsdom");

/**
 * Run `read` once the browser has styled and laid out the current frame, and
 * before it paints — where layout facts are already computed, so reading them
 * costs nothing.
 *
 * Called from a layout effect, a ref callback or anywhere else on React's
 * commit path, a direct read (`getBoundingClientRect`, `getComputedStyle`,
 * `offsetWidth`…) forces the browser to recompute style and layout for the
 * whole dirty document right there, and again for the next read after any
 * write. Deferred here, every read of the frame runs in ONE batch after the
 * browser's own style/layout pass: reads first, then the writes they returned,
 * all inside one `flushSync`, so their React updates commit before paint (no
 * first-paint flash) and pay one incremental restyle together.
 *
 * The phase is a `ResizeObserver` delivery (the rendering step's one callback
 * point between layout and paint), armed by observing the root element afresh.
 * Readers mounted by the phase's own commit run in the same phase. Returns a
 * cancel (for an effect's cleanup).
 */
export function afterLayout(read: AfterLayoutRead): () => void {
  if (atOnce) {
    read()?.();
    return noop;
  }
  const entry: Entry = { read, live: true };
  pending.push(entry);
  if (!inPhase) arm();
  return () => {
    entry.live = false;
  };
}

/**
 * Run `fn` as part of the after-layout phase: a `ResizeObserver` callback
 * (element-size's) is already past layout, so reads queued by what it does —
 * a `flushSync` commit mounting new readers — run at its end, in the same
 * frame, rather than arming a fresh observation mid-delivery (which the browser
 * would defer to the next frame with a "loop completed" error).
 */
export function runAsAfterLayout(fn: () => void): void {
  if (inPhase) {
    fn();
    return;
  }
  inPhase = true;
  try {
    fn();
    drain();
  } finally {
    inPhase = false;
  }
}

function drain(): void {
  if (armed && trigger) {
    trigger.unobserve(document.documentElement);
    armed = false;
  }
  for (let pass = 0; pending.length > 0; pass++) {
    if (pass >= MAX_PASSES) {
      pending = [];
      throw new Error(
        `afterLayout: still queueing reads after ${MAX_PASSES} passes in one frame — a read re-queues itself through the commit it causes`,
      );
    }
    const batch = pending;
    pending = [];
    // One reader's throw must not cost every other reader of the frame its
    // measure: each runs on its own, and the failures are rethrown after the
    // batch has committed — loudly, as an uncaught error naming them all.
    const errors: unknown[] = [];
    const attempt = (fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        errors.push(err);
      }
    };
    flushSync(() => {
      const writes: (() => void)[] = [];
      for (const entry of batch) {
        if (!entry.live) continue;
        attempt(() => {
          const write = entry.read();
          if (write) writes.push(write);
        });
      }
      for (const write of writes) attempt(write);
    });
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "afterLayout: several reads threw");
  }
}

function arm(): void {
  if (armed) return;
  armed = true;
  trigger ??= new ResizeObserver(() => runAsAfterLayout(noop));
  // A new observation of a box with a size is delivered at the next rendering
  // step, after its layout: the root always has one.
  trigger.observe(document.documentElement);
}

function noop(): void {}
