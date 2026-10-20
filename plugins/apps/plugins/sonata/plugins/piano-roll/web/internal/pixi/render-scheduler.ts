/**
 * RenderScheduler — render-on-demand for the Pixi app.
 *
 * The app's ticker does NOT free-run: it is created stopped (`autoStart:
 * false`) and this scheduler starts it only while something can still change
 * the picture, then stops it once everything has settled. An idle, paused
 * roll therefore costs zero frames (a free-running software-WebGL canvas burned
 * 1–5 cores per idle tab).
 *
 * Two ways to keep frames coming, both declared rather than implied:
 *  - {@link RenderScheduler.request} — "something changed, draw it". One-shot:
 *    the frame it wakes is drawn, the loop lingers ONE more frame (so a request
 *    per frame, i.e. playback, stays on a single continuous ticker run with true
 *    deltas rather than a stop/start per frame), then stops unless held. Every scene mutator (scroll, resize, score, look, theme, …)
 *    requests; a playing cursor requests on every advance so the loop runs.
 *  - {@link RenderScheduler.onFrame} — a per-frame updater (an FX effect) that
 *    RETURNS whether it is still animating. The loop stays alive exactly while
 *    any updater returns true. The boolean is the return type, so an updater
 *    cannot forget to answer — and cannot keep the loop alive by accident: a
 *    registered-but-idle updater returns false.
 *
 * Updaters run before Pixi's own render callback (UPDATE_PRIORITY.LOW) inside
 * the same tick, and the ticker is stopped from within that tick — Pixi still
 * renders the frame in flight, so the last animated frame is always drawn.
 */

/** The slice of Pixi's Ticker this needs (a fake in tests). */
export interface SchedulerTicker {
  started: boolean;
  deltaMS: number;
  add(fn: () => void, context: unknown, priority: number): unknown;
  remove(fn: () => void, context: unknown): unknown;
  start(): void;
  stop(): void;
}

/** Runs before Pixi's render (priority LOW = -25) in the same tick. */
const UPDATE_PRIORITY_NORMAL = 0;

export interface RenderScheduler {
  /** Something changed — draw a frame (starts the loop if it is stopped). */
  request(): void;
  /**
   * Register a per-frame updater. Called with the frame's delta in seconds
   * while the loop runs; return true while it still needs further frames
   * (particles alive, a fade running), false once it has settled. Returns the
   * unregister function. Registering does NOT request a frame — an effect wakes
   * the loop by the event that gives it something to animate (the scene
   * requests on every note-on and reset).
   */
  onFrame(update: (dtSec: number) => boolean): () => void;
  /** Permanently stop (context loss / teardown): later requests are ignored. */
  halt(): void;
}

export function createRenderScheduler(
  ticker: SchedulerTicker,
): RenderScheduler {
  const updaters = new Set<(dtSec: number) => boolean>();
  let dirty = false;
  let halted = false;

  const tick = (): void => {
    const dt = ticker.deltaMS / 1000;
    let animating = false;
    // Every updater runs every frame (no short-circuit): each one advances its
    // own simulation. Snapshot so an updater may unregister itself mid-frame.
    for (const update of [...updaters]) {
      if (update(dt)) animating = true;
    }
    const keep = animating || dirty;
    dirty = false;
    if (!keep) ticker.stop();
  };
  ticker.add(tick, null, UPDATE_PRIORITY_NORMAL);

  return {
    request() {
      if (halted) return;
      dirty = true;
      if (!ticker.started) ticker.start();
    },
    onFrame(update) {
      updaters.add(update);
      return () => {
        updaters.delete(update);
      };
    },
    halt() {
      halted = true;
      dirty = false;
      ticker.stop();
      ticker.remove(tick, null);
    },
  };
}
