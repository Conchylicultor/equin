import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import {
  ANALYSIS_VERSION,
  type AnalysisSettings,
  type BeatFeatures,
} from "../../core";
import { ensureBeatFeatures, type EnsurePhase } from "./ensure";
import { cacheRoot, featurePaths, releaseLock, tryLock } from "./store";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// The fetch → install → analyse path downloads audio and installs a ≈1 GB
// env, so only the paths that end on the cache are exercised here.

const videoId = "QDYfEBY9NM4";
const settings: AnalysisSettings = { beatModel: "small0", chroma: "fast" };
const pcp = Array.from({ length: 12 }, (_, i) => (i === 0 ? 1 : 0));
const features: BeatFeatures = {
  videoId,
  analysisVersion: ANALYSIS_VERSION,
  durationSec: 10,
  sampleRate: 22050,
  tuningCents: 0,
  beats: [
    { t: 0.5, downbeat: true, barPos: 1, chroma: pcp, bass: pcp, rms: 1 },
  ],
  source: {
    audioFormat: "webm",
    ytDlpVersion: "2026.08.19",
    model: "beat_this small0",
    device: "cpu",
    settings,
  },
};

describe("ensureBeatFeatures onPhase", () => {
  let dir: AppPath;
  beforeEach(() => {
    dir = asAppPath(mkdtempSync(join(tmpdir(), "audio-analysis-ensure-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const paths = () => featurePaths(cacheRoot(dir), videoId, settings);
  const writeReady = () => {
    mkdirSync(paths().dir, { recursive: true });
    writeFileSync(paths().ready, JSON.stringify(features));
  };

  test("a cache hit reports no phase", async () => {
    writeReady();
    const phases: EnsurePhase[] = [];
    const got = await ensureBeatFeatures(videoId, execContextForTests(), {
      dir,
      settings,
      device: "cpu",
      onPhase: async (p) => {
        phases.push(p);
      },
    });
    expect(got).toEqual(features);
    expect(phases).toEqual([]);
  });

  test("a held lock reports waiting, awaited, then the holder's features", async () => {
    mkdirSync(paths().dir, { recursive: true });
    const held = tryLock(paths().lock);
    if (held === null) throw new Error("could not take the lock");
    const phases: EnsurePhase[] = [];
    const got = await ensureBeatFeatures(videoId, execContextForTests(), {
      dir,
      settings,
      device: "cpu",
      // The holder finishes while the waiter is in its awaited callback.
      onPhase: async (p) => {
        phases.push(p);
        await Promise.resolve();
        writeReady();
        releaseLock(held);
      },
    });
    expect(got).toEqual(features);
    expect(phases).toEqual(["waiting"]);
  });
});
