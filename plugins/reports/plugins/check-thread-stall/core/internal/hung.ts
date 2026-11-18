import { z } from "zod";

/**
 * The hung-pass report kind, spelled once (see `CHECK_THREAD_STALL_KIND`): a
 * check pass whose main thread HELD its core without yielding once for
 * `HANG_HELD_MS`, so the runner's own watchdog thread killed it. Its own kind,
 * not a third `check-thread-stall` trigger: a stall is a slow pass (warning,
 * chronic), a hang is a pass that would never have finished (error, an
 * outage of whatever waited on it — a build, a push).
 */
export const CHECK_PASS_HUNG_KIND = "check-pass-hung";

/**
 * How long the check pass's main thread must hold its core — its OWN CPU
 * time, read from outside it — with not one timer run in between, before the
 * watchdog calls it hung. Held time, never wall time: a pass the OS starves
 * (background priority on a host under duress) accrues it only as fast as it
 * actually runs, so a slow pass is never judged hung, however long it takes.
 *
 * Five minutes is ~20× the longest stall a healthy pass has measured (~14 s,
 * the "Check pass speed" track), and the one observed hang (2026-11-18, a
 * native loop inside bun) held its core for 65 min.
 */
export const HANG_HELD_MS = 5 * 60_000;

/** The native stack of the hung thread, as the watchdog captured it. */
const NativeStackSchema = z.discriminatedUnion("captured", [
  z.object({
    captured: z.literal(true),
    /** The full capture on disk (macOS `sample` output: every thread). */
    file: z.string(),
    /** The main thread's call tree, its first lines — outermost first. */
    mainThread: z.array(z.string()),
  }),
  z.object({ captured: z.literal(false), reason: z.string() }),
]);

export const CheckPassHungPayloadSchema = z.object({
  /** The checkout the pass was checking. */
  worktree: z.string(),
  runId: z.string(),
  pid: z.number().int(),
  /** The run's transcript (`check-<runId>.log`), when the run writes one. */
  transcript: z.string().nullable(),
  /** The main thread's own CPU time since it last ran a timer. */
  heldMs: z.number(),
  /** Wall time since it last ran a timer — ≥ `heldMs`; the rest it was starved or blocked. */
  silentMs: z.number(),
  /** From the run's start to the verdict. */
  elapsedMs: z.number(),
  /** Checks started and never ended — read from the run's progress records. */
  running: z.array(z.string()),
  /** Bootstrap phases started and never ended. */
  bootstrap: z.array(z.string()),
  /** The last check the run started, or null when it started none. */
  lastStarted: z.string().nullable(),
  /** Checks that settled. */
  settled: z.number().int(),
  /** Checks selected, or null when the hang came before selection. */
  selected: z.number().int().nullable(),
  nativeStack: NativeStackSchema,
});
export type CheckPassHungPayload = z.infer<typeof CheckPassHungPayloadSchema>;

/**
 * One row for every hang: a pass that hangs is rare, and its cause so far was
 * the runtime, not a check — the row's count and each latest example say
 * whether it recurs, and where.
 */
export function checkPassHungFingerprint(_d: CheckPassHungPayload): string {
  return CHECK_PASS_HUNG_KIND;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * `check pass hung in att-… — its thread held 5.0 min without yielding,
 * 41 checks in flight (last started css:no-unanchored-has); killed`.
 */
export function checkPassHungMessage(d: CheckPassHungPayload): string {
  const where =
    d.bootstrap.length > 0
      ? `in bootstrap (${d.bootstrap.join(", ")})`
      : `${d.running.length} check${d.running.length === 1 ? "" : "s"} in flight` +
        (d.lastStarted !== null ? ` (last started ${d.lastStarted})` : "");
  return (
    `check pass hung in ${d.worktree} — its thread held ${minutes(d.heldMs)} ` +
    `without yielding, ${where}; killed`
  );
}
