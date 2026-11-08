import type { AcquireHooks } from "@plugins/packages/plugins/host-semaphore/server";
import { gateWaitHooks } from "@plugins/infra/plugins/runtime-profiler/core";

/**
 * Run one host-pool acquire with its wait metered under `layer`: shown on the
 * waiter's open spans from the moment it takes the slow path
 * (`onWaitStart`), charged at acquisition (`onAcquired`, fast path included,
 * ≈0), and no longer shown once a cancelled acquire unwinds (it never reaches
 * `onAcquired`). The caller's own hooks still fire, after the profiler's.
 *
 * Why the pool and not its callers: a wait charged only at its end reads,
 * while it lasts, as the waiter's own work — a span queued minutes on a flock
 * pool was what the stuck-span watchdog blamed. With the pool wiring it, a
 * pool wait that is never shown, or never charged, has no spelling.
 */
export function meterAcquire<T>(
  layer: string,
  hooks: AcquireHooks | undefined,
  acquire: (hooks: AcquireHooks) => Promise<T>,
): Promise<T> {
  const wait = gateWaitHooks(layer);
  let queued: (() => void) | undefined;
  const unqueue = (): void => {
    queued?.();
    queued = undefined;
  };
  return acquire({
    ...hooks,
    onWaitStart: () => {
      queued = wait.onQueued();
      hooks?.onWaitStart?.();
    },
    onAcquired: (waitMs) => {
      unqueue();
      wait.onWait(waitMs);
      hooks?.onAcquired?.(waitMs);
    },
  }).finally(unqueue);
}
