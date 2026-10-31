import { coveredMs, pushBounded, type Interval } from "./intervals";

// The page's pauses on the wall clock (epoch ms), recorded from module load:
//
// - HIDDEN: from a `visibilitychange` to hidden (or a Page Lifecycle `freeze`)
//   until the page is visible (or `resume`d) again. A background tab's timers,
//   frames and network callbacks are throttled, so the time a span spent in
//   one measures the browser, not the system.
// - STALLED: a long animation frame of at least `STALL_MIN_MS` — a main thread
//   frozen that long is reported on its own by `reports/main-thread-stall`
//   (its `SLOW_OP_MIN_MS`, which must agree with this), so a span that merely
//   sat behind it is not slow itself.
//
// Rings are bounded (`RING_CAP` each): a consumer asks about a span that just
// ended, never about one older than a few hundred pauses.

/** Agrees with main-thread-stall's `STALL.SLOW_OP_MIN_MS`. */
export const STALL_MIN_MS = 1000;
const RING_CAP = 100;
// The Long Animation Frames API (Chrome 123+); the Long Tasks API where it is
// missing. Neither ⇒ stalls are unknown and count as 0 (documented).
const LOAF = "long-animation-frame";
const LONGTASK = "longtask";

const hidden: Interval[] = [];
const stalls: Interval[] = [];
/** Start of the hidden stretch in progress, or null while visible. */
let hiddenSince: number | null = null;

function beginHidden(): void {
  if (hiddenSince === null) hiddenSince = Date.now();
}

function endHidden(): void {
  if (hiddenSince === null) return;
  pushBounded(hidden, { startMs: hiddenSince, endMs: Date.now() }, RING_CAP);
  hiddenSince = null;
}

function observeStalls(): void {
  if (typeof PerformanceObserver === "undefined") return;
  const supported = PerformanceObserver.supportedEntryTypes;
  const type = supported.includes(LOAF)
    ? LOAF
    : supported.includes(LONGTASK)
      ? LONGTASK
      : null;
  if (type === null) return;
  new PerformanceObserver((list) => {
    // Entry times are on the performance clock: place them on the wall clock
    // from the same instant read on both clocks, now — the entry is delivered
    // just after its frame, so no sleep can sit between the two.
    const wallMinusPerf = Date.now() - performance.now();
    for (const e of list.getEntries()) {
      if (e.duration < STALL_MIN_MS) continue;
      const startMs = wallMinusPerf + e.startTime;
      pushBounded(stalls, { startMs, endMs: startMs + e.duration }, RING_CAP);
    }
  }).observe({ type, buffered: true });
}

if (typeof document !== "undefined") {
  // A page loaded in the background has been hidden since it started.
  if (document.visibilityState === "hidden")
    hiddenSince = performance.timeOrigin;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") beginHidden();
    else endHidden();
  });
  document.addEventListener("freeze", beginHidden);
  document.addEventListener("resume", () => {
    if (document.visibilityState !== "hidden") endHidden();
  });
  observeStalls();
}

/** How the page was paused during one span of wall-clock time. */
export interface PagePauses {
  /**
   * ms of the span the page was hidden or frozen (union; a stretch still in
   * progress counts from its start to the span's end). That time measures the
   * browser's throttling, not the system, so a consumer takes it off.
   */
  hiddenMs: number;
  /**
   * ms of the span the main thread spent in stalls ≥ `STALL_MIN_MS`, outside
   * the hidden time (union) — disjoint from `hiddenMs`, so the two add up to
   * the span's whole paused time.
   */
  stalledMs: number;
}

/**
 * The page's pauses inside `[startMs, endMs]` (epoch ms). Ask right after the
 * span ends — ideally a beat later, since a long frame's entry is delivered
 * after the frame (the slow-op queue asks at its flush, ~250 ms on).
 */
export function pausesDuring(startMs: number, endMs: number): PagePauses {
  const hiddenNow: Interval[] =
    hiddenSince === null
      ? hidden
      : [...hidden, { startMs: hiddenSince, endMs }];
  const hiddenMs = coveredMs(hiddenNow, startMs, endMs);
  return {
    hiddenMs,
    stalledMs: coveredMs([...hiddenNow, ...stalls], startMs, endMs) - hiddenMs,
  };
}
