import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { BeatFeaturesStateSchema } from "./state";

/** The analysis runs Python on this computer. */
const ANALYSING = { feature: "Analysing a recording's audio" };

/** One video's beat-features state (the features included once ready). Never starts work. */
export const getBeatFeaturesEndpoint = defineEndpoint({
  needsMachine: ANALYSING,
  route: "GET /api/audio-analysis/beat-features/:videoId",
  response: BeatFeaturesStateSchema,
});

/**
 * Ask for one video's beat features. Enqueues the analysis job unless the
 * features are ready or the video failed permanently (`force` re-analyses
 * either way), and returns the state at once — the work runs out of process.
 */
export const requestBeatFeaturesEndpoint = defineEndpoint({
  needsMachine: ANALYSING,
  route: "POST /api/audio-analysis/beat-features/:videoId",
  internal: {
    why: "no browser client: server-side callers kick off the background analysis",
  },
  body: z.object({ force: z.boolean().optional() }),
  response: BeatFeaturesStateSchema,
});
