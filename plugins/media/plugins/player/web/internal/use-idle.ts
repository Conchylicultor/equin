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
  /** The pointer left the player, or a tap asked: fade now, unless something holds the controls up. */
  rest(): void;
}

export interface IdleOptions {
  /** Something holds the controls up — a panel open, the seek bar dragged: nothing fades them, not even `rest()`. */
  keepUp: boolean;
  /** No quiet-spell timer, but `rest()` still fades them (touch, paused: a tap hides, time never does). */
  noTimer?: boolean;
  /** False: never fade (an audio bar has no picture to clear). */
  enabled: boolean;
  /** The quiet spell before the fade (`IDLE_MS` by default). */
  quietMs?: number;
}

/**
 * The controls' idle fade: they go after `quietMs` of a resting pointer, but
 * never while `keepUp`, never on a timer while `noTimer`, and never when
 * `enabled` is false.
 *
 * The quiet spell is a one-shot timer re-armed by every wake, not a poll: the
 * pointer moving IS the change signal. A wake is cheap — no render unless the
 * controls were actually faded.
 */
export function useIdle({
  keepUp,
  noTimer = false,
  enabled,
  quietMs = IDLE_MS,
}: IdleOptions): Idle {
  const [asleep, setAsleep] = useState(false);
  // A change of what holds the controls up is itself a wake: playing again
  // after a pause shows the controls for a full spell, never already faded,
  // and pausing brings them back.
  // (Adjusted during render — React's pattern for state that follows a value.)
  const held = keepUp || !enabled;
  const untimed = held || noTimer;
  const [wasUntimed, setWasUntimed] = useState(untimed);
  if (wasUntimed !== untimed) {
    setWasUntimed(untimed);
    setAsleep(false);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hold = useLatestRef(held);
  const noArm = useLatestRef(untimed);

  const arm = useEventCallback(() => {
    clearTimeout(timer.current);
    if (!noArm.current)
      timer.current = setTimeout(() => setAsleep(true), quietMs);
  });

  // Every change of what holds the controls up restarts the quiet spell: a
  // panel closing or play starting gives the pointer its full spell.
  useEffect(() => {
    arm();
    return () => clearTimeout(timer.current);
  }, [arm, untimed]);

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
