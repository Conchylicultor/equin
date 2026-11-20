import { onMirrorLogAdvanced } from "@plugins/database/plugins/table-mirror/plugins/source/server";
import {
  MIRROR_SIGNAL_THROTTLE_MS,
  type MirrorBoxSignal,
} from "@plugins/apps/plugins/deploy/plugins/site-mirror/core";

/** The timers a throttle runs on — injected so a test drives them. */
export interface ThrottleClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * At most one `fire(key)` per key per `intervalMs`: the first ring of a quiet
 * key fires at once; rings inside the interval fold into ONE trailing fire at
 * its end — so the last change is always signalled, never dropped.
 * `dispose()` cancels every pending trailing fire.
 */
export function createKeyedThrottle(
  intervalMs: number,
  fire: (key: string) => void,
  clock: ThrottleClock = realClock,
): { ring(key: string): void; dispose(): void } {
  const lastFiredAt = new Map<string, number>();
  const pending = new Map<string, unknown>();
  function fireNow(key: string): void {
    lastFiredAt.set(key, clock.now());
    fire(key);
  }
  return {
    ring(key) {
      if (pending.has(key)) return;
      const last = lastFiredAt.get(key);
      const wait = last === undefined ? 0 : last + intervalMs - clock.now();
      if (wait <= 0) {
        fireNow(key);
        return;
      }
      pending.set(
        key,
        clock.setTimeout(() => {
          pending.delete(key);
          fireNow(key);
        }, wait),
      );
    },
    dispose() {
      for (const handle of pending.values()) clock.clearTimeout(handle);
      pending.clear();
    },
  };
}

/**
 * The `table-mirror` box signal: `{ setId }` whenever a mirror set's source
 * log advanced (table-mirror/source's NOTIFY), throttled per set to one ring
 * per {@link MIRROR_SIGNAL_THROTTLE_MS}. Resolves once the LISTEN is active.
 */
export async function subscribeMirrorSignal(
  emit: (payload: MirrorBoxSignal) => void,
): Promise<() => void> {
  const throttle = createKeyedThrottle(MIRROR_SIGNAL_THROTTLE_MS, (setId) =>
    emit({ setId }),
  );
  const unsubscribe = await onMirrorLogAdvanced((setId) =>
    throttle.ring(setId),
  );
  return () => {
    unsubscribe();
    throttle.dispose();
  };
}
