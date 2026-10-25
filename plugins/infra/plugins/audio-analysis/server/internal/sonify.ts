import { z } from "zod";
import { ensureDep } from "@plugins/infra/plugins/deps/deps";
import { runPython } from "@plugins/infra/plugins/deps/plugins/python/deps";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { fetchYouTubeAudio } from "@plugins/integrations/plugins/youtube/plugins/audio-fetch/server";
import type { AnalysisSettings } from "../../core";
import { audioPythonDep } from "../../deps";
import { configuredAnalysis } from "./settings";
import { cacheRoot, featurePaths } from "./store";

/**
 * The beat grid made audible, for checking it by ear: a click at every beat
 * of the cached features (accented on downbeats) mixed over the video's
 * audio, written to `outPath` as a wav. The features (for `settings`, default
 * the configured ones) must be ready.
 */
export async function sonifyBeatFeatures(
  videoId: string,
  outPath: string,
  exec: ExecContext,
  opts: {
    log?: (line: string) => void;
    dir?: string;
    settings?: AnalysisSettings;
  } = {},
): Promise<void> {
  const audio = await fetchYouTubeAudio(videoId, exec, { log: opts.log });
  const ready = await ensureDep(audioPythonDep, exec, { log: opts.log });
  await runPython(ready, {
    module: "equin_audio.sonify",
    input: {
      audioPath: audio.path,
      featuresPath: featurePaths(
        cacheRoot(opts.dir),
        videoId,
        opts.settings ?? configuredAnalysis().settings,
      ).ready,
      outPath,
    },
    output: z.object({
      outPath: z.string(),
      beats: z.number(),
      seconds: z.number(),
    }),
    timeoutMs: 5 * 60_000,
    log: opts.log,
  });
}
