import { useEffect, useRef, useState } from "react";
import {
  useEventCallback,
  useLatestRef,
} from "@plugins/primitives/plugins/latest-ref/web";
import { IDLE_MS } from "./geometry";

export interface Idle {
  /** The controls are faded out (and the cursor hidden). */
  idle: boolean;
  /** Something happened (the pointer moved, a key, a click): controls up, the quiet spell restarts. */
  wake(): void;
  /** The pointer left the player: fade now, unless something holds the controls up. */
  rest(): void;
}

/**
 * The controls' idle fade: they go after `IDLE_MS` of a resting pointer, but
 * never while `keepUp` — a panel open, the seek bar dragged — and
 * never when `enabled` is false (an audio bar has no picture to clear).
 *
 * The quiet spell is a one-shot timer re-armed by every wake, not a poll: the
 * pointer moving IS the change signal. A wake is cheap — no render unless the
 * controls were actually faded.
 */
export function useIdle(keepUp: boolean, enabled: boolean): Idle {
  const [asleep, setAsleep] = useState(false);
  // A change of what holds the controls up is itself a wake: playing again
  // after a pause shows the controls for a full spell, never already faded.
  // (Adjusted during render — React's pattern for state that follows a value.)
  const held = keepUp || !enabled;
  const [wasHeld, setWasHeld] = useState(held);
  if (wasHeld !== held) {
    setWasHeld(held);
    setAsleep(false);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hold = useLatestRef(held);

  const arm = useEventCallback(() => {
    clearTimeout(timer.current);
    if (!hold.current)
      timer.current = setTimeout(() => setAsleep(true), IDLE_MS);
  });

  // Every change of what holds the controls up restarts the quiet spell: a
  // panel closing or play starting gives the pointer its full two seconds.
  useEffect(() => {
    arm();
    return () => clearTimeout(timer.current);
  }, [arm, held]);

  const wake = useEventCallback(() => {
    setAsleep(false);
    arm();
  });

  const rest = useEventCallback(() => {
    if (hold.current) return;
    clearTimeout(timer.current);
    setAsleep(true);
  });

  return { idle: enabled && !keepUp && asleep, wake, rest };
}
