import { rmSync } from "node:fs";
import { z } from "zod";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { VideoIdSchema } from "@plugins/integrations/plugins/youtube/core";
import {
  AnalysisDeviceSchema,
  AnalysisSettingsSchema,
  settingsKey,
  type BeatFeaturesState,
} from "../../core";
import { ensureBeatFeatures } from "./ensure";
import { configuredAnalysis } from "./settings";
import { readBeatFeatures } from "./state";
import { cacheRoot, featurePaths } from "./store";

// The analyses' transcripts, at `logs/audio-analysis.jsonl` of the backend
// that supervises them.
const audioAnalysisLog = defineLogSink({
  id: "audio-analysis",
  description:
    "Beat-feature analyses requested from the app: each one's download, dependency install and extractor output.",
});

/**
 * Analyse one video, in a detached child (`./singularity supervised-exec
 * audio-analysis.beat-features`). The settings and device ride in the input,
 * resolved when it was requested, so the job computes exactly the entry the
 * request looked at. `lock` is the settings key and the video id, so a second
 * request while one runs claims nothing; `ensureBeatFeatures` itself takes
 * the entry's host flock, so another worktree analysing it meanwhile is
 * waited for, not duplicated. Two attempts: a network blip or a timeout gets one retry; a
 * video YouTube will not serve throws non-retryable and gets none.
 */
export const beatFeaturesJob = defineSupervisedJob({
  name: "audio-analysis.beat-features",
  description:
    "Downloads a YouTube video's audio and analyses its beats, downbeats and per-beat chroma, cached for every worktree.",
  input: z.object({
    videoId: VideoIdSchema,
    force: z.boolean().default(false),
    settings: AnalysisSettingsSchema,
    device: AnalysisDeviceSchema,
  }),
  channel: audioAnalysisLog,
  lock: ({ videoId, settings }) => `${settingsKey(settings)}/${videoId}`,
  runAttempts: 2,
  async run({ videoId, force, settings, device }, { log, exec }) {
    await ensureBeatFeatures(videoId, exec, { log, force, settings, device });
  },
});

/**
 * Ask for one video's beat features, with the configured settings, from
 * anywhere — a request handler included. Enqueues the analysis job and
 * returns the state at once, unless
 * nothing is to be done: already `ready`, already `running`, or `failed`
 * permanently. `force` re-analyses a ready video and retries a permanent
 * failure (its `failed.json` is cleared first).
 */
export async function requestBeatFeatures(
  videoId: string,
  opts: { force?: boolean; dir?: string } = {},
): Promise<BeatFeaturesState> {
  const id = VideoIdSchema.parse(videoId);
  const force = opts.force === true;
  const { settings, device } = configuredAnalysis();
  const state = await readBeatFeatures(id, { dir: opts.dir, settings });
  if (state.kind === "running") return state;
  if (!force && state.kind === "ready") return state;
  if (!force && state.kind === "failed" && state.permanent) return state;
  if (force)
    rmSync(featurePaths(cacheRoot(opts.dir), id, settings).failed, {
      force: true,
    });
  await beatFeaturesJob.enqueue({ videoId: id, force, settings, device });
  return readBeatFeatures(id, { dir: opts.dir, settings });
}
