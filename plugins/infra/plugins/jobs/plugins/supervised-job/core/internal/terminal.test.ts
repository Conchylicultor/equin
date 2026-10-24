/**
 * Unit coverage for the terminal decision every supervised run is closed by.
 *
 * `reconcileSupervisedRuns` binds a registry of kinds whose `finish` writes
 * through the module-level `db` singleton, so — exactly like the
 * `run-build.test.ts` suite this mirrors, and the page/editor `parent-liveness`
 * one before it — it cannot be pointed at a fixture DB. But its per-row close
 * DECISION is `observeRun`, which is fully determined by two pure, db-free
 * functions:
 *
 *   close?  =  !(readRunTerminal(kind, id) == null && isRunAlive(pid))
 *   value   =  readRunTerminal(kind, id) ?? { exitCode: -1, finishedAt: now }
 *
 * So covering `readRunTerminal` (against real marker files at the real resolved
 * path) and `isRunAlive` (against real processes and real process groups)
 * exercises the whole rule, and the composition block at the bottom drives the
 * real `observeRun` so the three scenarios are asserted end-to-end without a
 * fixture DB (`observe.test.ts` covers it against live children too):
 *
 *   - marker present, pid alive ⇒ terminal != null ⇒ CLOSE at the recorded code
 *     and the marker's mtime.
 *   - no marker, pid dead ⇒ hard SIGKILL ⇒ CLOSE with {-1, now}.
 *   - no marker, pid alive ⇒ still running ⇒ LEAVE OPEN.
 *
 * Run: `./equin test plugins/infra/plugins/jobs/plugins/supervised-job`
 */
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import {
  isRunAlive,
  observeRun,
  readRunTerminal,
  RunMarkerError,
} from "./terminal";

const KIND = "testkind";
const name = runtimeNamespace();
const created: string[] = [];

function markerPath(runId: string): string {
  return worktreeArtifacts.runTerminal(name, KIND, runId);
}

function writeMarker(runId: string, body: string, mtime?: Date): string {
  mkdirSync(worktreeArtifacts.runsDir(name), { recursive: true });
  const path = markerPath(runId);
  writeFileSync(path, body);
  if (mtime) utimesSync(path, mtime, mtime);
  created.push(path);
  return path;
}

function uniqueRunId(tag: string): string {
  return `test-${tag}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

afterEach(() => {
  for (const path of created.splice(0)) {
    if (existsSync(path)) rmSync(path);
  }
});

describe("readRunTerminal", () => {
  test("a marker holding 0 reads as a clean exit", () => {
    const runId = uniqueRunId("ok");
    writeMarker(runId, "0 -\n");
    expect(readRunTerminal(KIND, runId)?.exitCode).toBe(0);
  });

  test("a marker holding a non-zero code reads as that code", () => {
    const runId = uniqueRunId("fail");
    writeMarker(runId, "7 -\n");
    expect(readRunTerminal(KIND, runId)?.exitCode).toBe(7);
  });

  test("143 (SIGTERM) is an ordinary recorded code, not a missing marker", () => {
    // The 2026-08-28 incident's shape: the gateway signalled the whole process
    // group mid-deploy. Under the shim that is a RECORDED 143, which is what
    // lets a killed run be told apart from a failed one — before this, a group
    // signal killed the supervisor and left nothing to read.
    const runId = uniqueRunId("killed");
    writeMarker(runId, "143 TERM\n");
    const t = readRunTerminal(KIND, runId);
    expect(t?.exitCode).toBe(143);
    expect(t?.signalCode).toBe("TERM");
  });

  test("the finish instant is the marker's mtime, not the read instant", () => {
    // The property the whole file format exists for. Reusing `new Date()` at
    // reconcile time would inflate the row's Duration by the entire gap between
    // the child exiting and something noticing — often minutes after a restart.
    const runId = uniqueRunId("mtime");
    const finishedAt = new Date(Date.now() - 5 * 60_000);
    writeMarker(runId, "0 -\n", finishedAt);
    const terminal = readRunTerminal(KIND, runId);
    expect(terminal).not.toBeNull();
    // Filesystem mtime granularity varies; a second of slack is well inside it
    // while still being three orders of magnitude tighter than "now".
    expect(
      Math.abs((terminal?.finishedAt.getTime() ?? 0) - finishedAt.getTime()),
    ).toBeLessThan(1_000);
  });

  test("no marker (ENOENT) ⇒ null — the hard-SIGKILL signal", () => {
    expect(readRunTerminal(KIND, uniqueRunId("absent"))).toBeNull();
  });

  test("an unparseable marker THROWS — it is a writer defect, not a run state", () => {
    // Deliberately not `null`. The marker is published by rename and never
    // rewritten, so a reader cannot catch a partial write; malformed bytes mean
    // the shim wrote something it never should, and answering `null` would file
    // that under "hard-killed" and hide the defect behind a plausible `-1`.
    const runId = uniqueRunId("garbage");
    writeMarker(runId, "not a marker");
    expect(() => readRunTerminal(KIND, runId)).toThrow(RunMarkerError);
  });

  test("a one-field marker throws — the signal field is not optional", () => {
    const runId = uniqueRunId("onefield");
    writeMarker(runId, "143");
    expect(() => readRunTerminal(KIND, runId)).toThrow(/malformed exit marker/);
  });

  test("an empty marker throws", () => {
    const runId = uniqueRunId("empty");
    writeMarker(runId, "");
    expect(() => readRunTerminal(KIND, runId)).toThrow(RunMarkerError);
  });

  test("trailing whitespace is tolerated — the code is still read", () => {
    const runId = uniqueRunId("ws");
    writeMarker(runId, "12 -\n");
    expect(readRunTerminal(KIND, runId)?.exitCode).toBe(12);
  });

  test("a number followed by junk throws, never yields the leading number", () => {
    // `parseInt("13oops")` is 13 — a confident wrong answer stamped on the row.
    const runId = uniqueRunId("junk");
    writeMarker(runId, "13oops -");
    expect(() => readRunTerminal(KIND, runId)).toThrow(RunMarkerError);
  });

  test("`-` in the signal field means no signal was observed", () => {
    const runId = uniqueRunId("nosig");
    writeMarker(runId, "143 -\n");
    const terminal = readRunTerminal(KIND, runId);
    // The same 143 a SIGTERM produces, and the field is what separates them.
    expect(terminal?.exitCode).toBe(143);
    expect(terminal?.signalCode).toBeNull();
  });

  test("an invalid kind id throws rather than resolving a path", () => {
    // The `-` ban is what keeps one kind's prune out of another kind's files,
    // so it fails here rather than silently naming a colliding artifact.
    expect(() => readRunTerminal("test-kind", "abc")).toThrow(
      /invalid kind id/,
    );
  });

  test("a run id that would escape the runs dir throws", () => {
    expect(() => readRunTerminal(KIND, "../../etc/passwd")).toThrow(
      /invalid run id/,
    );
  });
});

/**
 * A detached `sh` whose own child outlives it — the shape of a supervised run
 * (shim + worker in one fresh process group, pgid == the shim's pid).
 */
const groups: Bun.Subprocess[] = [];

function spawnGroup(): Bun.Subprocess {
  const proc = Bun.spawn(["/bin/sh", "-c", "sleep 30 & wait"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  groups.push(proc);
  return proc;
}

/** Kill every process of `pgid`'s group, ignoring a group already gone. */
function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/**
 * Wait (bounded) until the kernel reports `pgid`'s group empty (ESRCH). An
 * orphaned member is re-parented to init, which reaps it asynchronously, and on
 * macOS a member still tearing down answers the group probe with EPERM for a
 * few milliseconds — so both "ok" and EPERM mean "not yet".
 */
async function awaitGroupGone(pgid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(-pgid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      if (code !== "EPERM") throw err;
    }
    await Bun.sleep(20);
  }
  throw new Error(`process group ${pgid} still alive after 2s`);
}

/** Wait (bounded) until the group's sh has started its `sleep` child. */
async function awaitGroupMembers(pgid: number, count: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ps = Bun.spawnSync(["ps", "-o", "pid=", "-g", String(pgid)]);
    const members = ps.stdout.toString().trim().split(/\s+/).filter(Boolean);
    if (members.length >= count) return;
    await Bun.sleep(20);
  }
  throw new Error(`process group ${pgid} never reached ${count} members`);
}

describe("isRunAlive", () => {
  afterEach(async () => {
    for (const proc of groups.splice(0)) {
      killGroup(proc.pid);
      await proc.exited;
      await awaitGroupGone(proc.pid);
    }
  });

  test("null pid ⇒ dead", () => {
    expect(isRunAlive(null)).toBe(false);
  });

  test("own pid ⇒ alive, whether or not this process leads a group", () => {
    // Rows are seeded with `process.pid` at claim time — the reason the pid
    // half of the probe exists.
    expect(isRunAlive(process.pid)).toBe(true);
  });

  test("a reaped child pid ⇒ dead", async () => {
    const proc = Bun.spawn(["true"], { detached: true });
    const childPid = proc.pid;
    await proc.exited; // reaped ⇒ ESRCH on the subsequent probe
    expect(isRunAlive(childPid)).toBe(false);
  });

  test("the group leader killed ALONE, its worker still running ⇒ alive", async () => {
    // The 2026-09-16 shape: `kill -9 <row pid>` took the shim and left the
    // worker running, re-parented, in the same group. A pid-only probe read
    // this as dead and closed the run under a live worker.
    const proc = spawnGroup();
    await awaitGroupMembers(proc.pid, 2);
    process.kill(proc.pid, "SIGKILL");
    await proc.exited; // the shim is reaped: `kill(pid, 0)` alone is ESRCH now
    expect(isRunAlive(proc.pid)).toBe(true);

    killGroup(proc.pid);
    await awaitGroupGone(proc.pid);
    expect(isRunAlive(proc.pid)).toBe(false);
  });
});

describe("close condition (composition)", () => {
  // The real per-row rule `settleRun` and `awaitSupervisedRun` both call.
  const now = new Date();

  test("marker present but pid still alive ⇒ closes from the marker", () => {
    // The shim writes the marker BEFORE it exits, so this shape is the normal
    // one for the few milliseconds before the pid reaps — not an anomaly.
    const runId = uniqueRunId("closealive");
    writeMarker(runId, "0 -\n");
    expect(observeRun(KIND, runId, process.pid, now)).toMatchObject({
      state: "ended",
      terminal: { exitCode: 0 },
    });
  });

  test("no marker + pid dead ⇒ closes with the -1/now sentinel", () => {
    expect(observeRun(KIND, uniqueRunId("closedead"), null, now)).toEqual({
      state: "ended",
      terminal: { exitCode: -1, signalCode: null, finishedAt: now },
    });
  });

  test("running run (no marker, pid alive) ⇒ left open", () => {
    expect(observeRun(KIND, uniqueRunId("running"), process.pid, now)).toEqual({
      state: "running",
    });
  });
});
