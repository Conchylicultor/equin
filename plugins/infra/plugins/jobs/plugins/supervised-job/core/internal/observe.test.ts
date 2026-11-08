/**
 * The close rule, against real marker files and real processes.
 *
 * Same method as `server/internal/run/supervisor.test.ts`: the decision is what
 * has to be right, and it is decidable without a database, so it is tested
 * directly rather than through a job dispatch. A live child is a real `sleep`,
 * a dead one is a real reaped process, and a half-killed run is a real process
 * group whose leader alone was SIGKILLed — `isRunAlive` is not something a stub
 * can honestly answer.
 */
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import { HARD_KILL_EXIT_CODE, observeRun } from "./terminal";

const worktree = runtimeNamespace();
/** Lowercase alphanumeric with no separator, per `assertRunKindId`. */
const KIND_ID = "supjobobs";

const created: string[] = [];
const children: Bun.Subprocess[] = [];

function uniqueRunId(tag: string): string {
  return `r-${tag}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeMarker(runId: string, body: string): void {
  mkdirSync(worktreeArtifacts.runsDir(worktree), { recursive: true });
  const path = worktreeArtifacts.runTerminal(worktree, KIND_ID, runId);
  created.push(path);
  writeFileSync(path, body);
}

function spawnLiveChild(): Bun.Subprocess {
  const proc = Bun.spawn(["sleep", "30"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(proc);
  return proc;
}

afterEach(async () => {
  for (const proc of children.splice(0)) {
    proc.kill("SIGKILL");
    // Awaiting `exited` is what REAPS: `isRunAlive` succeeds on a zombie, so an
    // unreaped child still reads as alive.
    await proc.exited;
  }
  for (const path of created.splice(0)) if (existsSync(path)) rmSync(path);
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
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (cond()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not reached within 5s");
}

describe("observeRun", () => {
  test("a marker ends the run even while its pid is still alive", async () => {
    const runId = uniqueRunId("marker");
    const proc = spawnLiveChild();
    writeMarker(runId, "0 -\n");

    const observation = await observeRun(KIND_ID, runId, proc.pid, new Date());

    expect(observation.state).toBe("ended");
    if (observation.state !== "ended") return;
    expect(observation.terminal.exitCode).toBe(0);
    expect(observation.terminal.signalCode).toBeNull();
  });

  test("a killed run reports the signal it OBSERVED, not one derived from 143", async () => {
    const runId = uniqueRunId("killed");
    writeMarker(runId, "143 TERM\n");

    const observation = await observeRun(KIND_ID, runId, null, new Date());

    expect(observation).toEqual({
      state: "ended",
      terminal: expect.objectContaining({ exitCode: 143, signalCode: "TERM" }),
    });
  });

  test("a deliberate exit(143) is NOT reported as a kill", async () => {
    const runId = uniqueRunId("exit143");
    writeMarker(runId, "143 -\n");

    const observation = await observeRun(KIND_ID, runId, null, new Date());

    expect(observation).toEqual({
      state: "ended",
      terminal: expect.objectContaining({ exitCode: 143, signalCode: null }),
    });
  });

  test("no marker and a live pid is the only running shape", async () => {
    const runId = uniqueRunId("running");
    const proc = spawnLiveChild();

    expect(await observeRun(KIND_ID, runId, proc.pid, new Date())).toEqual({
      state: "running",
    });
  });

  test("no marker and a dead pid is a hard kill, with no signal claimed", async () => {
    const runId = uniqueRunId("hardkill");
    const proc = spawnLiveChild();
    proc.kill("SIGKILL");
    await proc.exited;

    const observation = await observeRun(KIND_ID, runId, proc.pid, new Date());

    expect(observation.state).toBe("ended");
    if (observation.state !== "ended") return;
    expect(observation.terminal.exitCode).toBe(HARD_KILL_EXIT_CODE);
    expect(observation.terminal.signalCode).toBeNull();
  });
  test("the shim killed alone keeps the run running until its worker ends, then -1", async () => {
    // A supervised run's shape: `sh` leading a fresh group, its worker inside.
    const runId = uniqueRunId("loneshim");
    const shim = Bun.spawn(["/bin/sh", "-c", "sleep 1 & wait"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    try {
      // Let `sh` fork its worker before the shim is taken out.
      await waitFor(() => groupSize(shim.pid) >= 2);
      shim.kill("SIGKILL");
      await shim.exited;

      // No marker, shim reaped, worker alive in the group ⇒ still running.
      expect(await observeRun(KIND_ID, runId, shim.pid, new Date())).toEqual({
        state: "running",
      });

      // The worker finishes on its own; nobody is left to write a marker.
      await waitFor(() => groupGone(shim.pid));
      const observation = await observeRun(
        KIND_ID,
        runId,
        shim.pid,
        new Date(),
      );
      expect(observation.state).toBe("ended");
      if (observation.state !== "ended") return;
      expect(observation.terminal.exitCode).toBe(HARD_KILL_EXIT_CODE);
      expect(observation.terminal.signalCode).toBeNull();
    } finally {
      try {
        process.kill(-shim.pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
      await shim.exited;
    }
  });
});
