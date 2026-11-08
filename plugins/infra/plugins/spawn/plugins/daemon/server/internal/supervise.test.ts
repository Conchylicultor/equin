import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { defineDaemon } from "./define";
import { pidFileWatcher } from "./pid-file-watch";
import {
  daemonRecentRuns,
  listDaemons,
  liveSupervisedIncarnations,
  pidAlive,
  stopOnCodeAdopted,
  type DaemonInstance,
  type DaemonTransition,
} from "./registry";

// The supervision loop, driven with real child processes and Bun Workers: a
// child that dies at once ends in ONE loud give-up; a healthy one respawns
// with its counters reset; stop() ends it for good; a pid file is followed
// through its states — each change pushed by its watch, not read on a get.

// Mounted by this plugin's server barrel at boot; registered by hand here.
pidFileWatcher.register();

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

  const count = (
    states: DaemonTransition[],
    state: DaemonTransition["state"],
  ) => states.filter((t) => t.state === state).length;

  test("attach follows a pid file: absent → starting, live → running, dead → exited, new pid → restart", async () => {
    const dir = newTmpDir();
    const pidFile = asAppPath(join(dir, "x.pid"));
    const r = recorder();
    const inst = decl.attach({ pidFile, onState: r.onState });
    live.push(inst);
    // Not read yet: starting, never a stand-in "absent".
    expect(inst.state).toBe("starting");

    const a = Bun.spawn(sleeper, { stdout: "ignore", stderr: "ignore" });
    writeFileSync(pidFile, `${a.pid}\n`);
    // Pushed by the watch: no get needed for the transition.
    await r.waitFor((s) => count(s, "running") === 1);
    expect(inst.state).toBe("running");
    expect(inst.pid).toBe(a.pid);

    // Killed with its file left behind: no file event, seen on the next get.
    a.kill("SIGKILL");
    await a.exited;
    expect(inst.state).toBe("exited");

    const b = Bun.spawn(sleeper, { stdout: "ignore", stderr: "ignore" });
    writeFileSync(pidFile, `${b.pid}\n`);
    await r.waitFor((s) => count(s, "running") === 2);
    const snap = listDaemons().find((d) => d.name === "test.attached")
      ?.instances[0];
    expect(snap?.restarts).toBe(1);

    // The file removed: the exit is pushed.
    unlinkSync(pidFile);
    await r.waitFor((s) => count(s, "exited") === 2);
    expect(r.states.at(-1)).toMatchObject({
      state: "exited",
      lastError: `pid file ${pidFile} is gone`,
    });
    b.kill("SIGKILL");
    await b.exited;
  });

  test("attach to a live pid reaches running on its first read, unasked", async () => {
    const dir = newTmpDir();
    const pidFile = asAppPath(join(dir, "y.pid"));
    const a = Bun.spawn(sleeper, { stdout: "ignore", stderr: "ignore" });
    writeFileSync(pidFile, `${a.pid}\n`);
    const r = recorder();
    const inst = decl.attach({ instance: "live", pidFile, onState: r.onState });
    live.push(inst);
    await r.waitFor((s) => count(s, "running") === 1);
    expect(r.states.map((t) => t.state)).toEqual(["starting", "running"]);
    a.kill("SIGKILL");
    await a.exited;
  });

  test("a pid file whose folder is missing, or goes and comes back, is watched again on the next get", async () => {
    const dir = newTmpDir();
    const folder = join(dir, "later");
    const pidFile = asAppPath(join(folder, "z.pid"));
    const r = recorder();
    const inst = decl.attach({
      instance: "nested",
      pidFile,
      onState: r.onState,
    });
    live.push(inst);
    // No folder: no watch (it is never created here), the read says absent.
    await Bun.sleep(100);
    expect(inst.state).toBe("starting");
    expect(existsSync(folder)).toBe(false);

    const a = Bun.spawn(sleeper, { stdout: "ignore", stderr: "ignore" });
    mkdirSync(folder);
    writeFileSync(pidFile, `${a.pid}\n`);
    // A get finding nothing alive asks for a read, which opens the watch.
    expect(inst.state).toBe("starting");
    await r.waitFor((s) => count(s, "running") === 1);
    expect(inst.pid).toBe(a.pid);

    // The folder goes: its watch is dropped, the exit pushed.
    rmSync(folder, { recursive: true });
    await r.waitFor((s) => count(s, "exited") === 1);

    // Back, with a new process: the next get re-arms and reads it.
    const b = Bun.spawn(sleeper, { stdout: "ignore", stderr: "ignore" });
    mkdirSync(folder);
    writeFileSync(pidFile, `${b.pid}\n`);
    expect(inst.state).toBe("exited");
    await r.waitFor((s) => count(s, "running") === 2);
    // Watched again: removing the file is pushed with no get.
    unlinkSync(pidFile);
    await r.waitFor((s) => count(s, "exited") === 2);
    for (const p of [a, b]) {
      p.kill("SIGKILL");
      await p.exited;
    }
  });

  test("stop releases the watch: a later write reaches nobody", async () => {
    const dir = newTmpDir();
    const pidFile = asAppPath(join(dir, "s.pid"));
    const r = recorder();
    const inst = decl.attach({
      instance: "stopped",
      pidFile,
      onState: r.onState,
    });
    await inst.stop();
    const a = Bun.spawn(sleeper, { stdout: "ignore", stderr: "ignore" });
    writeFileSync(pidFile, `${a.pid}\n`);
    await Bun.sleep(500);
    expect(r.states.map((t) => t.state)).toEqual(["starting", "stopped"]);
    a.kill("SIGKILL");
    await a.exited;
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

describe("launchDetached", () => {
  const decl = defineDaemon({
    name: "test.detached",
    description: "Something a bootstrap starts detached.",
    startedBy: "on-demand",
    where: "every-worktree",
    restart: { kind: "never" },
  });
  decl.register();

  test("a bootstrap that writes the pid file and exits leaves it running", async () => {
    const dir = newTmpDir();
    const pidFile = asAppPath(join(dir, "d.pid"));
    const r = recorder();
    const inst = decl.launchDetached({
      instance: "ok",
      // Writes the pid at the very end, just before exiting: the read after
      // the bootstrap's exit sees it whether or not the watch did yet.
      argv: ["/bin/sh", "-c", `sleep 30 & echo $! > ${pidFile}`],
      pidFile,
      onState: r.onState,
    });
    live.push(inst);
    expect(inst.state).toBe("starting");
    await r.waitFor((s) => s.some((t) => t.state === "running"));
    const pid = inst.pid;
    if (pid === null) throw new Error("no pid");
    expect(r.states.some((t) => t.state === "exited")).toBe(false);
    process.kill(pid, "SIGKILL");
    // An orphan: launchd reaps it a moment later; until then kill(0) sees it.
    while (pidAlive(pid)) await Bun.sleep(10);
    expect(inst.state).toBe("exited");
  });

  test("a read that started before the bootstrap exited cannot end it", async () => {
    const dir = newTmpDir();
    const pidFile = asAppPath(join(dir, "race.pid"));
    const tmp = join(dir, "race.tmp");
    // The pid file starts as a FIFO, so the follower's first read blocks in
    // flight. The bootstrap holds its write end, renames the real pid file
    // over it and exits 0 — the blocked read lands ("") only after that,
    // when a child the bootstrap leaves behind closes the FIFO. That stale
    // read must not be taken for "the bootstrap exited and wrote nothing".
    Bun.spawnSync(["mkfifo", pidFile]);
    const r = recorder();
    const script = [
      `exec 3>"${pidFile}"`,
      `sleep 30 </dev/null >/dev/null 2>&1 3>&- &`,
      `echo $! > "${tmp}"`,
      `mv "${tmp}" "${pidFile}"`,
      `(sleep 0.5) &`,
      `exit 0`,
    ].join("\n");
    const inst = decl.launchDetached({
      instance: "race",
      argv: ["/bin/sh", "-c", script],
      pidFile,
      onState: r.onState,
    });
    live.push(inst);
    await r.waitFor((s) => s.some((t) => t.state !== "starting"));
    expect(r.states.map((t) => t.state)).toEqual(["starting", "running"]);
    const pid = inst.pid;
    if (pid === null) throw new Error("no pid");
    process.kill(pid, "SIGKILL");
  });

  test("a bootstrap that fails before any pid file exits with its reason", async () => {
    const dir = newTmpDir();
    const pidFile = asAppPath(join(dir, "f.pid"));
    const r = recorder();
    const inst = decl.launchDetached({
      instance: "fail",
      argv: ["/bin/sh", "-c", "exit 4"],
      pidFile,
      onState: r.onState,
    });
    live.push(inst);
    await r.waitFor((s) => s.some((t) => t.state === "exited"));
    expect(r.states.map((t) => t.state)).toEqual(["starting", "exited"]);
    expect(r.states.at(-1)).toMatchObject({
      lastError: "bootstrap exited with code 4",
    });
  });
});

describe("onCodeAdopted", () => {
  const kept = defineDaemon({
    name: "test.adopt-kept",
    description: "A child kept across an adoption.",
    startedBy: "on-demand",
    where: "every-worktree",
    restart: { kind: "never" },
  });
  const cache = defineDaemon({
    name: "test.adopt-stopped",
    description: "A child holding only a cache.",
    startedBy: "on-demand",
    where: "every-worktree",
    restart: { kind: "never" },
    onCodeAdopted: "stop",
  });
  kept.register();
  cache.register();

  test("a stop-on-adoption instance is not judged, and is stopped by stopOnCodeAdopted", async () => {
    const r = recorder();
    const a = kept.spawnProcess({ argv: sleeper });
    live.push(a);
    cache.spawnProcess({ argv: sleeper, onState: r.onState });
    const labels = liveSupervisedIncarnations().map((i) => i.label);
    expect(labels).toContain("test.adopt-kept");
    expect(labels).not.toContain("test.adopt-stopped");
    await stopOnCodeAdopted();
    expect(r.states.at(-1)?.state).toBe("stopped");
    expect(a.state).toBe("running");
    expect(
      listDaemons()
        .find((d) => d.name === "test.adopt-stopped")
        ?.instances.some((i) => i.instance === null),
    ).toBe(false);
  });

  test("only an on-demand daemon may be stopped on adoption", () => {
    expect(() =>
      defineDaemon({
        name: "test.adopt-boot",
        description: "A boot daemon.",
        startedBy: "boot",
        where: "every-worktree",
        restart: { kind: "never" },
        onCodeAdopted: "stop",
      }),
    ).toThrow(/on-demand/);
  });
});
