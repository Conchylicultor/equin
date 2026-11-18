import { z } from "zod";
import {
  cappedList,
  wholeList,
} from "@plugins/packages/plugins/list-bound/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { RecordingSourceSchema } from "./manifest";

/**
 * The most thumbnails one run's filmstrip shows. A run with more distinct
 * frames (a film session films thousands) shows its first and last halves and
 * says how many it skipped: a strip is a glance at what the drive did, and
 * every thumbnail is a request and a decoded bitmap.
 */
export const MAX_STRIP_FRAMES = 80;

/** One thumbnail of a run's filmstrip: the page as a step ended. */
const StripFrameSchema = z.object({
  /** Absolute path of the frame on the computer's disk. */
  frame: z.string(),
  /** The frame file's version (mtime and size) — what its resized copy is named by. */
  version: z.object({ mtimeMs: z.number(), size: z.number() }),
  /** The step it shows (the last of the consecutive steps that ended on it, or the failing one). */
  title: z.string(),
  /** That step's 1-based position among the run's recorded steps. */
  step: z.number().int(),
  error: z.string().optional(),
});
export type StripFrame = z.infer<typeof StripFrameSchema>;

/**
 * One run, as its filmstrip draws it — a summary and a bounded strip, never
 * the run's steps (the manifest stays on the server).
 */
const BrowserRecordingRunSchema = z.object({
  /** The run's directory, absolute. */
  dir: z.string(),
  source: RecordingSourceSchema,
  startedAt: z.string(),
  /** The calls the drive made, repeats and steps the manifest dropped included. */
  calls: z.number().int(),
  /** The recorded steps (a repeat folded into one) — what `StripFrame.step` counts. */
  steps: z.number().int(),
  /** The calls that failed. */
  failed: z.number().int(),
  /** The calls the manifest dropped to stay bounded — none for any normal run. */
  omittedCalls: z.number().int(),
  /** Distinct consecutive frames of the run — the strip shows at most {@link MAX_STRIP_FRAMES}. */
  frames: z.number().int(),
  strip: cappedList(StripFrameSchema, { max: MAX_STRIP_FRAMES }),
  /** Where the strip skips frames: `frames` were not shown between `strip[at - 1]` and `strip[at]`. */
  stripGap: z
    .object({ at: z.number().int(), frames: z.number().int() })
    .nullable(),
});
export type BrowserRecordingRun = z.infer<typeof BrowserRecordingRunSchema>;

/**
 * Every recording filed under one tool call, oldest first — none when the call
 * drove no browser. Pushed when a run's manifest lands, so a backgrounded
 * call's filmstrip appears as its run ends.
 */
export const browserRecordingRuns = liveValue("browser-recordings.runs", {
  schema: z.object({
    runs: wholeList(BrowserRecordingRunSchema, {
      reason:
        "the runs one tool call drove — one for a browser_* call or an e2e script, a few when a call reran it",
    }),
  }),
  params: ["toolUseId"],
});

/**
 * The tool calls that still have a recording: the recordings directory keeps
 * only its newest runs, so most recorded calls of an older conversation have
 * none left. Preloaded, so a transcript knows at its first frame which calls
 * will draw a filmstrip — the footer of a call outside the set draws nothing,
 * and one inside it holds the filmstrip's place while its runs load. Without
 * it, every recorded call's footer had to guess and the card resized when the
 * answer landed.
 */
export const browserRecordedCalls = liveValue(
  "browser-recordings.recorded-calls",
  {
    schema: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("indexed"),
        toolUseIds: wholeList(z.string(), {
          reason:
            "the calls the recordings directory still holds a run for — the writer keeps its newest 200 runs",
        }),
      }),
      // A store written before the writer kept an index: which calls have a
      // run is not known without walking every call directory, which the boot
      // path must not do. The next recording writes the index.
      z.object({ kind: z.literal("unindexed") }),
    ]),
    preload: "boot-and-keep",
  },
);
