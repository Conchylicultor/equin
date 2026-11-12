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
 *
 * A write made before the watch was armed is not the watch's lag: nothing
 * was listening yet. A fresh native watch hears such a write only when the
 * OS still held it queued at arming (a backlogged fseventsd hands its queue to
 * a new stream; a healthy one hands nothing older than the stream) — so after
 * a backend restart a write from minutes before can arrive seconds after the
 * new process armed, and its whole age used to read as delivery delay. The
 * window `writtenAt → arrivedAt` is split in three, which sum to it exactly:
 * - `beforeStartMs` — the write predates this backend process (it was down,
 *   or still the previous one): neither the watch's nor this boot's;
 * - `armMs` — backend start (or the write, if later) → the watch began arming:
 *   the boot's time to arm, the stale window a slow boot leaves;
 * - `lagMs` — arming → arrival: the delivery delay after arming, the watch's
 *   own. A write made while it was arming counts here in full (when the native
 *   stream really started inside the subscribe is unknown): over, never under.
 */
export interface DeliveryLagSample {
  /** The path the lag was read on (one per sampled batch). */
  path: string;
  /** The write's inode change time (epoch ms). */
  writtenAt: number;
  /** When the batch arrived (epoch ms). */
  arrivedAt: number;
  /** Delivery delay after arming: `max(writtenAt, armedAt) → arrivedAt`. */
  lagMs: number;
  /**
   * Present when the write predates the watch's arming: the part of its
   * staleness before it (see the module doc). Absent: `lagMs` is the whole.
   */
  beforeArm?: { beforeStartMs: number; armMs: number };
}

/**
 * Split one write's `writtenAt → arrivedAt` at the backend's start and the
 * watch's arming (see {@link DeliveryLagSample}). Pure: the three parts sum
 * to `arrivedAt − writtenAt`.
 */
export function splitDeliveryLag(
  path: string,
  writtenAt: number,
  arrivedAt: number,
  times: { startedAt: number; armedAt: number },
): DeliveryLagSample {
  // A watch is never armed before its process started.
  const armedAt = Math.max(times.armedAt, times.startedAt);
  if (writtenAt >= armedAt)
    return { path, writtenAt, arrivedAt, lagMs: arrivedAt - writtenAt };
  // An arrival before `armedAt` cannot come from a watch armed then; guarded
  // so no part goes negative.
  const heardFrom = Math.min(armedAt, arrivedAt);
  const beforeStartMs = Math.max(
    0,
    Math.min(times.startedAt, heardFrom) - writtenAt,
  );
  return {
    path,
    writtenAt,
    arrivedAt,
    lagMs: arrivedAt - heardFrom,
    beforeArm: {
      beforeStartMs,
      armMs: heardFrom - writtenAt - beforeStartMs,
    },
  };
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
   * When this backend process started (epoch ms — `performance.timeOrigin`):
   * a write older than it was made before the process could watch anything.
   */
  startedAt: number;
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
 * `intervalMs`, and hands each measured lag to `onSample`, split at the
 * process's start and `armedAt` — when this watch instance began arming
 * (epoch ms, see {@link splitDeliveryLag}).
 */
export function createDeliveryLagProbe(
  host: DeliveryLagHost,
  armedAt: number,
  onSample: (sample: DeliveryLagSample) => void,
  intervalMs = DELIVERY_PROBE_INTERVAL_MS,
): (events: readonly parcel.Event[], arrivedAt: number) => void {
  let lastProbeAt = -Infinity;
  let inFlight = false;

  async function measure(path: string, arrivedAt: number): Promise<void> {
    const ctimeMs = await host.ctimeOf(path);
    if (ctimeMs === null) return;
    if (ctimeMs > arrivedAt || host.wokeBetween(ctimeMs, arrivedAt)) return;
    onSample(
      splitDeliveryLag(path, ctimeMs, arrivedAt, {
        startedAt: host.startedAt,
        armedAt,
      }),
    );
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
