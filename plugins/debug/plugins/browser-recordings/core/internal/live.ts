import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { RecordingManifestSchema } from "./manifest";

export const BrowserRecordingRunSchema = RecordingManifestSchema.extend({
  /** The run's directory, absolute. */
  dir: z.string(),
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
