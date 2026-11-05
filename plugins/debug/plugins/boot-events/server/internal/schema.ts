import { z } from "zod";

// Boot lines — two per boot since the `phase: "start"` cutover, plus an
// `exited` line for a boot whose process ended before its ready line. All values are
// ms epoch; `processStartedAt` is Math.round(performance.timeOrigin) (process
// start), the pairing key between a boot's start and ready lines. `sampledAt`
// mirrors the health-sample convention (== the line's write time).
//
// `start` is written as the serving process starts — before its plugin
// imports, migrations and any `onReadyBlocking` work — so a backend that
// wedges (or is killed) mid-boot still left a mark. `ready` is written when `onReady` reaches
// this plugin (post-onReadyBlocking readiness). `exited` is written from the
// process's `exit` event when it fires before `ready` — a boot that threw (a
// failed migration, a boot assert) — so the reader can tell a crashed boot
// from a wedged one; a process killed by a signal writes none and stays
// "never ready". Pre-cutover lines carry no `phase` and parse as ready lines
// (the union's last arm).
//
// `dead` is the one line another process writes: the boot watchdog, when the
// gateway — the only witness of whether the process still runs — shows a
// never-ready boot's process is gone (killed at its readiness deadline, or
// replaced by a later boot). A SIGKILL writes nothing, so without it a killed
// boot stayed open forever: an eternal timeline bar, an unsettled mark read
// every minute, and a report re-filed on every main restart. `deadBy` is when
// it was known dead (the superseding boot's start, else the watchdog's
// observation) — an upper bound, not the kill instant. It is also the
// watchdog's record that the boot was reported, so it is reported once,
// across restarts. A later `ready` line for the same boot still wins.
export const BootLineSchema = z.union([
  z.object({
    sampledAt: z.number(),
    worktree: z.string(),
    processStartedAt: z.number(),
    phase: z.literal("start"),
  }),
  z.object({
    sampledAt: z.number(),
    worktree: z.string(),
    processStartedAt: z.number(),
    exitedAt: z.number(),
    phase: z.literal("exited"),
  }),
  z.object({
    sampledAt: z.number(),
    worktree: z.string(),
    processStartedAt: z.number(),
    deadBy: z.number(),
    phase: z.literal("dead"),
  }),
  z.object({
    sampledAt: z.number(),
    worktree: z.string(),
    processStartedAt: z.number(),
    readyAt: z.number(),
    phase: z.literal("ready").optional(),
  }),
]);

export type BootLine = z.infer<typeof BootLineSchema>;

/**
 * One boot, as read back: the start/ready lines paired by `processStartedAt`.
 * `readyAt: null` = the backend never became ready. `exitedAt` set = its
 * process exited before ready (a boot crash — the error is on its stderr, which
 * the build that spawned it prints); null = wedged or killed mid-boot, or still
 * booting right now. `deadBy` set = its process is known gone without a line
 * of its own (a signal kill the boot watchdog witnessed through the gateway),
 * by that instant: the boot is settled, and was reported. For a never-ready boot,
 * `supersededAtMs` is the next boot attempt's start time when one exists
 * (bounding the failed attempt) and null while the attempt is the latest
 * (rendered open-ended: possibly still booting, possibly wedged NOW).
 */
export interface BootEvent {
  worktree: string;
  processStartedAt: number;
  readyAt: number | null;
  exitedAt: number | null;
  deadBy: number | null;
  supersededAtMs: number | null;
}
