import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { getBeatFeaturesEndpoint, requestBeatFeaturesEndpoint } from "../core";
import {
  handleGetBeatFeatures,
  handleRequestBeatFeatures,
} from "./internal/handlers";
import { beatFeaturesJob } from "./internal/job";

// Off the event loop (an ExecContext): `ensureBeatFeatures` (a chain job's run
// body, the CLI) and `sonifyBeatFeatures`. Anywhere: `readBeatFeatures` (the
// state, from files) and `requestBeatFeatures` (enqueues the job).
export { ensureBeatFeatures } from "./internal/ensure";
export type { EnsureBeatFeaturesOptions, EnsurePhase } from "./internal/ensure";
export { requestBeatFeatures } from "./internal/job";
export { sonifyBeatFeatures } from "./internal/sonify";
export { readBeatFeatures } from "./internal/state";

export default {
  description:
    "Audio analysis of YouTube videos, desktop half (needsMachine: Python on this computer) on the on-demand `audio-python` dependency: ensureBeatFeatures(videoId, exec) fetches the audio, runs Beat This! (beats, downbeats, no DBN) and a librosa CQT chroma out of process under one background unit of host admission, and caches the validated features host-wide per video, analysis version and settings (beat model, chroma variant — user config, with the fast ones as defaults; the device is config too) under a per-entry host flock; readBeatFeatures answers absent / running / ready / failed from the files, and requestBeatFeatures (GET/POST /api/audio-analysis/beat-features/:videoId) enqueues the audio-analysis.beat-features supervised job.",
  httpRoutes: {
    [getBeatFeaturesEndpoint.route]: handleGetBeatFeatures,
    [requestBeatFeaturesEndpoint.route]: handleRequestBeatFeatures,
  },
  register: [beatFeaturesJob],
} satisfies MachinePluginDefinition;
