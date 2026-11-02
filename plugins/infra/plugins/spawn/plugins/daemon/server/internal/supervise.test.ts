import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { defineDaemon } from "./define";
import {
  daemonRecentRuns,
  listDaemons,
  type DaemonInstance,
  type DaemonTransition,
} from "./registry";

// The supervision loop, driven with real child processes and Bun Workers: a
// child that dies at once ends in ONE loud give-up; a healthy one respawns
// with its counters reset; stop() ends it for good; a pid file is followed
// through its states.

const tmpDirs: string[] = [];
function newTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "daemon-test-"));
  tmpDirs.push(dir);
  return dir;
}

const live: DaemonInstance[] = [];
afterEach(async () => {
  for (const i of live.splice(0)) await i.stop();
});
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const FAST = { minMs: 10, maxMs: 20 };

function recorder() {
  const states: DaemonTransition[] = [];
  const logs: string[] = [];
  const waiters: (() => void)[] = [];
  return {
    states,
    logs,
    onState: (t: DaemonTransition) => {
      states.push(t);
      for (const w of waiters.splice(0)) w();
    },
    onLog: (line: string) => logs.push(line),
    waitFor: (pred: (s: DaemonTransition[]) => boolean, timeoutMs = 15_000) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out; states: ${JSON.stringify(states)}`));
        }, timeoutMs);
        const check = () => {
          if (pred(states)) {
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

const sleeper = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
const crasher = [process.execPath, "-e", "process.exit(3)"];

describe("spawnProcess", () => {
  const decl = defineDaemon({
    name: "test.process",
    description: "A test child.",
    startedBy: "on-demand",
    where: "every-worktree",
    restart: { kind: "backoff", healthy: "survival", minMs: 10, maxMs: 20 },
  });
  decl.register();

  test("a child that dies at once gives up after the rapid-failure limit", async () => {
    const r = recorder();
    const inst = decl.spawnProcess({
      instance: "crash",
      argv: crasher,
      onState: r.onState,
      onLog: r.onLog,
    });
    live.push(inst);
    await r.waitFor((s) => s.some((t) => t.state === "gave-up"));
    expect(r.states.map((t) => t.state)).toEqual([
      "starting",
      "running",
      "respawning",
      "respawning",
      "respawning",
      "respawning",
      "gave-up",
    ]);
    const gaveUp = r.states.at(-1);
    if (gaveUp?.state !== "gave-up") throw new Error("unreachable");
    expect(gaveUp.deaths).toBe(5);
    expect(gaveUp.lastError).toBe("exited with code 3");
    expect(r.logs.at(-1)).toContain("giving up");
    expect(inst.state).toBe("gave-up");

    const snap = listDaemons().find((d) => d.name === "test.process");
    expect(
      snap?.instances.map((i) => [i.instance, i.state, i.restarts]),
    ).toEqual([["crash", "gave-up", 4]]);
    const runs = await daemonRecentRuns("test.process");
    expect(runs.slice(0, 5).every((run) => run.outcome === "failed")).toBe(
      true,
    );
  }, 30_000);

  test("a running child is stopped for good, its run succeeded", async () => {
    const r = recorder();
    const inst = decl.spawnProcess({
      instance: "sleep",
      argv: () => sleeper,
      onState: r.onState,
      onLog: r.onLog,
    });
    expect(inst.state).toBe("running");
    expect(inst.pid).toBeGreaterThan(0);
    await inst.stop();
    expect(r.states.map((t) => t.state)).toEqual([
      "starting",
      "running",
      "stopped",
    ]);
    expect(
      listDaemons()
        .find((d) => d.name === "test.process")
        ?.instances.some((i) => i.instance === "sleep"),
    ).toBe(false);
    const runs = await daemonRecentRuns("test.process");
    expect(runs[0]?.outcome).toBe("succeeded");
  });

  test("a killed child respawns and counts the restart", async () => {
    const r = recorder();
    const inst = decl.spawnProcess({
      instance: "kill",
      argv: sleeper,
      onState: r.onState,
      onLog: r.onLog,
    });
    live.push(inst);
    const firstPid = inst.pid;
    if (firstPid === null) throw new Error("no pid");
    process.kill(firstPid, "SIGKILL");
    await r.waitFor(
      (s) => s.filter((t) => t.state === "respawning").length === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const snap = listDaemons()
      .find((d) => d.name === "test.process")
      ?.instances.find((i) => i.instance === "kill");
    expect(snap?.restarts).toBe(1);
    expect(snap?.state).toBe("running");
    expect(snap?.lastExit?.reason).toBe("killed by SIGKILL");
    expect(inst.pid).not.toBe(firstPid);
  });

  test("a second live instance of a key throws", () => {
    const inst = decl.spawnProcess({ instance: "dup", argv: sleeper });
    live.push(inst);
    expect(() => decl.spawnProcess({ instance: "dup", argv: sleeper })).toThrow(
      /already running/,
    );
  });
});

describe("guards", () => {
  test("an unregistered declaration refuses to start", () => {
    const decl = defineDaemon({
      name: "test.unregistered",
      description: "Never mounted.",
      startedBy: "on-demand",
      where: "every-worktree",
      restart: { kind: "never" },
    });
    expect(() => decl.spawnProcess({ argv: sleeper })).toThrow(
      /before it was registered/,
    );
  });

  test("a main-only declaration refuses to start in a worktree", () => {
    const decl = defineDaemon({
      name: "test.main-only",
      description: "Main only.",
      startedBy: "boot",
      where: "main",
      restart: { kind: "never" },
    });
    decl.register();
    expect(() => decl.spawnProcess({ argv: sleeper })).toThrow(
      /cannot start in this backend/,
    );
  });

  test("an empty description throws at define", () => {
    expect(() =>
      defineDaemon({
        name: "test.blank",
        description: " ",
        startedBy: "boot",
        where: "every-worktree",
        restart: { kind: "never" },
      }),
    ).toThrow(/description is required/);
  });
});

describe("spawnWorker", () => {
  const decl = defineDaemon({
    name: "test.worker",
    description: "A test worker.",
    startedBy: "on-demand",
    where: "every-worktree",
    restart: { kind: "backoff", healthy: "ready" },
  });
  decl.register();

  test("ready resets the counters; the graceful stop runs before terminate", async () => {
    const dir = newTmpDir();
    const file = join(dir, "worker.ts");
    writeFileSync(
      file,
      `self.onmessage = (e) => { if (e.data === "stop") postMessage("bye"); };\npostMessage("ready");\n`,
    );
    const r = recorder();
    let graceful = false;
    const inst = decl.spawnWorker({
      url: pathToFileURL(file),
      backoff: FAST,
      onMessage: (data, ctx) => {
        if (data === "ready") ctx.ready();
        if (data === "bye") graceful = true;
      },
      stop: async (w) => {
        w.postMessage("stop");
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
      onState: r.onState,
      onLog: r.onLog,
    });
    await r.waitFor((s) => s.some((t) => t.state === "running"));
    expect(inst.pid).toBeNull();
    await inst.stop();
    expect(graceful).toBe(true);
    expect(r.states.map((t) => t.state)).toEqual([
      "starting",
      "running",
      "stopped",
    ]);
  }, 30_000);
});

describe("pid files", () => {
  const decl = defineDaemon({
    name: "test.attached",
    description: "Something this backend did not start.",
    startedBy: "boot",
    where: "every-worktree",
    restart: { kind: "never" },
  });
  decl.register();

  test("attach follows a pid file: absent → starting, live → running, dead → exited, new pid → restart", async () => {
    const dir = newTmpDir();
    const pidFile = asAppPath(join(dir, "x.pid"));
    const inst = decl.attach({ pidFile });
    live.push(inst);
    expect(inst.state).toBe("starting");

    const a = Bun.spawn(sleeper, { stdout: "ignore", stderr: "ignore" });
    writeFileSync(pidFile, `${a.pid}\n`);
    expect(inst.state).toBe("running");
    expect(inst.pid).toBe(a.pid);

    a.kill("SIGKILL");
    await a.exited;
    expect(inst.state).toBe("exited");

    const b = Bun.spawn(sleeper, { stdout: "ignore", stderr: "ignore" });
    writeFileSync(pidFile, `${b.pid}\n`);
    expect(inst.state).toBe("running");
    const snap = listDaemons().find((d) => d.name === "test.attached")
      ?.instances[0];
    expect(snap?.restarts).toBe(1);
    b.kill("SIGKILL");
    await b.exited;
  });

  test("a supervised declaration has no attach", () => {
    const supervised = defineDaemon({
      name: "test.no-attach",
      description: "Supervised.",
      startedBy: "boot",
      where: "every-worktree",
      restart: { kind: "backoff", healthy: "survival" },
    });
    // @ts-expect-error — attach exists only on a never-restart declaration.
    expect(() => supervised.attach({ pidFile: "/nonexistent" })).toThrow(
      /restart: \{ kind: "never" \}/,
    );
  });
});
