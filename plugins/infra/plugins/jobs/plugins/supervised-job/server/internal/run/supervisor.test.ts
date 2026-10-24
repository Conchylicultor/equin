/**
 * The regression guard for one broken contract: **a run whose ledger row is
 * stamped before its process ends must keep its tail and must still receive
 * `finish`.**
 *
 * This is not a build quirk, which is why it is tested here rather than through
 * a consumer. A kind whose own CLI closes its row does so while the child is
 * still running — `./equin build` closes its row after the health probe
 * and then runs for another ~100s of compose-serve tail (measured: 75.8s). The
 * reconciler used to drop such a run from the live set on the ledger's say-so,
 * which stopped the tail mid-run (truncating the live log for EVERY kind that
 * stamps early) and, once it was the last live run, tore down the watcher — so
 * the exit marker landed with nobody listening and `finish` was never called at
 * all.
 *
 * Driven through the real `reconcileSupervisedRuns` with a fake ledger and real
 * child processes, because the bug is in how the loop COMPOSES: the per-row
 * decision (`observeRun`: `readRunTerminal` + `isRunAlive`) was already right and is already
 * covered in `core/internal/terminal.test.ts`. What broke was a second loop that
 * bypassed it.
 *
 * One thing to know when reading the assertions: a tail is PUMPED by watcher
 * events and by its own final drain, never by `reconcileSupervisedRuns` itself.
 * So the channel is asserted on after the run settles, where the drain has
 * flushed everything the tail was still holding — which is also the sharper
 * test, since a tail stopped early publishes nothing at all afterwards.
 */
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import type { LogChannel } from "@plugins/primitives/plugins/log-channels/server";
import type { RunTerminal } from "../../../core";
import { defineSupervisedRunKind, type UnfinishedRun } from "./registry";
import {
  isSupervisedSpawnError,
  reconcileSupervisedRuns,
  startSupervisedRun,
  supervisedRunWatcher,
} from "./supervisor";

// The register phase a real backend runs: without it `start()` refuses.
supervisedRunWatcher.register();

const worktree = runtimeNamespace();

/**
 * One fake kind for this file. The id is a filename prefix, so it obeys
 * `assertRunKindId` (lowercase alphanumeric, no separator) and is distinct from
 * every real kind's, so its artifacts share no prune family with them.
 */
const KIND_ID = "suptest";

/** What the fake ledger currently answers, rewritten per step of a test. */
let ledger: UnfinishedRun[] = [];
/**
 * Every `finish` this kind received, in order, with the lines the channel had
 * received by that moment — so "drained before finish" is asserted, not assumed.
 */
let finished: {
  runId: string;
  terminal: RunTerminal;
  publishedBefore: string[];
}[] = [];
/** Every line the tail published into the channel. */
let published: string[] = [];

// A stub rather than a real `defineLogSink`: the supervisor only ever calls
// `publishAll`, and a real sink would claim a durable channel id for a test.
const channel = {
  publishAll: (items: readonly { line: string }[]) => {
    for (const item of items) published.push(item.line);
  },
} as unknown as LogChannel;

const kind = defineSupervisedRunKind({
  id: KIND_ID,
  channel,
  listUnfinished: () => Promise.resolve(ledger),
  setPid: () => Promise.resolve(),
  finish: (runId, terminal) => {
    finished.push({ runId, terminal, publishedBefore: [...published] });
    return Promise.resolve();
  },
});
// AWAITED, not `void`-ed: `Registration.register()` is declared
// `void | Promise<void>` (server-core `types.ts`), so the call site carries a
// maybe-Promise however synchronous this particular implementation is. `void`
// would assert fire-and-forget, and that would be a lie — nothing else
// registers this kind, and every test below drives the real reconciler, which
// iterates the registry. `define-retention.test.ts` awaits its `register()` for
// the same reason.
await kind.register();

const created: string[] = [];
const children: Bun.Subprocess[] = [];

function appendTranscript(runId: string, text: string): void {
  mkdirSync(worktreeArtifacts.runsDir(worktree), { recursive: true });
  const path = worktreeArtifacts.runTranscript(worktree, KIND_ID, runId);
  if (!created.includes(path)) created.push(path);
  appendFileSync(path, text);
}

function writeMarker(runId: string, body: string): void {
  const path = worktreeArtifacts.runTerminal(worktree, KIND_ID, runId);
  if (!created.includes(path)) created.push(path);
  appendFileSync(path, body);
}

/** A real, long-lived child, so `isRunAlive` answers about a real process. */
function spawnLiveChild(): Bun.Subprocess {
  const proc = Bun.spawn(["sleep", "30"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(proc);
  return proc;
}

function uniqueRunId(tag: string): string {
  return `r-${tag}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

afterEach(async () => {
  // Kill and REAP every child, then reconcile against an empty ledger, so the
  // supervisor's own watcher is torn down rather than outliving the test file.
  // Awaiting `exited` is what reaps: `isRunAlive` succeeds on a zombie, so an
  // unreaped child would read as alive and leave a run tracked forever.
  ledger = [];
  for (const proc of children.splice(0)) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  await reconcileSupervisedRuns();
  for (const path of created.splice(0)) {
    if (existsSync(path)) rmSync(path);
  }
  finished = [];
  published = [];
});

describe("reconcileSupervisedRuns: a run the ledger stopped listing", () => {
  test("keeps tailing after the drop, and is finished only when the marker lands", async () => {
    const runId = uniqueRunId("alive");
    const proc = spawnLiveChild();
    appendTranscript(runId, "before the row was stamped\n");
    ledger = [{ runId, pid: proc.pid }];
    await reconcileSupervisedRuns();

    // The caller's own CLI stamps its row — the run leaves the unfinished set
    // while its process keeps going.
    ledger = [];
    await reconcileSupervisedRuns();
    expect(finished).toEqual([]);

    // More output, and another pass. Still not finished: no marker, live pid.
    appendTranscript(runId, "after the row was stamped\n");
    await reconcileSupervisedRuns();
    expect(finished).toEqual([]);

    // The child exits; the shim writes the marker. NOW it finishes.
    writeMarker(runId, "0 -\n");
    await reconcileSupervisedRuns();

    // Asserted by membership rather than by count: a watcher is live for most of
    // this test (the run is tracked), so the same marker can also reach
    // `settleFromMarker` through a debounced filesystem event. That the run is
    // finished AT ALL is the regression; how many edges noticed is not.
    const own = finished.filter((f) => f.runId === runId);
    expect(own.length).toBeGreaterThan(0);
    expect(own[0]?.terminal.exitCode).toBe(0);
    expect(own[0]?.terminal.signalCode).toBeNull();

    // BOTH halves of the transcript reach the channel — including everything
    // written after the ledger stopped naming the run. This is the part that is
    // not build-specific: under the old bare `untrack` the tail was stopped at
    // the drop, so the second line was never published by anything, ever.
    expect(published).toEqual([
      "before the row was stamped",
      "after the row was stamped",
    ]);
  });

  test("is finished with the hard-kill sentinel when its child dies leaving no marker", async () => {
    const runId = uniqueRunId("sigkill");
    const proc = spawnLiveChild();
    appendTranscript(runId, "half a run\n");
    ledger = [{ runId, pid: proc.pid }];
    await reconcileSupervisedRuns();

    ledger = [];
    proc.kill("SIGKILL");
    // Reaped, so the subsequent probe answers about a dead pid rather than a
    // zombie — `process.kill(pid, 0)` succeeds on either.
    await proc.exited;
    children.splice(children.indexOf(proc), 1);
    await reconcileSupervisedRuns();

    const own = finished.filter((f) => f.runId === runId);
    expect(own).toHaveLength(1);
    // A status no child can produce, with no signal claimed — SIGKILL runs no
    // shell, so absence is the only evidence there is.
    expect(own[0]?.terminal.exitCode).toBe(-1);
    expect(own[0]?.terminal.signalCode).toBeNull();
  });

  test("is finished exactly once, not again on every later pass", async () => {
    // No watcher is ever armed here: the marker is already present, so the very
    // first pass settles the run and the live set is empty by the time
    // `syncWatcher` looks. That makes the count deterministic, which is what
    // lets this test pin "exactly once" where the one above cannot.
    const runId = uniqueRunId("once");
    appendTranscript(runId, "quick\n");
    writeMarker(runId, "7 -\n");
    ledger = [{ runId, pid: null }];
    await reconcileSupervisedRuns();
    expect(finished).toHaveLength(1);
    expect(finished[0]?.terminal.exitCode).toBe(7);

    ledger = [];
    await reconcileSupervisedRuns();
    await reconcileSupervisedRuns();
    expect(finished).toHaveLength(1);
  });
});

/** How many processes are in group `pgid` right now (0 once it is empty). */
function groupSize(pgid: number): number {
  const ps = Bun.spawnSync(["ps", "-o", "pid=", "-g", String(pgid)]);
  return ps.stdout.toString().trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Whether the kernel reports group `pgid` gone (ESRCH). Not `groupSize() === 0`:
 * `ps` can already list nothing while a member still tearing down answers the
 * group probe with EPERM for a few milliseconds.
 */
function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw err;
  }
}

/** Poll `cond` for up to 5 s — a test-only bound, not production polling. */
async function waitUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (cond()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not reached within 5s");
}

describe("reconcileSupervisedRuns: a run whose shim alone was SIGKILLed", () => {
  test("stays open while its worker lives, then closes -1 with the worker's late output drained first", async () => {
    // The 2026-09-16 shape: `kill -9 <row pid>` took the shim — the leader of
    // the run's process group — and left the worker running, re-parented, in
    // that group. Probing the pid alone closed the row as a hard kill at once,
    // which stopped the tail and released the in-flight lock under a live
    // worker.
    const runId = uniqueRunId("loneshim");
    appendTranscript(runId, "worker started\n");
    const transcript = worktreeArtifacts.runTranscript(
      worktree,
      KIND_ID,
      runId,
    );
    const shim = Bun.spawn(
      ["/bin/sh", "-c", '(sleep 1; echo "worker done" >> "$T") & wait'],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        env: { ...process.env, T: transcript },
      },
    );
    try {
      ledger = [{ runId, pid: shim.pid }];
      await reconcileSupervisedRuns();

      // Let `sh` fork its worker, then take out the shim alone and reap it.
      await waitUntil(() => groupSize(shim.pid) >= 2);
      shim.kill("SIGKILL");
      await shim.exited;

      // No marker, shim dead, worker alive ⇒ NOT finished, still tracked.
      await reconcileSupervisedRuns();
      expect(finished.filter((f) => f.runId === runId)).toEqual([]);

      // The worker writes its last line and exits; nobody writes a marker.
      await waitUntil(() => groupGone(shim.pid));
      await reconcileSupervisedRuns();

      const own = finished.filter((f) => f.runId === runId);
      expect(own).toHaveLength(1);
      // Only the shim could have witnessed the worker's status.
      expect(own[0]?.terminal.exitCode).toBe(-1);
      expect(own[0]?.terminal.signalCode).toBeNull();
      // The tail survived the shim's death: the line written after it reached
      // the channel, and before `finish` ran.
      expect(own[0]?.publishedBefore).toEqual([
        "worker started",
        "worker done",
      ]);
    } finally {
      ledger = [];
      try {
        process.kill(-shim.pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
      await shim.exited;
    }
  });
});

/**
 * Which side of the spawn a failed start happened on.
 *
 * A caller that claimed its ledger row before starting has exactly one
 * compensating action — close the row, releasing the kind's in-flight lock — and
 * it is safe on only one side of this boundary. Before the spawn, nothing exists
 * and the row would wedge the kind forever. After it, a real child is running,
 * and closing the row would release the lock under it so the next request spawns
 * a SECOND child. So the flag is asserted here, against the real function, with
 * real files and a real (very short-lived) child.
 */
let setPidFails = false;

const spawnKind = defineSupervisedRunKind({
  id: "suptestspawn",
  channel,
  listUnfinished: () => Promise.resolve([]),
  setPid: () =>
    setPidFails
      ? Promise.reject(new Error("setPid write failed"))
      : Promise.resolve(),
  finish: () => Promise.resolve(),
});
await spawnKind.register();

/** Await `p` and return the Error it rejected with; throw if it resolved. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** Both artifact paths of a run of `spawnKind`, registered for cleanup. */
function trackArtifacts(runId: string): void {
  created.push(
    worktreeArtifacts.runTranscript(worktree, "suptestspawn", runId),
  );
  created.push(worktreeArtifacts.runTerminal(worktree, "suptestspawn", runId));
}

describe("startSupervisedRun: which side of the spawn a failure happened on", () => {
  test("a failure before the spawn reports childStarted: false", async () => {
    const runId = uniqueRunId("prespawn");
    // A marker already sitting there is rejected before anything is spawned.
    mkdirSync(worktreeArtifacts.runsDir(worktree), { recursive: true });
    const marker = worktreeArtifacts.runTerminal(
      worktree,
      "suptestspawn",
      runId,
    );
    created.push(marker);
    appendFileSync(marker, "0 -\n");

    const err = await rejection(
      startSupervisedRun(spawnKind, { runId, argv: ["true"] }),
    );

    expect(isSupervisedSpawnError(err)).toBe(true);
    if (!isSupervisedSpawnError(err)) return;
    expect(err.childStarted).toBe(false);
    expect(err.message).toContain("BEFORE");
  });

  test("a failure after the spawn reports childStarted: true", async () => {
    const runId = uniqueRunId("postspawn");
    trackArtifacts(runId);
    setPidFails = true;
    try {
      // `true` exits immediately, so the child this spawns is gone by the time
      // the assertion runs — the point is only that it EXISTED, which is what
      // makes closing its row unsafe.
      const err = await rejection(
        startSupervisedRun(spawnKind, { runId, argv: ["true"] }),
      );

      expect(isSupervisedSpawnError(err)).toBe(true);
      if (!isSupervisedSpawnError(err)) return;
      expect(err.childStarted).toBe(true);
      expect(err.message).toContain("AFTER");
      // The original failure is preserved rather than replaced.
      expect((err.cause as Error).message).toBe("setPid write failed");
    } finally {
      setPidFails = false;
    }
  });
});

describe("startSupervisedRun: output is published while the run is live", () => {
  test("a line reaches the channel before the child exits", async () => {
    // The 2026-09-16 shape: the child holds its transcript descriptor open for
    // the whole run, and macOS FSEvents reports that file changed only when the
    // descriptor closes. The watcher fired once, at exit, so a live run
    // published nothing until it ended. The child here sleeps far past the
    // wait below, so only a per-write event can get the line out in time. It
    // also waits a second before writing, so the write lands after the watcher
    // is up and after the spawner closed its own copy of the descriptor (that
    // close is itself an FSEvents event, which would mask the bug).
    const runId = uniqueRunId("live");
    trackArtifacts(runId);
    const { pid } = await startSupervisedRun(spawnKind, {
      runId,
      argv: ["/bin/sh", "-c", "sleep 1; echo live-line-1; sleep 45"],
    });
    try {
      await waitUntil(() => published.includes("live-line-1"));
      expect(
        existsSync(
          worktreeArtifacts.runTerminal(worktree, "suptestspawn", runId),
        ),
      ).toBe(false);
    } finally {
      // Take out the whole group, so `afterEach`'s reconcile finds it gone and
      // settles the run, which is what tears the watcher down.
      try {
        process.kill(-pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
      await waitUntil(() => groupGone(pid));
    }
  });
});
