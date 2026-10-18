import { z } from "zod";

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
  steps: z.array(RecordingStepSchema),
});
export type RecordingManifest = z.infer<typeof RecordingManifestSchema>;

/** The manifest's file name inside a run directory. */
export const MANIFEST_FILE = "manifest.json";
