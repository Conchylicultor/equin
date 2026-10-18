import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FRESHNESS_LEASE_MS,
  LATCH_FILENAME,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import {
  SentinelVitalsRecordSchema,
  type SentinelVitalsRecord,
} from "@plugins/debug/plugins/sentinel/plugins/status-file/core";
import {
  namespaceArgv,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import {
  DuressEpisodeEventSchema,
  type ClusterSample,
  type DuressEpisodeEvent,
} from "../../../core";
import type { DetectorThresholds } from "../detector";
import type { MainToWorkerFrame, WorkerToMainFrame } from "./protocol";

// The deterministic in-process reproduction of the 2026-07-11 03:34 failure:
// with the latch lifecycle on main's event loop, blocking that loop stopped
// the per-tick lease renewal and the tripped latch lapsed MID-freeze. Here a
// REAL sentinel worker trips on injected samples, the parent thread then
// blocks itself completely with Atomics.wait (no event loop, exactly like a
// wedged main), and the latch mtime must still advance during the block —
// only the worker thread could have renewed it.
//
// Isolation: the worker thread evaluates its module graph fresh, and Bun's
// Worker `env` option overrides its environment — so SINGULARITY_DIR points
// the worker's latch AND its duress-episodes channel at a throwaway temp dir
// (the parent's own import-frozen paths are irrelevant — it asserts via raw
// fs on the temp paths). Runtime process.env mutations do NOT propagate to
// workers (verified); the option is the seam.

const WORKTREE = runtimeNamespace();
const CADENCE_MS = 100;

const THRESHOLDS: DetectorThresholds = {
  onLoadRatio: 1.5,
  onLocksWaiting: 5,
  onBlkReadDeltaMs: 2_000,
  onBackendP99Ms: 1_000,
  onSlowBackends: 2,
  onDecompressionsPerSec: 50_000,
  onTicks: 2,
  offRatio: 0.6,
  offTicks: 2,
};

function sample(overrides: Partial<ClusterSample> = {}): ClusterSample {
  return {
    wall: Date.now(),
    loadAvg1: 4,
    loadAvg5: 4,
    cpuCount: 18,
    pgActiveBackends: 3,
    pgTotalBackends: 30,
    pgWaitEvents: {},
    pgLocksWaiting: 0,
    pgBlkReadDeltaMs: 0,
    pgXactCommitDelta: 0,
    runningBackends: 3,
    totalActiveConns: 5,
    inFlightBuilds: 0,
    backendP99: {},
    decompressionsPerSec: 0,
    compressorMb: 4_000,
    freeMemMb: 8_000,
    ...overrides,
  };
}

const hot = () => sample({ decompressionsPerSec: 300_000 });
// Postgres unreadable this tick: the detector reads 0 locks, the file says unknown.
const pgDown = () => sample({ pgLocksWaiting: null });
const calm = () => sample();

interface WorkerRig {
  worker: Worker;
  frames: WorkerToMainFrame[];
  post(frame: MainToWorkerFrame): void;
  waitFor(
    pred: (f: WorkerToMainFrame) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
}

const tmpDirs: string[] = [];
const rigs: WorkerRig[] = [];

function spawnRig(dir: string): WorkerRig {
  const frames: WorkerToMainFrame[] = [];
  const waiters: (() => void)[] = [];
  const worker = new Worker(new URL("./entry.ts", import.meta.url), {
    env: { ...process.env, SINGULARITY_DIR: dir },
    // Spawned exactly as worker-host spawns it: the namespace rides argv.
    argv: namespaceArgv(),
  });
  worker.onmessage = (event: MessageEvent) => {
    frames.push(event.data as WorkerToMainFrame);
    for (const w of waiters.splice(0)) w();
  };
  worker.addEventListener("error", (event: ErrorEvent) => {
    // Surface eval/spawn failures in the waitFor timeout dump.
    frames.push({ type: "log", line: `worker error: ${event.message}` });
    for (const w of waiters.splice(0)) w();
  });
  const rig: WorkerRig = {
    worker,
    frames,
    post: (frame) => worker.postMessage(frame),
    waitFor: (pred, timeoutMs = 10_000) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(`waitFor timed out; frames: ${JSON.stringify(frames)}`),
          );
        }, timeoutMs);
        const check = () => {
          if (frames.some(pred)) {
            clearTimeout(timer);
            resolve();
            return;
          }
          waiters.push(check);
        };
        check();
      }),
  };
  rigs.push(rig);
  return rig;
}

// The latch's declared data dir (`locks/duress`) under the worker's
// SINGULARITY_DIR — the path the worker's `duressLatchDir` resolves to.
function latchPathIn(dir: string): string {
  return join(dir, "locks", "duress", LATCH_FILENAME);
}

// The vitals file under the worker's SINGULARITY_DIR — the status-file leaf's
// declared data dir (`locks/sentinel`).
function readVitalsIn(dir: string): SentinelVitalsRecord {
  return SentinelVitalsRecordSchema.parse(
    JSON.parse(
      readFileSync(join(dir, "locks", "sentinel", "vitals.json"), "utf8"),
    ),
  );
}

/** Wait for a tick that STARTS after now — the tick before it has written its vitals. */
async function nextTick(rig: WorkerRig): Promise<void> {
  const seen = rig.frames.length;
  await rig.waitFor(
    (f) => f.type === "sample" && rig.frames.indexOf(f) >= seen,
  );
}

function newTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-latch-"));
  tmpDirs.push(dir);
  return dir;
}

function readEpisodeLines(dir: string): DuressEpisodeEvent[] {
  const file = join(
    dir,
    "worktrees",
    WORKTREE,
    "logs",
    "duress-episodes.jsonl",
  );
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const envelope = JSON.parse(l) as { line: string };
      return DuressEpisodeEventSchema.parse(JSON.parse(envelope.line));
    });
}

afterAll(() => {
  for (const rig of rigs) rig.worker.terminate();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("sentinel worker latch lifecycle", () => {
  test("trips, renews the lease while the parent thread is blocked, clears", async () => {
    const dir = newTmpDir();
    const latchPath = latchPathIn(dir);
    const rig = spawnRig(dir);

    rig.post({
      type: "init",
      cadenceMs: CADENCE_MS,
      thresholds: THRESHOLDS,
      maxEpisodeHoldMs: 600_000,
    });
    // Pin the gatherer to a hot synthetic sample before the first tick.
    rig.post({ type: "__sample", sample: hot() });

    await rig.waitFor((f) => f.type === "ready");
    await rig.waitFor((f) => f.type === "trip");
    expect(existsSync(latchPath)).toBe(true);
    const latch = JSON.parse(readFileSync(latchPath, "utf8")) as {
      setAt: number;
      reason: string;
    };
    expect(latch.reason).toContain("decompressionsPerSec");

    // ── The decisive half: freeze THIS thread the way main froze at 03:34.
    const preBlockMtime = statSync(latchPath).mtimeMs;
    const blockStart = Date.now();
    // No event loop for 1s ≈ 10 worker ticks. Under the old in-main-loop
    // design, renewal stopped here.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    const wake = Date.now();

    const postBlockMtime = statSync(latchPath).mtimeMs;
    // Renewed while we were frozen: only the worker thread can have done it.
    expect(postBlockMtime).toBeGreaterThan(preBlockMtime);
    expect(postBlockMtime).toBeGreaterThan(blockStart);
    // The lease held throughout (the isUnderDuress predicate).
    expect(wake - postBlockMtime).toBeLessThan(FRESHNESS_LEASE_MS);

    // ── The vitals file: every tick wrote the readings the detector acted on,
    // with the limits it held and its trip state.
    const hotVitals = readVitalsIn(dir);
    expect(hotVitals.pid).toBe(process.pid);
    expect(hotVitals.cadenceMs).toBe(CADENCE_MS);
    expect(hotVitals.tripped).toBe(true);
    expect(hotVitals.elevated).toEqual(["decompressionsPerSec"]);
    expect(hotVitals.signals.decompressionsPerSec).toEqual({
      value: 300_000,
      limit: THRESHOLDS.onDecompressionsPerSec,
    });
    expect(hotVitals.signals.loadRatio).toEqual({
      value: 4 / 18,
      limit: THRESHOLDS.onLoadRatio,
    });
    expect(hotVitals.signals.locksWaiting).toEqual({
      value: 0,
      limit: THRESHOLDS.onLocksWaiting,
    });
    expect(hotVitals.context).toEqual({
      freeMemMb: 8_000,
      inFlightBuilds: 0,
      runningBackends: 3,
      // The synthetic sample carries no disk reading.
      disk: null,
    });

    // ── Clear: calm samples for offTicks → latch unlinked.
    rig.post({ type: "__sample", sample: calm() });
    await rig.waitFor((f) => f.type === "clear");
    expect(existsSync(latchPath)).toBe(false);
    await nextTick(rig);
    const calmVitals = readVitalsIn(dir);
    expect(calmVitals.tripped).toBe(false);
    expect(calmVitals.elevated).toEqual([]);

    // ── WS3: the clear frame carries the duress-episode report enrichment
    // (reason / elevated cause-signature / episodeSetAt / wall) that onset.ts
    // turns into a `void recordReport({ kind: "duress-episode" })` on main.
    // Asserting via the frame-handling seam (the worker emits it) proves the
    // report has everything it needs without pulling the DB into a worker test.
    const clearFrame = rig.frames.find((f) => f.type === "clear");
    expect(clearFrame?.type).toBe("clear");
    if (clearFrame?.type === "clear") {
      expect(clearFrame.reason).toContain("decompressionsPerSec");
      expect(clearFrame.elevated).toEqual(["decompressionsPerSec"]);
      expect(clearFrame.episodeSetAt).toBe(latch.setAt);
      expect(typeof clearFrame.wall).toBe("number");
      expect(clearFrame.forced).toBe(false);
    }

    // ── Stage 3: trip/clear landed as schema-valid duress-episode lines.
    const episodes = readEpisodeLines(dir);
    expect(episodes.map((e) => e.kind)).toEqual(["trip", "clear"]);
    const [trip, clear] = episodes as [DuressEpisodeEvent, DuressEpisodeEvent];
    expect(trip.episodeSetAt).toBe(latch.setAt);
    expect(clear.episodeSetAt).toBe(trip.episodeSetAt);
    expect(clear.atMs).toBeGreaterThanOrEqual(trip.atMs);
    expect(trip.reason).toContain("decompressionsPerSec");

    // ── Frame ordering sanity + graceful stop.
    const kinds = rig.frames.map((f) => f.type);
    expect(kinds.indexOf("ready")).toBeLessThan(kinds.indexOf("trip"));
    expect(kinds.indexOf("trip")).toBeLessThan(kinds.indexOf("clear"));
    expect(kinds).toContain("sample");
    rig.post({ type: "stop" });
    await rig.waitFor((f) => f.type === "stopped");
  }, 20_000);

  test("a respawned worker adopts a fresh existing latch and owns its clear", async () => {
    const dir = newTmpDir();
    const latchPath = latchPathIn(dir);
    // A previous worker tripped, then died (crash / main restart): the
    // latch exists with a fresh mtime, and the trip line is already on disk.
    const setAt = Date.now() - 5_000;
    mkdirSync(dirname(latchPath), { recursive: true });
    writeFileSync(
      latchPath,
      JSON.stringify({ setAt, reason: "cluster-onset: loadRatio" }),
    );

    const rig = spawnRig(dir);
    rig.post({
      type: "init",
      cadenceMs: CADENCE_MS,
      thresholds: THRESHOLDS,
      maxEpisodeHoldMs: 600_000,
    });
    rig.post({ type: "__sample", sample: calm() });
    await rig.waitFor((f) => f.type === "ready");

    // Adoption: no trip frame, no trip line — straight to the clear after
    // offTicks calm ticks, unlinking the adopted latch.
    await rig.waitFor((f) => f.type === "clear");
    expect(rig.frames.some((f) => f.type === "trip")).toBe(false);
    expect(existsSync(latchPath)).toBe(false);

    const episodes = readEpisodeLines(dir);
    expect(episodes.map((e) => e.kind)).toEqual(["clear"]);
    expect(episodes[0]?.episodeSetAt).toBe(setAt);

    // An adopted episode has no trip event, so its clear frame carries an
    // empty cause-signature but still the adopted latch's episodeSetAt — the
    // duress-episode report renders it as "(adopted / unknown)".
    const clearFrame = rig.frames.find((f) => f.type === "clear");
    if (clearFrame?.type === "clear") {
      expect(clearFrame.elevated).toEqual([]);
      expect(clearFrame.episodeSetAt).toBe(setAt);
    }

    rig.post({ type: "stop" });
    await rig.waitFor((f) => f.type === "stopped");
  }, 20_000);

  test("a pg-unreadable tick writes its locks as unknown, not zero", async () => {
    const dir = newTmpDir();
    const rig = spawnRig(dir);
    rig.post({
      type: "init",
      cadenceMs: CADENCE_MS,
      thresholds: THRESHOLDS,
      maxEpisodeHoldMs: 600_000,
    });
    rig.post({ type: "__sample", sample: pgDown() });
    await rig.waitFor((f) => f.type === "ready");
    await nextTick(rig);
    await nextTick(rig);
    const vitals = readVitalsIn(dir);
    expect(vitals.signals.locksWaiting).toEqual({
      value: null,
      limit: THRESHOLDS.onLocksWaiting,
    });
    expect(vitals.tripped).toBe(false);

    rig.post({ type: "stop" });
    await rig.waitFor((f) => f.type === "stopped");
  }, 20_000);
});
