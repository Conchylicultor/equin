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
 * One step of a build run's log, without its lines (they are the pages): its
 * id and label as the CLI reported them, how long it took, whether it passed,
 * and how many lines it holds. Step ids are not unique (the CLI can open its
 * implicit `output` step twice), so a line names its step by position.
 */
export const BuildLogStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  durationMs: z.number(),
  success: z.boolean(),
  lines: z.number().int().nonnegative(),
});
export type BuildLogStep = z.infer<typeof BuildLogStepSchema>;

/**
 * The most steps one run's log holds. The CLI's pipeline is a fixed set of
 * phases (a handful today), and a log the CLI never structured is one step;
 * a log past this is a writer defect, refused loudly by the parse.
 */
const BUILD_LOG_STEPS_MAX = 100;

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
 * (`invalid-id` — not one filename-safe segment), or a run with no log on disk (`missing`) — one still running
 * before its first line (a hand-run build writes no transcript at all until
 * its step log lands at the end), or one whose artifacts the prune reaped.
 */
export type BuildRunLogsRefusal = (typeof RUN_LOGS_REFUSALS)[number];

/**
 * One build run's persisted log, by run id — newest line first, paged by line
 * number, with its steps as the meta sibling (`buildRunLogs.meta`): the build
 * detail pane reads a page at a time as the reader scrolls back, and the Fix
 * action reads the newest page (the failing tail), never the whole log at once.
 *
 * The lines are the CLI's own step log (`build-logs-<id>.json`) when it wrote
 * one with any step, else the run's raw supervised-run transcript as one step
 * whose verdict is the exit marker's. Newest first because both readers want
 * the end: a failed build's failing step, a running one's live tail.
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
