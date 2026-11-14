/**
 * The look-ahead window, in audio-clock seconds: bars are written into the
 * audio graph while they start before `now + LOOK_AHEAD_SEC`, so a stalled
 * main thread never leaves a gap in the music.
 */
export const LOOK_AHEAD_SEC = 1.5;

/**
 * How long the pump sleeps between refills, in audio-clock seconds (a silent
 * source's `onended` wakes it — the audio clock drives it, never a timer).
 * Well under the look-ahead, so the window never runs dry.
 */
export const PUMP_SEC = 0.4;

/**
 * The bars to write now: starting at `next` (the start of the first bar not
 * yet written, audio-clock seconds) with bar index `bar`, every bar whose start
 * is before `now + horizon`, each `lengthOf(bar)` seconds long. Answers their
 * starts and the position after them. A lagging `next` (the context was
 * suspended, or the tab slept) is first moved up to `now`, so the bars that
 * were missed are skipped rather than burst out at once.
 */
export function barsDue(
  next: number,
  bar: number,
  now: number,
  horizon: number,
  lengthOf: (bar: number) => number,
): {
  readonly due: readonly { readonly at: number; readonly bar: number }[];
  readonly next: number;
  readonly bar: number;
} {
  let at = Math.max(next, now);
  let i = bar;
  const due: { at: number; bar: number }[] = [];
  while (at < now + horizon) {
    const len = lengthOf(i);
    if (!(len > 0)) throw new Error(`ambient: bar ${i} has length ${len}`);
    due.push({ at, bar: i });
    at += len;
    i++;
  }
  return { due, next: at, bar: i };
}
