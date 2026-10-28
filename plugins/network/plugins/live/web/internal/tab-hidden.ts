// The latency samples' hidden-tab rule, on the op stamps' clock
// (`performance.now()`): a background tab's timers and network callbacks are
// throttled, so a confirm timed across a hidden stretch measures the browser,
// not the system — the sample is tagged `hidden` and consumers exclude it.

// The latest visibility change, either way. Any change after a start stamp
// means the tab was hidden at some point since: one side of every change is
// `hidden`.
let lastVisibilityChangeAt = Number.NEGATIVE_INFINITY;

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    lastVisibilityChangeAt = performance.now();
  });
}

/** Is the tab hidden now, or was it hidden at any point since `start` (`performance.now()`)? */
export function hiddenSince(start: number): boolean {
  return (
    document.visibilityState === "hidden" || lastVisibilityChangeAt >= start
  );
}
