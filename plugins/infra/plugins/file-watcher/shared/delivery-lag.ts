import type * as parcel from "@parcel/watcher";

/**
 * How late a watch heard a write: the changed path's inode change time
 * (`ctime`) → the moment the native watch handed the batch over.
 *
 * `ctime`, not `mtime`: a file moved in, extracted or `touch -t`'d keeps an
 * old mtime, which would read as hours of lag; ctime is set by the kernel on
 * every change (write, rename, metadata) and cannot be set back. A path
 * changed again after it was heard has a ctime past the arrival — that batch
 * says nothing and is skipped, never counted as 0. A path rewritten between
 * the write that was heard and its arrival reads as LESS lag than it had:
 * the measure under-reports, never over.
 */
export interface DeliveryLagSample {
  /** The path the lag was read on (one per sampled batch). */
  path: string;
  lagMs: number;
  /** When the batch arrived (epoch ms). */
  arrivedAt: number;
}

/**
 * At most one sample per declaration this often. The lag is the OS's
 * (fseventsd's queue, which holds every stream at once), so a sample every
 * few seconds tracks it; a stat per batch on a watcher dispatching every line
 * of a transcript would cost more than it tells.
 */
export const DELIVERY_PROBE_INTERVAL_MS = 5_000;

/**
 * A path's inode change time (epoch ms), or null when it cannot be read — it
 * went, or this account may not stat it, between its event and the probe.
 * Throws on anything else. The host's (`FileWatcherRuntime.ctimeOf`): this
 * module runs on every host and reaches no filesystem itself.
 */
export type CtimeOf = (path: string) => Promise<number | null>;

/** What the probe reads off its host (the engine's: timed-fs, sleep-clock). */
export interface DeliveryLagHost {
  ctimeOf: CtimeOf;
  /**
   * Whether the machine woke between `from` and `to` (epoch ms): a write
   * made before a sleep is heard after the wake, and the nap is not the
   * watch's lag — such a sample is skipped.
   */
  wokeBetween: (from: number, to: number) => boolean;
}

/**
 * The probe a watcher hands its engine's `onArrival`: samples the newest
 * created or updated path of a batch, at most one at a time and one per
 * `intervalMs`, and hands each measured lag to `onSample`.
 */
export function createDeliveryLagProbe(
  host: DeliveryLagHost,
  onSample: (sample: DeliveryLagSample) => void,
  intervalMs = DELIVERY_PROBE_INTERVAL_MS,
): (events: readonly parcel.Event[], arrivedAt: number) => void {
  let lastProbeAt = -Infinity;
  let inFlight = false;

  async function measure(path: string, arrivedAt: number): Promise<void> {
    const ctimeMs = await host.ctimeOf(path);
    if (ctimeMs === null) return;
    const lagMs = arrivedAt - ctimeMs;
    if (lagMs < 0 || host.wokeBetween(ctimeMs, arrivedAt)) return;
    onSample({ path, lagMs, arrivedAt });
  }

  return (events, arrivedAt) => {
    if (inFlight || arrivedAt - lastProbeAt < intervalMs) return;
    let path: string | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type !== "delete") {
        path = e.path;
        break;
      }
    }
    if (path === undefined) return;
    lastProbeAt = arrivedAt;
    inFlight = true;
    // Fire-and-forget off the watch's callback; an unexpected stat failure
    // rejects into an unhandled rejection, which is filed.
    void measure(path, arrivedAt).finally(() => {
      inFlight = false;
    });
  };
}
