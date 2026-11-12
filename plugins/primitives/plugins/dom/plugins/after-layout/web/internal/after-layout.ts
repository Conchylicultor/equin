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
/**
 * The elements whose delivery opened the current phase (the root for the
 * trigger's), or null outside a phase. Their shallowest depth bounds what this
 * rendering step can still deliver — see {@link observeInPhase}. Kept as the
 * elements, and walked only when an observation is started, so a delivery that
 * starts none pays nothing.
 */
let phaseDelivered: readonly Element[] | null = null;
let phaseDepth: number | null = null;
let armed = false;
let trigger: ResizeObserver | null = null;

/** One observation started through {@link observeInPhase}. */
interface Observation {
  observer: ResizeObserver;
  el: Element;
  /** The observer's response to a resize, run in the phase that caused it when
   * the browser could no longer deliver it there (see {@link settle}). */
  onHeldBack: (() => void) | undefined;
  /** The animation frame that (re)starts it, while one is pending. */
  frame: number | null;
  released: boolean;
}

/** Every live observation of the app's observers — all of them start here
 * (`no-raw-resize-observer`), so this is the whole set the browser's
 * depth rule can hold back. */
const observations = new Set<Observation>();

/**
 * The box of every observation at or above the running phase's delivery, as it
 * was before the phase's first commit — taken lazily by {@link commitInPhase},
 * so a phase that commits nothing reads nothing. Compared when the phase ends.
 */
let snapshot: Map<Observation, Box> | null = null;

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
export function runAsAfterLayout(
  fn: () => void,
  delivered: readonly Element[],
): void {
  if (inPhase) {
    fn();
    return;
  }
  inPhase = true;
  phaseDelivered = delivered;
  phaseDepth = null;
  try {
    fn();
    drain();
    settle();
  } finally {
    inPhase = false;
    phaseDelivered = null;
    phaseDepth = null;
    snapshot = null;
  }
}

/**
 * Commit React updates (`flushSync`) as part of the phase: the one way an
 * observer callback, or a read the phase drains, commits before paint.
 *
 * A commit inside a delivery can resize any element — the chrome above the
 * measured box, a fixed band, the box itself. The browser delivers, in this
 * rendering step, only resizes of elements DEEPER than the delivery's
 * shallowest target; anything at or above it would be held back to the next
 * frame, painted stale meanwhile, and reported as "ResizeObserver loop
 * completed with undelivered notifications". So before the phase's first
 * commit, the box of every observation at or above the delivery is recorded;
 * when the phase ends, every one the phase resized is answered in the phase
 * itself (its observer's `onHeldBack`, which may commit in turn) and its
 * browser observation restarted at the next frame, where it can be delivered —
 * nothing is left for the browser to hold back. Outside a phase (an ordinary
 * React commit, before layout) it is a plain `flushSync`.
 */
export function commitInPhase(update: () => void): void {
  if (inPhase && snapshot === null) snapshot = shallowBoxes();
  flushSync(update);
}

/**
 * Start observing `el`, where the browser can deliver its notifications, and
 * keep it there. Returns the release (unobserves, cancels a pending start) —
 * call it instead of `unobserve`, so the observation leaves the phase's set.
 *
 * Inside a phase, the rendering step is mid-delivery: the browser delivers a
 * new observation in this step only when its target is DEEPER than the
 * shallowest element of the broadcast running now; a shallower one (a portal
 * at the body, a fixed band) is held back to the next frame and the step ends
 * with "ResizeObserver loop completed with undelivered notifications". Such a
 * target is observed at the start of the next frame instead (an animation
 * frame callback runs before that frame's observers are gathered), so its first
 * notification arrives exactly when the browser would have delivered it — with
 * no loop. Every caller has already taken its first measure directly, so
 * nothing is late. Outside a phase, and for a deeper target, it observes now.
 *
 * `onHeldBack` is the observer's response to a resize of `el`, run when a
 * commit inside a phase resizes `el` at or above that phase's delivery — a
 * resize the browser could not deliver in this frame (see
 * {@link commitInPhase}). An observer whose response needs the browser's
 * entry passes none: its notification then comes with the restarted
 * observation, at the next frame.
 */
export function observeInPhase(
  observer: ResizeObserver,
  el: Element,
  onHeldBack?: () => void,
): () => void {
  const obs: Observation = {
    observer,
    el,
    onHeldBack,
    frame: null,
    released: false,
  };
  observations.add(obs);
  start(obs);
  return () => {
    obs.released = true;
    observations.delete(obs);
    if (obs.frame !== null) cancelAnimationFrame(obs.frame);
    obs.frame = null;
    observer.unobserve(el);
  };
}

function start(obs: Observation): void {
  if (phaseDelivered === null) {
    obs.observer.observe(obs.el);
    // Delivered in the next step's FIRST broadcast: armed with it, the root
    // trigger shares that broadcast, so its shallowest depth is the root's and
    // a callback committing there may change layout at any depth.
    if (!atOnce) arm();
    return;
  }
  if (depthOf(obs.el) > currentPhaseDepth()) {
    obs.observer.observe(obs.el);
    return;
  }
  startNextFrame(obs);
}

function startNextFrame(obs: Observation): void {
  if (obs.frame !== null) return;
  obs.frame = requestAnimationFrame(() => {
    obs.frame = null;
    if (!obs.released) start(obs);
  });
}

/** What the browser compares an observation by, read the same way before and
 * after a commit: the layout box (a transform cannot change between the two
 * reads — no animation advances inside one task) and the client box (a
 * scrollbar appearing narrows the content box without the border box). */
interface Box {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
}

function boxOf(el: Element): Box {
  const rect = el.getBoundingClientRect();
  return {
    width: rect.width,
    height: rect.height,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
  };
}

function sameBox(a: Box, b: Box): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.clientWidth === b.clientWidth &&
    a.clientHeight === b.clientHeight
  );
}

/** The box of every connected observation the running phase's delivery can no
 * longer reach: at or above its shallowest target. */
function shallowBoxes(): Map<Observation, Box> {
  const boxes = new Map<Observation, Box>();
  const depth = currentPhaseDepth();
  // The root's broadcast reaches every depth below it.
  if (depth === 0) return boxes;
  for (const obs of observations) {
    if (!obs.el.isConnected || depthOf(obs.el) > depth) continue;
    boxes.set(obs, boxOf(obs.el));
  }
  return boxes;
}

/**
 * Answer, in the phase, every resize its commits made where the browser can no
 * longer deliver it (see {@link commitInPhase}): the observation is stopped now
 * (so nothing is held back into a loop error) and restarted at the next frame,
 * and its observer's response runs here — before paint, as an in-time delivery
 * would have. That response may commit and resize more; it is settled the same
 * way, until nothing changes.
 */
function settle(): void {
  for (let pass = 0; snapshot !== null; pass++) {
    if (pass >= MAX_PASSES) {
      snapshot = null;
      throw new Error(
        `afterLayout: still resizing observed elements above the delivery after ${MAX_PASSES} passes in one frame — an observer's response keeps resizing what it observes`,
      );
    }
    const before = snapshot;
    snapshot = null;
    const resized: Observation[] = [];
    for (const [obs, box] of before) {
      if (obs.released || !obs.el.isConnected) continue;
      if (!sameBox(box, boxOf(obs.el))) resized.push(obs);
    }
    if (resized.length === 0) return;
    for (const obs of resized) {
      obs.observer.unobserve(obs.el);
      startNextFrame(obs);
    }
    for (const obs of resized) obs.onHeldBack?.();
    drain();
  }
}

function currentPhaseDepth(): number {
  if (phaseDepth === null) {
    let min = Infinity;
    for (const el of phaseDelivered ?? []) min = Math.min(min, depthOf(el));
    phaseDepth = min;
  }
  return phaseDepth;
}

/** The element's depth in the flat tree (the root is 0), shadow hosts included
 * — the measure the browser compares observations by. */
function depthOf(el: Element): number {
  let depth = 0;
  let node: Element | null = el;
  while (node !== null && node !== document.documentElement) {
    depth++;
    const parent: Element | null = node.parentElement;
    if (parent !== null) {
      node = parent;
      continue;
    }
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return depth;
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
    commitInPhase(() => {
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
  trigger ??= new ResizeObserver(() =>
    runAsAfterLayout(noop, [document.documentElement]),
  );
  // A new observation of a box with a size is delivered at the next rendering
  // step, after its layout: the root always has one.
  trigger.observe(document.documentElement);
}

function noop(): void {}
