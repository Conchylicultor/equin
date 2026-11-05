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
 * booting right now. For a never-ready boot,
 * `supersededAtMs` is the next boot attempt's start time when one exists
 * (bounding the failed attempt) and null while the attempt is the latest
 * (rendered open-ended: possibly still booting, possibly wedged NOW).
 */
export interface BootEvent {
  worktree: string;
  processStartedAt: number;
  readyAt: number | null;
  exitedAt: number | null;
  supersededAtMs: number | null;
}
