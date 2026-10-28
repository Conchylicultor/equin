import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SentinelStatus } from "@plugins/debug/plugins/sentinel/plugins/status-file/core";
import type { DetectorThresholds } from "./detector";
import {
  createStatusWriter,
  readSentinelWatch,
} from "@plugins/debug/plugins/sentinel/plugins/status-file/server";
import { defineDaemon } from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import { createStatusSink, type DownStatus } from "./status-sink";
import {
  MAX_RAPID_FAILURES,
  startSentinelWorker,
  stopSentinelWorker,
  type SentinelWorkerSettings,
} from "./worker-host";

// The watcher's supervision, driven through the real host with real Bun
// Workers: a worker that throws while loading must end in ONE loud `down` —
// status file written, report filed — and the real worker must reach `ready`
// when spawned the way main spawns it (the 2026-09-15 regression: its imports
// read the runtime namespace before the worker had declared it).

const THRESHOLDS: DetectorThresholds = {
  onLocksWaiting: 5,
  onBlkReadDeltaMs: 2_000,
  onBackendP99Ms: 1_000,
  onSlowBackends: 2,
  onDecompressionsPerSec: 50_000,
  onTicks: 2,
  offRatio: 0.6,
  offTicks: 2,
};

const SETTINGS: SentinelWorkerSettings = {
  // Long enough that no tick (gateway / ps / pg reads) runs during a test.
  cadenceMs: 600_000,
  thresholds: THRESHOLDS,
  maxEpisodeHoldMs: 600_000,
};

// The real declaration is host-singleton; this suite runs as a worktree.
const testDaemon = defineDaemon({
  name: "sentinel.worker.test",
  description: "The sentinel worker, under test.",
  startedBy: "on-demand",
  where: "every-worktree",
  restart: { kind: "backoff", healthy: "ready" },
});
testDaemon.register();

const tmpDirs: string[] = [];
function newTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await stopSentinelWorker();
});

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  statuses: SentinelStatus[];
  reports: DownStatus[];
  logs: string[];
  statusDir: string;
  waitForState(
    state: SentinelStatus["state"],
    timeoutMs?: number,
  ): Promise<void>;
}

function rig(): Rig & { onStatus: (s: SentinelStatus) => void } {
  const statuses: SentinelStatus[] = [];
  const reports: DownStatus[] = [];
  const logs: string[] = [];
  const waiters: (() => void)[] = [];
  const statusDir = newTmpDir("sentinel-status-");
  const sink = createStatusSink({
    dir: statusDir,
    reportDown: (s) => reports.push(s),
  });
  return {
    statuses,
    reports,
    logs,
    statusDir,
    onStatus: (s) => {
      sink(s);
      statuses.push(s);
      for (const w of waiters.splice(0)) w();
    },
    waitForState: (state, timeoutMs = 15_000) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `no "${state}" status; statuses: ${JSON.stringify(statuses)}; logs: ${JSON.stringify(logs)}`,
            ),
          );
        }, timeoutMs);
        const check = () => {
          if (statuses.some((s) => s.state === state)) {
            clearTimeout(timer);
            resolve();
            return;
          }
          waiters.push(check);
        };
        check();
      }),
  };
}

function handlersFor(r: ReturnType<typeof rig>) {
  return {
    onSample: () => {},
    onTrip: () => {},
    onClear: () => {},
    onLog: (line: string) => r.logs.push(line),
    onStatus: r.onStatus,
  };
}

describe("sentinel worker host", () => {
  test("a worker that throws at load ends in one loud down: report + status file", async () => {
    const moduleDir = newTmpDir("sentinel-bad-worker-");
    const badWorker = join(moduleDir, "throws-at-load.ts");
    writeFileSync(
      badWorker,
      `throw new Error("sentinel test: module load failed");\n`,
    );

    const r = rig();
    startSentinelWorker({
      handlers: handlersFor(r),
      settings: SETTINGS,
      worker: { url: pathToFileURL(badWorker) },
      backoff: { minMs: 10, maxMs: 20 },
      daemon: testDaemon,
    });
    await r.waitForState("down");

    const states = r.statuses.map((s) => s.state);
    expect(states).toEqual([
      "starting",
      ...Array<SentinelStatus["state"]>(MAX_RAPID_FAILURES - 1).fill(
        "respawning",
      ),
      "down",
    ]);
    const down = r.statuses.at(-1);
    if (down?.state !== "down") throw new Error("unreachable");
    expect(down.deaths).toBe(MAX_RAPID_FAILURES);
    expect(down.lastError).toContain("module load failed");

    // One report, carrying the same give-up.
    expect(r.reports).toEqual([down]);

    // The status file every backend reads says so, owned by this live process.
    expect(readSentinelWatch(r.statusDir)).toEqual({
      kind: "recorded",
      status: down,
      pid: process.pid,
      ownerAlive: true,
    });

    // Nothing respawns after the give-up; stopping still records `stopped`.
    await stopSentinelWorker();
    expect(r.statuses.at(-1)?.state).toBe("stopped");
    const after = readSentinelWatch(r.statusDir);
    expect(after.kind === "recorded" && after.status.state).toBe("stopped");
  }, 30_000);

  test("the real worker, spawned as main spawns it, reaches ready", async () => {
    const r = rig();
    startSentinelWorker({
      handlers: handlersFor(r),
      settings: SETTINGS,
      // A throwaway data root, so the worker's latch read and any episode line
      // stay off this machine's real duress latch.
      worker: {
        url: new URL("./worker/entry.ts", import.meta.url),
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (e): e is [string, string] => e[1] !== undefined,
            ),
          ),
          ...envEntries({ DIR: newTmpDir("sentinel-root-") }),
        },
      },
      daemon: testDaemon,
    });
    await r.waitForState("running");
    expect(r.statuses.map((s) => s.state)).toEqual(["starting", "running"]);
    expect(r.reports).toEqual([]);

    await stopSentinelWorker();
    expect(r.statuses.at(-1)?.state).toBe("stopped");
  }, 30_000);
});

describe("status file ownership", () => {
  test("a later host's claim wins; the old host's writes stop counting", () => {
    const dir = newTmpDir("sentinel-owner-");
    const both = (pid: number) => pid === 111 || pid === 222;
    const oldHost = createStatusWriter(dir, {
      pid: 111,
      claimedAt: 1,
      alive: both,
    });
    const newHost = createStatusWriter(dir, {
      pid: 222,
      claimedAt: 2,
      alive: both,
    });

    oldHost({ state: "running", since: 1 });
    newHost({ state: "starting", since: 2 });
    // The hot restart's old backend shuts down after the new one started.
    oldHost({ state: "stopped", since: 3 });
    expect(readSentinelWatch(dir, both)).toEqual({
      kind: "recorded",
      status: { state: "starting", since: 2 },
      pid: 222,
      ownerAlive: true,
    });

    // 2026-10-08: the old host's `stopped` landed in the same instant as the
    // new host's first write, and over one shared file it won — the row read
    // "not running" while the new watcher ran. Each host's later writes still
    // count, whatever the interleaving.
    newHost({ state: "running", since: 4 });
    oldHost({ state: "stopped", since: 5 });
    expect(readSentinelWatch(dir, both)).toMatchObject({
      status: { state: "running", since: 4 },
      pid: 222,
    });
  });

  test("a new host's claim reclaims the files of hosts that are gone", () => {
    const dir = newTmpDir("sentinel-reclaim-");
    createStatusWriter(dir, { pid: 111, claimedAt: 1 })({
      state: "stopped",
      since: 1,
    });
    writeFileSync(join(dir, "status.json"), "{}");
    createStatusWriter(dir, { pid: 222, claimedAt: 2, alive: () => false })({
      state: "starting",
      since: 2,
    });
    expect(readdirSync(dir).sort()).toEqual(["status.222.json"]);
  });

  test("a status written by a process that is gone reads as not alive", () => {
    const dir = newTmpDir("sentinel-dead-");
    createStatusSink({ dir, pid: 333, reportDown: () => {} })({
      state: "running",
      since: 1,
    });
    const watch = readSentinelWatch(dir, () => false);
    expect(watch.kind === "recorded" && watch.ownerAlive).toBe(false);
  });

  test("no file → none; garbage → unreadable", () => {
    const dir = newTmpDir("sentinel-empty-");
    expect(readSentinelWatch(dir)).toEqual({ kind: "none" });
    writeFileSync(join(dir, "status.444.json"), "{not json");
    expect(readSentinelWatch(dir).kind).toBe("unreadable");
  });
});
