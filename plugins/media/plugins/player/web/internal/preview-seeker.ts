/**
 * What the preview seeker drives: the slice of an `HTMLMediaElement` it
 * reads and writes, so the coalescing is testable without a media stack.
 */
export interface Seekable {
  readyState: number;
  currentTime: number;
  addEventListener(type: "seeked" | "loadedmetadata", fn: () => void): void;
  removeEventListener(type: "seeked" | "loadedmetadata", fn: () => void): void;
}

/**
 * Seeks a preview element to wherever the pointer is now, one seek at a
 * time: a target that lands while a seek is in flight replaces any waiting
 * one and is issued on that seek's `seeked` — so a fast scrub decodes the
 * latest frame, never a queue of stale ones. A target set before the
 * element has its metadata waits for `loadedmetadata` (setting
 * `currentTime` then only moves the start position, no `seeked` follows).
 * `dispose()` detaches it.
 */
export function createPreviewSeeker(el: Seekable) {
  let inFlight = false;
  let pending: number | null = null;

  const issue = (t: number) => {
    inFlight = true;
    el.currentTime = t;
  };
  const next = () => {
    inFlight = false;
    if (pending === null || el.readyState === 0) return;
    const t = pending;
    pending = null;
    issue(t);
  };
  el.addEventListener("seeked", next);
  el.addEventListener("loadedmetadata", next);

  return {
    seek(t: number) {
      if (inFlight || el.readyState === 0) pending = t;
      else issue(t);
    },
    dispose() {
      el.removeEventListener("seeked", next);
      el.removeEventListener("loadedmetadata", next);
    },
  };
}
