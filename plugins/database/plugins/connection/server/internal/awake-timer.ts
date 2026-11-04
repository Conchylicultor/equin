// ---------------------------------------------------------------------------
// A deadline that counts only time the machine was awake.
//
// A timer keeps running while the machine sleeps: on wake, every timer whose
// time passed during the nap fires at once. `performance.now()` does not — it
// pauses with the machine (mach_absolute_time on macOS, CLOCK_MONOTONIC on
// Linux). So a call issued just before a laptop sleeps is declared "no reply"
// the moment it wakes, before the reply has had any chance to arrive.
//
// That is what wedged main on 2026-11-03: a usage-sync upsert was issued at
// 20:02, the machine slept until 20:18, the 60 s deadline fired on wake with
// 578 ms of awake time elapsed, and the connection was abandoned in the middle
// of its transaction — which Postgres then kept open, locks held, for five hours
// (connection's CLAUDE.md, "A sleep is not a silent connection").
//
// A sleep is not a silent connection. When the timer fires early by the awake
// clock, it re-arms for what remains, so the bound is `ms` of awake time.
// ---------------------------------------------------------------------------

/** The clock a deadline measures: pauses while the machine sleeps. */
export type AwakeClock = () => number;

const performanceClock: AwakeClock = () => performance.now();

/**
 * Call `onExpire` once `ms` of AWAKE time has passed since `startedAt` (a
 * reading of `now`). Returns the cancel; cancelling after expiry is a no-op.
 */
export function armAwakeDeadline(
  startedAt: number,
  ms: number,
  onExpire: () => void,
  now: AwakeClock = performanceClock,
): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const check = (): void => {
    const left = ms - (now() - startedAt);
    if (left > 0) timer = setTimeout(check, left);
    else onExpire();
  };
  timer = setTimeout(check, Math.max(0, ms - (now() - startedAt)));
  return () => clearTimeout(timer);
}
