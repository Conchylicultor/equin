import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ANALYSIS_VERSION,
  type AnalysisSettings,
  type BeatFeatures,
} from "../../core";
import {
  readBeatFeatures,
  stateFromFiles,
  type FailedFile,
  type RunningFile,
} from "./state";
import { featurePaths, releaseLock, tryLock } from "./store";
import {
  type AppPath,
  asAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

const fast: AnalysisSettings = { beatModel: "small0", chroma: "fast" };
const full: AnalysisSettings = { beatModel: "final0", chroma: "full" };
const pcp = Array.from({ length: 12 }, (_, i) => (i === 0 ? 1 : 0));
const features: BeatFeatures = {
  videoId: "QDYfEBY9NM4",
  analysisVersion: ANALYSIS_VERSION,
  durationSec: 10,
  sampleRate: 22050,
  tuningCents: 0,
  beats: [
    { t: 0.5, downbeat: true, barPos: 1, chroma: pcp, bass: pcp, rms: 1 },
    { t: 1.5, downbeat: false, barPos: 2, chroma: pcp, bass: pcp, rms: 0.4 },
  ],
  source: {
    audioFormat: "webm",
    ytDlpVersion: "2026.08.19",
    model: "beat_this small0",
    device: "mps",
    settings: fast,
  },
};
const running: RunningFile = {
  since: "2026-09-30T10:00:00.000Z",
  phase: "analysing",
  pid: 42,
};
const failed = (permanent: boolean): FailedFile => ({
  message: "YouTube video QDYfEBY9NM4 is unavailable: Private video",
  at: "2026-09-30T09:00:00.000Z",
  permanent,
});

describe("stateFromFiles", () => {
  const none = { ready: null, running: null, lockHeld: false, failed: null };

  test("nothing on disk is absent", () => {
    expect(stateFromFiles(none)).toEqual({ kind: "absent" });
  });

  test("features win over everything else", () => {
    for (const lockHeld of [false, true]) {
      expect(
        stateFromFiles({
          ready: features,
          running,
          lockHeld,
          failed: failed(true),
        }),
      ).toEqual({ kind: "ready", features });
    }
  });

  test("running.json counts only while its lock is held", () => {
    expect(stateFromFiles({ ...none, running, lockHeld: true })).toEqual({
      kind: "running",
      since: running.since,
      phase: "analysing",
    });
    expect(stateFromFiles({ ...none, running, lockHeld: false })).toEqual({
      kind: "absent",
    });
  });

  test("a held lock with no marker yet is not running", () => {
    expect(stateFromFiles({ ...none, lockHeld: true })).toEqual({
      kind: "absent",
    });
  });

  test("a live run beats an earlier failure; a stale one shows it", () => {
    expect(
      stateFromFiles({
        ...none,
        running,
        lockHeld: true,
        failed: failed(false),
      }).kind,
    ).toBe("running");
    expect(
      stateFromFiles({
        ...none,
        running,
        lockHeld: false,
        failed: failed(false),
      }),
    ).toEqual({ kind: "failed", ...failed(false) });
  });

  test("a failure carries whether it is permanent", () => {
    expect(stateFromFiles({ ...none, failed: failed(true) })).toEqual({
      kind: "failed",
      ...failed(true),
    });
    expect(stateFromFiles({ ...none, failed: failed(false) })).toEqual({
      kind: "failed",
      ...failed(false),
    });
  });
});

describe("readBeatFeatures", () => {
  let root: AppPath;
  const id = "QDYfEBY9NM4";
  beforeEach(() => {
    root = asAppPath(mkdtempSync(join(tmpdir(), "beat-features-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function write(path: string, value: unknown) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  }

  test("no cache dir at all is absent", async () => {
    expect(await readBeatFeatures(id, { dir: root, settings: fast })).toEqual({
      kind: "absent",
    });
  });

  test("the features file is ready", async () => {
    write(featurePaths(root, id, fast).ready, features);
    expect(await readBeatFeatures(id, { dir: root, settings: fast })).toEqual({
      kind: "ready",
      features,
    });
  });

  test("an older version's file is absent", async () => {
    write(featurePaths(root, id, fast, ANALYSIS_VERSION + 1).ready, {
      ...features,
      analysisVersion: ANALYSIS_VERSION + 1,
    });
    write(featurePaths(root, id, fast, ANALYSIS_VERSION - 1).ready, features);
    expect(await readBeatFeatures(id, { dir: root, settings: fast })).toEqual({
      kind: "absent",
    });
  });

  test("each settings combination is its own entry; switching back finds the earlier one", async () => {
    write(featurePaths(root, id, fast).ready, features);
    expect(await readBeatFeatures(id, { dir: root, settings: full })).toEqual({
      kind: "absent",
    });
    const fullFeatures: BeatFeatures = {
      ...features,
      source: { ...features.source, model: "beat_this final0", settings: full },
    };
    write(featurePaths(root, id, full).ready, fullFeatures);
    expect(await readBeatFeatures(id, { dir: root, settings: full })).toEqual({
      kind: "ready",
      features: fullFeatures,
    });
    expect(await readBeatFeatures(id, { dir: root, settings: fast })).toEqual({
      kind: "ready",
      features,
    });
  });

  test("an analysis running under other settings does not count", async () => {
    const paths = featurePaths(root, id, full);
    write(paths.running, running);
    const fd = tryLock(paths.lock);
    expect(fd).not.toBeNull();
    try {
      expect(await readBeatFeatures(id, { dir: root, settings: fast })).toEqual(
        { kind: "absent" },
      );
    } finally {
      releaseLock(fd!);
    }
  });

  test("a stale running.json (no lock holder) is absent", async () => {
    write(featurePaths(root, id, fast).running, running);
    expect(await readBeatFeatures(id, { dir: root, settings: fast })).toEqual({
      kind: "absent",
    });
  });

  test("running.json with its lock held is running, until released", async () => {
    const paths = featurePaths(root, id, fast);
    write(paths.running, running);
    const fd = tryLock(paths.lock);
    expect(fd).not.toBeNull();
    try {
      expect(await readBeatFeatures(id, { dir: root, settings: fast })).toEqual(
        {
          kind: "running",
          since: running.since,
          phase: "analysing",
        },
      );
    } finally {
      releaseLock(fd!);
    }
    expect(await readBeatFeatures(id, { dir: root, settings: fast })).toEqual({
      kind: "absent",
    });
  });

  test("a stale running.json over a failure shows the failure", async () => {
    write(featurePaths(root, id, fast).running, running);
    write(featurePaths(root, id, fast).failed, failed(false));
    expect(await readBeatFeatures(id, { dir: root, settings: fast })).toEqual({
      kind: "failed",
      ...failed(false),
    });
  });

  test("a permanent failure is failed, permanent", async () => {
    write(featurePaths(root, id, fast).failed, failed(true));
    expect(await readBeatFeatures(id, { dir: root, settings: fast })).toEqual({
      kind: "failed",
      ...failed(true),
    });
  });

  test("a features file that breaks the contract throws, never reads as absent", async () => {
    write(featurePaths(root, id, fast).ready, {
      ...features,
      beats: [{ t: 1 }],
    });
    const err = await readBeatFeatures(id, { dir: root, settings: fast }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
  });
});
