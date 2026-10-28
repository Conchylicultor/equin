import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  AnalysisPhaseSchema,
  BeatFeaturesSchema,
  type AnalysisSettings,
  type BeatFeatures,
  type BeatFeaturesState,
} from "../../core";
import { configuredAnalysis } from "./settings";
import { cacheRoot, featurePaths, isLockHeld } from "./store";

/** `<videoId>.running.json`: written when an analysis takes the lock. */
export const RunningFileSchema = z.object({
  since: z.string(),
  phase: AnalysisPhaseSchema,
  pid: z.number().int(),
});
export type RunningFile = z.infer<typeof RunningFileSchema>;

/** `<videoId>.failed.json`: written when an analysis throws. */
export const FailedFileSchema = z.object({
  message: z.string(),
  at: z.string(),
  permanent: z.boolean(),
});
export type FailedFile = z.infer<typeof FailedFileSchema>;

/** What is on disk for one video at the current version and one settings combination. */
export interface FeatureFiles {
  ready: BeatFeatures | null;
  running: RunningFile | null;
  /** Whether some process holds the video's lock right now. */
  lockHeld: boolean;
  failed: FailedFile | null;
}

/**
 * The state the files add up to. Pure, so every combination is tested.
 *
 * - Features on disk win: they were validated before the rename that put them
 *   there, and a `failed.json` beside them is from an older attempt.
 * - `running.json` counts only while its lock is held. A killed analysis
 *   leaves it behind with no holder: that is `absent` (or its earlier failure),
 *   never an eternal "running".
 * - A held lock with no `running.json` yet is the instant between taking the
 *   lock and writing the marker: `absent` until the marker lands.
 */
export function stateFromFiles(files: FeatureFiles): BeatFeaturesState {
  if (files.ready !== null) return { kind: "ready", features: files.ready };
  if (files.running !== null && files.lockHeld) {
    return {
      kind: "running",
      since: files.running.since,
      phase: files.running.phase,
    };
  }
  if (files.failed !== null) return { kind: "failed", ...files.failed };
  return { kind: "absent" };
}

async function readIfExists<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return schema.parse(JSON.parse(text));
}

/**
 * Where one video's beat features stand, from the files alone, for the
 * configured settings (or `settings`). Safe on a backend's event loop: an
 * in-memory config read, async file reads and an instant flock probe. A
 * features file under another version's or settings' dir is simply not looked
 * at, so a version bump reads as `absent`, and so does a settings combination
 * never computed — while switching back finds the earlier file again.
 */
export async function readBeatFeatures(
  videoId: string,
  opts: { dir?: string; settings?: AnalysisSettings } = {},
): Promise<BeatFeaturesState> {
  const settings = opts.settings ?? configuredAnalysis().settings;
  const paths = featurePaths(cacheRoot(opts.dir), videoId, settings);
  if (!existsSync(paths.dir)) return { kind: "absent" };
  const [ready, running, failed] = await Promise.all([
    readIfExists(paths.ready, BeatFeaturesSchema),
    readIfExists(paths.running, RunningFileSchema),
    readIfExists(paths.failed, FailedFileSchema),
  ]);
  return stateFromFiles({
    ready,
    running,
    lockHeld: running !== null && isLockHeld(paths.lock),
    failed,
  });
}
