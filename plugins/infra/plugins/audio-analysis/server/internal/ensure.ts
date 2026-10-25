import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ensureDep } from "@plugins/infra/plugins/deps/deps";
import { runPython } from "@plugins/infra/plugins/deps/plugins/python/deps";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { isNonRetryableError } from "@plugins/infra/plugins/jobs/server";
import { VideoIdSchema } from "@plugins/integrations/plugins/youtube/core";
import { fetchYouTubeAudio } from "@plugins/integrations/plugins/youtube/plugins/audio-fetch/server";
import {
  ANALYSIS_VERSION,
  AnalysisDeviceSchema,
  BeatFeaturesSchema,
  settingsKey,
  type AnalysisDevice,
  type AnalysisPhase,
  type AnalysisSettings,
  type BeatFeatures,
} from "../../core";
import { audioModelsCacheDir } from "../../data-dirs";
import { audioPythonDep } from "../../deps";
import { configuredAnalysis } from "./settings";
import type { FailedFile, RunningFile } from "./state";
import {
  cacheRoot,
  featurePaths,
  releaseLock,
  waitLock,
  type FeaturePaths,
} from "./store";

/** A 4-minute song takes ≈5 s with the defaults and ≈20 s with the slowest settings; ten minutes bounds a long mix on a busy box. */
const ANALYSIS_TIMEOUT_MS = 10 * 60_000;

/** `equin_audio.beat_features`'s stdout: a summary (the features go to a file). */
const SummarySchema = z.object({
  beats: z.number().int(),
  medianBpm: z.number(),
  seconds: z.number(),
  device: AnalysisDeviceSchema.exclude(["auto"]),
});

/**
 * Where a cache-missing `ensureBeatFeatures` call is: `waiting` for another
 * process analysing the same entry, then the analysis's own phases.
 */
export type EnsurePhase = AnalysisPhase | "waiting";

export interface EnsureBeatFeaturesOptions {
  /** Progress lines: the download's, the installs', the extractor's. */
  log?: (line: string) => void;
  /**
   * Each phase as it starts, awaited before the work goes on (a caller may
   * persist it): `waiting` only when another process holds the entry's lock,
   * then `fetching` → `installing` → `analysing`. Never called on a cache hit
   * (nor when the lock holder turns out to have just written the features).
   */
  onPhase?: (phase: EnsurePhase) => Promise<void>;
  /** Re-analyse even when the features are ready. */
  force?: boolean;
  /** The settings that key the cache; each one left out is the configured one. */
  settings?: Partial<AnalysisSettings>;
  /** Where the beat tracker runs. Default: the configured device. */
  device?: AnalysisDevice;
  /** Test seam: the cache root. */
  dir?: string;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

async function readReady(paths: FeaturePaths): Promise<BeatFeatures | null> {
  let text: string;
  try {
    text = await readFile(paths.ready, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return BeatFeaturesSchema.parse(JSON.parse(text));
}

/**
 * One YouTube video's beat features, analysing it if they are not cached.
 *
 * Demands an `ExecContext` — it may download audio, install a ≈1 GB Python
 * env and run a minute of analysis, so it never runs on a backend's event
 * loop. A chain job calls it inside its `run` body; a request path uses
 * `requestBeatFeatures`.
 *
 * The settings (default: the configured ones) pick the cache entry; the
 * device only where the beat tracker runs.
 *
 * Hit: the features file, parsed (no `onPhase`). Miss: take the video's host flock (waiting
 * for another process analysing it — any worktree), re-check, then with
 * `running.json` saying which phase it is in: fetch the audio, make sure the
 * `audio-python` dep is installed, run the extractor under one background unit
 * of host admission, validate its output against the contract, and rename it
 * into place. A throw leaves `failed.json` (`permanent` for a non-retryable
 * error, e.g. YouTube will not serve the video) and is rethrown.
 */
export async function ensureBeatFeatures(
  videoId: string,
  exec: ExecContext,
  opts: EnsureBeatFeaturesOptions = {},
): Promise<BeatFeatures> {
  const id = VideoIdSchema.parse(videoId);
  const settings: AnalysisSettings = {
    beatModel:
      opts.settings?.beatModel ?? configuredAnalysis().settings.beatModel,
    chroma: opts.settings?.chroma ?? configuredAnalysis().settings.chroma,
  };
  const device = opts.device ?? configuredAnalysis().device;
  const paths = featurePaths(cacheRoot(opts.dir), id, settings);
  const say = opts.log ?? (() => {});

  if (opts.force !== true) {
    const hit = await readReady(paths);
    if (hit !== null) return hit;
  }

  mkdirSync(paths.dir, { recursive: true });
  const fd = await waitLock(paths.lock, async () => {
    say(`another process is analysing ${id}; waiting for it`);
    await opts.onPhase?.("waiting");
  });
  try {
    // Whoever held the lock may have just analysed this very video.
    if (opts.force !== true) {
      const again = await readReady(paths);
      if (again !== null) return again;
    }
    return await analyse(id, paths, settings, device, exec, say, opts.onPhase);
  } finally {
    releaseLock(fd);
  }
}

async function analyse(
  id: string,
  paths: FeaturePaths,
  settings: AnalysisSettings,
  device: AnalysisDevice,
  exec: ExecContext,
  say: (line: string) => void,
  onPhase: EnsureBeatFeaturesOptions["onPhase"],
): Promise<BeatFeatures> {
  rmSync(paths.failed, { force: true });
  const since = new Date().toISOString();
  const phase = async (p: AnalysisPhase) => {
    const running: RunningFile = { since, phase: p, pid: process.pid };
    writeJsonAtomic(paths.running, running);
    await onPhase?.(p);
  };
  const tmp = `${paths.ready}.tmp-${process.pid}`;
  try {
    await phase("fetching");
    const audio = await fetchYouTubeAudio(id, exec, { log: say });
    await phase("installing");
    const ready = await ensureDep(audioPythonDep, exec, { log: say });
    await phase("analysing");
    const summary = await exec.admit(() =>
      runPython(ready, {
        module: "equin_audio.beat_features",
        input: {
          audioPath: audio.path,
          outPath: tmp,
          device,
          modelsDir: audioModelsCacheDir.ensure(),
          videoId: id,
          analysisVersion: ANALYSIS_VERSION,
          settings,
          audioFormat: audio.format,
          ytDlpVersion: audio.ytDlpVersion,
        },
        output: SummarySchema,
        timeoutMs: ANALYSIS_TIMEOUT_MS,
        log: say,
      }),
    );
    const features = BeatFeaturesSchema.parse(
      JSON.parse(await readFile(tmp, "utf8")),
    );
    const wrote = `${features.videoId} v${features.analysisVersion} ${settingsKey(features.source.settings)}`;
    const expected = `${id} v${ANALYSIS_VERSION} ${settingsKey(settings)}`;
    if (wrote !== expected) {
      throw new Error(
        `the extractor wrote features for ${wrote}, expected ${expected}`,
      );
    }
    // Pretty-printing is left out on purpose: ≈100 KB per song as written.
    renameSync(tmp, paths.ready);
    say(
      `${id}: ${summary.beats} beats, median ${summary.medianBpm.toFixed(1)} BPM, analysed in ${summary.seconds.toFixed(1)} s (${settingsKey(settings)}, ${summary.device})`,
    );
    return features;
  } catch (err) {
    const failed: FailedFile = {
      message: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
      permanent: isNonRetryableError(err),
    };
    writeJsonAtomic(paths.failed, failed);
    throw err;
  } finally {
    rmSync(tmp, { force: true });
    rmSync(paths.running, { force: true });
  }
}
