import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * The most steps a manifest keeps. A run that made more (a script polling the
 * page in a loop — the promo film's settle loop made 268,535 in one hour)
 * keeps its first and last halves, and says how many it dropped in between
 * (`omitted`): a manifest is read whole by the server, so it is bounded where
 * it is written.
 */
export const MAX_MANIFEST_STEPS = 2000;

export const RecordingStepSchema = z.object({
  /** What the step did, e.g. `locator.click getByRole('button', { name: 'Save' })`. */
  title: z.string(),
  /** Milliseconds since the recording started. */
  startMs: z.number(),
  durationMs: z.number(),
  /** The step's error message, when it threw. */
  error: z.string().optional(),
  /** Absolute path of the PNG showing the page as the step ended; absent before the first paint. */
  frame: z.string().optional(),
  /**
   * How many identical calls in a row this step stands for (same title, same
   * frame, none failed) — a poll loop is one step, not thousands. Absent: one.
   */
  repeat: z.number().int().min(2).optional(),
});
export type RecordingStep = z.infer<typeof RecordingStepSchema>;

/** What drove the browser: an e2e script, or one browser_* MCP tool call. */
export const RecordingSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("e2e"),
    /** The script that ran, repo-relative when it lives in the repo. */
    script: z.string(),
  }),
  z.object({
    kind: z.literal("mcp"),
    /** The MCP tool, e.g. `browser_act`. */
    tool: z.string(),
  }),
]);
export type RecordingSource = z.infer<typeof RecordingSourceSchema>;

export const RecordingManifestSchema = z.object({
  v: z.literal(2),
  source: RecordingSourceSchema,
  toolUseId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  /** In the order they ended, across every page the drive opened. */
  steps: cappedList(RecordingStepSchema, { max: MAX_MANIFEST_STEPS }),
  /**
   * The steps dropped to stay within {@link MAX_MANIFEST_STEPS}: `calls`
   * calls (repeats counted) that ran between `steps[at - 1]` and `steps[at]`.
   * Absent: every step is kept.
   */
  omitted: z
    .object({ at: z.number().int().min(0), calls: z.number().int().min(1) })
    .optional(),
});
export type RecordingManifest = z.infer<typeof RecordingManifestSchema>;

/** The manifest's file name inside a run directory. */
export const MANIFEST_FILE = "manifest.json";

/**
 * The index at the recordings root: the tool calls that still have a run, as a
 * JSON array of tool-use ids — rewritten by the writer after every prune (it
 * lists every kept run then anyway), so a reader does not walk thousands of
 * call directories to learn it.
 */
export const RecordedCallsIndexSchema = z.array(z.string());
export const RECORDED_CALLS_FILE = "recorded-calls.json";
