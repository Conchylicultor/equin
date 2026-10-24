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
