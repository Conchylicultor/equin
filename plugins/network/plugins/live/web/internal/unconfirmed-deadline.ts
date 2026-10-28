// The UNCONFIRMED deadline: a predicted write that has not confirmed within a
// deadline files a CENSORED `confirm` latency sample.
//
// The `confirm` signal is emitted when a write confirms — so a write that NEVER
// confirms (the server froze, the push never came, the response never came)
// emits nothing, and the slowest case of all is the one no consumer sees. One
// one-shot timer per op closes that: armed at dispatch, cleared when the op
// confirms or is rejected, it fires at most once and hands `clientLatencySink`
// a censored sample — the phases the op reached so far, `totalMs` the time
// elapsed — which `debug/slow-ops` files like any slow confirm.
//
// It is a DEADLINE, not a poll: nothing is re-checked; the timer either is
// cleared or fires once (precedent: health's wedge watchdog). Shared by every
// prediction system (`optimistic-mutation`'s overlay, the predicted endpoint
// effects), so they time out the same way.

import {
  clientLatencySink,
  type CensoredLatencySample,
} from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";

/** How long a predicted write may stay unconfirmed before it is reported. */
export const UNCONFIRMED_MS = 10_000;

/** A censored `confirm` sample — what an expired deadline emits. */
export type UnconfirmedSample = Extract<
  CensoredLatencySample,
  { signal: "confirm" }
>;

/** One armed deadline. `clear()` is idempotent, and a no-op once it fired. */
export interface UnconfirmedDeadline {
  clear(): void;
}

export interface UnconfirmedDeadlineOptions {
  /** Defaults to `UNCONFIRMED_MS`. */
  deadlineMs?: number;
  /**
   * Builds the censored sample AT expiry, so it carries the phases the op had
   * reached by then (a resolve that landed after dispatch included). Called at
   * most once, and only when the sink has a subscriber.
   */
  sample: () => UnconfirmedSample;
}

/**
 * Arm one op's deadline. Clear it on confirmation, on a permanent rejection,
 * and when the op's owner goes away (an unmounted reader reports nothing: it no
 * longer knows whether the write confirms).
 */
export function armUnconfirmedDeadline({
  deadlineMs = UNCONFIRMED_MS,
  sample,
}: UnconfirmedDeadlineOptions): UnconfirmedDeadline {
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    if (clientLatencySink.hasSubscribers()) clientLatencySink.emit(sample());
  }, deadlineMs);
  return {
    clear() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}
