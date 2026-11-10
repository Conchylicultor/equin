/**
 * The bun:test loop heartbeat: how `./equin test` tells a test process whose
 * event loop STOPPED from one that is merely slow.
 *
 * Why it exists. bun enforces each test's timeout on the process's own event
 * loop, so a test whose JS thread is stuck in native code is never timed out:
 * on 2026-11-09 a file-watcher test's unsubscribe completion waited in
 * `~KqueueBackend` on a backend thread spinning in a corrupted hash table, and
 * the process — and the handed-off op that ran it, holding a host CPU slot —
 * sat there for 31 h until a human killed it. Nothing outside the process
 * could tell.
 *
 * Why the loop and not the wall clock. A wall-clock ceiling on an op misfired
 * under host duress and killed healthy builds
 * (research/2026-07-28-global-retire-op-wedge-watchdog.md). Duress slows a
 * turning loop by seconds; the loop turning at all is exactly what bun's own
 * per-test timeout depends on. So the preload (`test/bun-preload.ts`) stamps
 * the AWAKE clock into a file every {@link LOOP_HEARTBEAT_EVERY_MS} from an
 * unref'd timer, and the runner declares the run wedged once a stamp is
 * {@link LOOP_STOPPED_AFTER_MS} of awake time old. Awake time, so a machine
 * that slept with a run open is not a stopped loop.
 */

/** How often a bun:test process stamps its heartbeat. */
export const LOOP_HEARTBEAT_EVERY_MS = 30_000;

/**
 * How long the stamp may go unrefreshed, in awake time, before the run is
 * wedged: twenty missed beats. A test that blocks its own loop this long
 * (a synchronous loop) is broken in its own right — bun could not time it out
 * either.
 */
export const LOOP_STOPPED_AFTER_MS = 10 * 60_000;

/** The heartbeat file's content: the awake clock, in ms, when the loop last turned. */
export function formatLoopHeartbeat(awakeMs: number): string {
  return String(Math.round(awakeMs));
}

/** Parse a heartbeat file's content; throws on anything but what the writer writes. */
export function parseLoopHeartbeat(text: string): number {
  const ms = Number(text);
  if (text.trim() === "" || !Number.isFinite(ms)) {
    throw new Error(
      `malformed bun:test loop heartbeat: ${JSON.stringify(text)}`,
    );
  }
  return ms;
}
