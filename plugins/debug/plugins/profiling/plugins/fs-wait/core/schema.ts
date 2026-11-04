import { z } from "zod";

/** The log channel every process writes its slow file calls to. */
export const FS_WAIT_CHANNEL = "fs-wait";

const Common = {
  /** `backend` (serve), `exec`, or `cli <verb>`. */
  process: z.string(),
  pid: z.number(),
};

/**
 * One line of `<namespace logs>/fs-wait.jsonl` (the `line` of a log-channel
 * envelope). Slow calls that overlap in time are one EPISODE — a check
 * reading thousands of files at once is one, not thousands of lines:
 *
 * - `call` — the first slow call of an episode, written as it returns, so a
 *   process killed mid-stall still left it;
 * - `episode` — written when an episode of more than one call closes (the
 *   next slow call does not overlap it, or the process exits).
 *
 * Times are wall-clock ms epoch, the only clock comparable across the
 * processes that write here.
 */
export const FsWaitLineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("call"),
    ...Common,
    at: z.number(),
    /** timed-fs's wait layer: `fs-read`, `fs-readdir`, `fs-stat`, `fs-glob`. */
    layer: z.string(),
    /** The call (`readdir`, `statSync`, `scanGlob`). */
    op: z.string(),
    ms: z.number(),
    target: z.string().nullable(),
    /** Timed async calls in flight as it started (a large one: a queue). */
    concurrent: z.number(),
    /** The innermost profiler entry it ran under (`loader <key>`), when any. */
    caller: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("episode"),
    ...Common,
    /** Start of the first call, end of the last. */
    from: z.number(),
    to: z.number(),
    calls: z.number(),
    /** Slow calls per wait layer. */
    layers: z.record(z.string(), z.number()),
    maxConcurrent: z.number(),
    slowest: z.object({
      op: z.string(),
      ms: z.number(),
      target: z.string().nullable(),
      caller: z.string().nullable(),
    }),
  }),
]);
export type FsWaitLine = z.infer<typeof FsWaitLineSchema>;
