import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import type { SignalOrigin } from "@plugins/packages/plugins/signal-origin/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * The most ancestors the native tap records — `SO_ANCESTRY_MAX` in
 * `signal-origin/native/signal-origin.c` (the walk stops there, and
 * `ancestryErrno` says why a chain is shorter).
 */
const SIGNAL_ORIGIN_ANCESTRY_MAX = 8;

const SignalOriginProcSchema = z.object({
  pid: z.number(),
  ppid: z.number(),
  uid: z.number(),
  comm: z.string(),
});

/**
 * The wire schema for `SignalOrigin`, whose TYPE is owned next door by
 * `signal-origin/core`. The explicit `ZodParser<SignalOrigin>` annotation is
 * load-bearing: it makes a field dropped or renamed on either side a `tsc`
 * error here rather than a silently-narrower payload that the UI would render
 * as a shorter, wrong attribution line.
 */
const SignalOriginSchema: ZodParser<SignalOrigin> = z.object({
  signal: z.number(),
  siCode: z.number(),
  senderPid: z.number(),
  senderUid: z.number(),
  senderPath: z.string().nullable(),
  ancestry: cappedList(SignalOriginProcSchema, {
    max: SIGNAL_ORIGIN_ANCESTRY_MAX,
  }),
  ancestryErrno: z.number(),
  selfPpid: z.number(),
  wallNs: z.string(),
  monoNs: z.string(),
  hits: z.number(),
});

/**
 * What the host recorded about one build run's death.
 *
 * The two fields are independent facts and both are needed, because three
 * outcomes must not share a representation:
 *
 * - `signal: null, armFailure: null` — nothing was recorded. Either nobody
 *   signalled this run, or its record predates signal attribution.
 * - `signal: {origin: null}, armFailure: {…}` — a signal arrived and we know we
 *   could not tell who sent it, and why.
 * - `signal: {origin: {…}}` — the sender is named.
 *
 * "We could not tell who" and "nobody sent a signal" are different answers; a
 * single nullable field would collapse them.
 */
export const BuildTerminationSchema = z.object({
  signal: z
    .object({
      /** ISO instant the sink line was appended. */
      at: z.string(),
      /** The POSIX name the CLI's own handler saw, e.g. `SIGTERM`. */
      signal: z.string(),
      /** Null when the native tap was not armed — see `armFailure`. */
      origin: SignalOriginSchema.nullable(),
    })
    .nullable(),
  armFailure: z
    .object({
      at: z.string(),
      /** Why the tap could not be armed (no C toolchain, disabled by env, …). */
      reason: z.string(),
    })
    .nullable(),
});

export type BuildTermination = z.infer<typeof BuildTerminationSchema>;

/**
 * What the host recorded about one build run's death, by run id
 * (`build_runs.id`) — the build detail's Info section reads it for a run that
 * was `killed` or `interrupted`.
 *
 * Deliberately NOT a `build_runs` column: the record is written from a signal
 * handler / exit hook, where nothing may be awaited, so a DB write on that path
 * would trade a clean termination for a hang. It lives in the host-global sink
 * and is joined to the run by `buildId` at read time.
 *
 * Never refused: an id the sink holds no line for answers the empty record
 * (`{signal: null, armFailure: null}`) — a run that was not killed is not a
 * missing resource, and a refusal would make "not killed" read as "no such
 * run".
 *
 * Desktop-only: the sink is a file on the computer.
 */
export const buildRunTermination = liveValue("build.run-termination", {
  schema: BuildTerminationSchema,
  params: ["id"],
  needsMachine: { feature: "Reading how a build run ended" },
});
