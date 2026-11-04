import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * One line of a build run's log: its 1-based position over the WHOLE run
 * (`n`, zero-padded — see {@link buildLogLineKey}), the step it belongs to (an
 * index into the meta's `steps`), its text and the stream it was written to.
 */
export const BuildLogLineSchema = z.object({
  n: z.string(),
  step: z.number().int().nonnegative(),
  text: z.string(),
  stream: z.enum(["stdout", "stderr"]),
});
export type BuildLogLine = z.infer<typeof BuildLogLineSchema>;

/** A 1-based line number as its order-key text: zero-padded, so text order is number order. */
export function buildLogLineKey(line: number): string {
  return String(line).padStart(9, "0");
}

/**
 * Where a step of a build run's log stands: it `ok`'d or `failed` (its own
 * printed verdict), or the run is still inside it (`running` — the last
 * segment of a run with no exit marker yet).
 */
export const BuildLogStepStatusSchema = z.enum(["ok", "failed", "running"]);
export type BuildLogStepStatus = z.infer<typeof BuildLogStepStatusSchema>;

/**
 * One step of a build run's log, without its lines (they are the pages): a
 * step block the CLI printed (its label, verdict and measured duration), or
 * the `output` between blocks — every line printed outside a step, so none is
 * dropped. Labels are not unique (there are several `output` stretches), so a
 * line names its step by position. `durationMs` is null where nothing measured
 * it (an `output` stretch).
 */
export const BuildLogStepSchema = z.object({
  label: z.string(),
  status: BuildLogStepStatusSchema,
  durationMs: z.number().nullable(),
  lines: z.number().int().nonnegative(),
});
export type BuildLogStep = z.infer<typeof BuildLogStepSchema>;

/**
 * The most steps one run's log holds. The CLI's pipeline is a fixed set of
 * phases (a handful of blocks per target, each with an `output` stretch beside
 * it); a log past this is a writer defect, refused loudly by the parse.
 */
const BUILD_LOG_STEPS_MAX = 200;

/** The per-run facts beside the pages: the run's steps, in the order they ran. */
export const BuildRunLogsMetaSchema = z.object({
  steps: cappedList(BuildLogStepSchema, { max: BUILD_LOG_STEPS_MAX }),
});
export type BuildRunLogsMeta = z.infer<typeof BuildRunLogsMetaSchema>;

export const BuildRunLogsQuerySchema = z.object({ id: z.string() });
export type BuildRunLogsQuery = z.infer<typeof BuildRunLogsQuerySchema>;

/** Lines per page, and the most one read without a viewport holds. */
const RUN_LOG_LINES_PAGE = 500;
const RUN_LOG_LINES_MAX = 2000;

const RUN_LOGS_REFUSALS = ["invalid-id", "missing"] as const;
/**
 * Why a run-logs read was refused: an id that cannot name a run's files
 * (`invalid-id` — not one filename-safe segment), or a run with no transcript
 * on disk (`missing`) — one the prune reaped, or a hand-run build from before
 * every build recorded one.
 */
export type BuildRunLogsRefusal = (typeof RUN_LOGS_REFUSALS)[number];

/**
 * One build run's persisted log, by run id — newest line first, paged by line
 * number, with its steps as the meta sibling (`buildRunLogs.meta`): the build
 * detail pane reads a page at a time as the reader scrolls back, and the Fix
 * action reads the newest page (the failing tail), never the whole log at once.
 *
 * The lines are the run's transcript (`runs/build-<id>.log`) — every line the
 * build printed, whoever started it — cut into its printed step blocks and the
 * output between them, the run's exit marker deciding where a failed run with
 * no failed block failed. Newest first because both readers want the end: a
 * failed build's failing step, a running one's live tail.
 */
export const buildRunLogs = liveValue("build.run-logs", {
  query: BuildRunLogsQuerySchema,
  paged: {
    item: BuildLogLineSchema,
    id: "n",
    key: { of: (line) => [line.n], order: ["desc"] },
    limit: RUN_LOG_LINES_PAGE,
    maxLimit: RUN_LOG_LINES_MAX,
    meta: BuildRunLogsMetaSchema,
  },
  refusals: RUN_LOGS_REFUSALS,
  needsMachine: { feature: "Build logs" },
});
