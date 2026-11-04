import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import { defineDep, type DepSource, type InstallContext } from "./dep";
import { depState, ensureDep, readyNow, removeDep } from "./ensure";
import { releaseLock, tryLock } from "./lock";
import { identityOf, installPaths, type DepStore } from "./store";

let base: AppPath;
let store: DepStore;

beforeEach(() => {
  base = asAppPath(mkdtempSync(join(tmpdir(), "deps-test-")));
  store = {
    cacheRoot: joinAppPath(base, "cache"),
    locksRoot: joinAppPath(base, "locks"),
  };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A fake installer kind: inputs from a mutable box, install writes one file. */
interface Box {
  version: string;
  installs: number;
  delayMs?: number;
  fail?: string;
}

function fakeSource(box: Box): DepSource<"fake"> {
  return {
    kind: "fake",
    label: "fake source",
    identityInputs: async () => ({ version: box.version }),
    async install(ctx: InstallContext) {
      box.installs++;
      ctx.log(`installing fake ${box.version}`);
      if (box.delayMs !== undefined) await Bun.sleep(box.delayMs);
      if (box.fail !== undefined) throw new Error(box.fail);
      mkdirSync(ctx.dir, { recursive: true });
      writeFileSync(join(ctx.dir, "payload.txt"), `v${box.version}`);
    },
  };
}

function fakeDep(box: Box) {
  return defineDep({
    id: "fake-dep",
    owner: "infra/deps",
    description: "a test dependency",
    sizeHint: "1 KB",
    source: fakeSource(box),
    updates: { none: "a test fixture" },
  });
}

const exec = execContextForTests();

describe("identity", () => {
  test("changes with each input, ignores key order, and includes the kind", () => {
    const a = identityOf("python", { lock: "1", uv: "0.8" });
    expect(identityOf("python", { uv: "0.8", lock: "1" })).toBe(a);
    expect(identityOf("python", { lock: "2", uv: "0.8" })).not.toBe(a);
    expect(identityOf("python", { lock: "1", uv: "0.9" })).not.toBe(a);
    expect(identityOf("download", { lock: "1", uv: "0.8" })).not.toBe(a);
  });

  test("a changed input is a new install", async () => {
    const box = { version: "1", installs: 0 };
    const dep = fakeDep(box);
    const first = await ensureDep(dep, exec, { store, root: base });
    box.version = "2";
    const second = await ensureDep(dep, exec, { store, root: base });
    expect(second.identity).not.toBe(first.identity);
    expect(box.installs).toBe(2);
    expect(readFileSync(join(second.dir, "payload.txt"), "utf8")).toBe("v2");
  });
});

describe("ensureDep", () => {
  test("installs once, then answers from ready.json", async () => {
    const box = { version: "1", installs: 0 };
    const dep = fakeDep(box);
    const ready = await ensureDep(dep, exec, { store, root: base });
    await ensureDep(dep, exec, { store, root: base });
    expect(box.installs).toBe(1);
    const paths = installPaths(store, dep.id, ready.identity);
    expect(existsSync(paths.ready)).toBe(true);
    expect(existsSync(paths.installing)).toBe(false);
    expect(readFileSync(paths.log, "utf8")).toContain("installing fake-dep");
  });

  test("an interrupted install reads as absent and installs again", async () => {
    const box = { version: "1", installs: 0 };
    const dep = fakeDep(box);
    const identity = identityOf("fake", { version: "1" });
    const paths = installPaths(store, dep.id, identity);
    // What a killed installer leaves: its marker and a partial payload, no
    // ready.json, and (the kernel released it) no lock.
    mkdirSync(join(paths.env, "half"), { recursive: true });
    writeFileSync(
      paths.installing,
      JSON.stringify({ since: new Date().toISOString(), pid: 1 }),
    );
    expect(await depState(dep, { store, root: base })).toEqual({
      kind: "absent",
    });

    const ready = await ensureDep(dep, exec, { store, root: base });
    expect(box.installs).toBe(1);
    expect(existsSync(join(ready.dir, "half"))).toBe(false);
    expect(existsSync(join(ready.dir, "payload.txt"))).toBe(true);
  });

  test("two concurrent calls install once", async () => {
    const box = { version: "1", installs: 0, delayMs: 300 };
    const dep = fakeDep(box);
    const [a, b] = await Promise.all([
      ensureDep(dep, exec, { store, root: base }),
      ensureDep(dep, exec, { store, root: base }),
    ]);
    expect(box.installs).toBe(1);
    expect(a.dir).toBe(b.dir);
  });

  test("a payload that is no longer intact is installed again", async () => {
    const box = { version: "1", installs: 0 };
    const source = {
      ...fakeSource(box),
      isIntact: (dir: AppPath) => existsSync(join(dir, "payload.txt")),
    };
    const dep = defineDep({
      id: "fragile",
      owner: "infra/deps",
      description: "",
      sizeHint: "",
      source,
      updates: { none: "a test fixture" },
    });
    const ready = await ensureDep(dep, exec, { store, root: base });
    rmSync(join(ready.dir, "payload.txt"));
    expect((await depState(dep, { store, root: base })).kind).toBe("absent");
    await ensureDep(dep, exec, { store, root: base });
    expect(box.installs).toBe(2);
  });
});

describe("InstallContext.run", () => {
  test("appends each command's output to the install log; a failure throws with its tail", async () => {
    let calls = 0;
    const dep = defineDep({
      id: "runs",
      owner: "infra/deps",
      description: "",
      sizeHint: "",
      source: {
        kind: "fake",
        label: "",
        identityInputs: async () => ({ calls: String(calls) }),
        async install(ctx) {
          calls++;
          await ctx.run(["sh", "-c", "echo hello from the child"], {
            cwd: base,
            env: process.env,
            timeoutMs: 10_000,
          });
          if (calls === 1) {
            await ctx.run(["sh", "-c", "echo about to fail >&2; exit 4"], {
              cwd: base,
              env: process.env,
              timeoutMs: 10_000,
            });
          }
          mkdirSync(ctx.dir, { recursive: true });
        },
      },
      updates: { none: "a test fixture" },
    });
    const lines: string[] = [];
    const err = await ensureDep(dep, exec, {
      store,
      root: base,
      log: (l) => lines.push(l),
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("exit 4");
    expect((err as Error).message).toContain("about to fail");
    expect(lines).toContain("hello from the child");
    const paths = installPaths(
      store,
      dep.id,
      identityOf("fake", { calls: "0" }),
    );
    const log = readFileSync(paths.log, "utf8");
    expect(log).toContain("$ sh -c echo hello from the child");
    expect(log).toContain("hello from the child");
    expect(log).toContain("about to fail");
  });
});

describe("depState", () => {
  test("covers absent, installing, ready and failed", async () => {
    const box: Box = { version: "1", installs: 0 };
    const dep = fakeDep(box);
    const identity = identityOf("fake", { version: "1" });
    const paths = installPaths(store, dep.id, identity);

    expect(await depState(dep, { store, root: base })).toEqual({
      kind: "absent",
    });

    // installing: the lock is held, installing.json says since when.
    mkdirSync(paths.root, { recursive: true });
    // A progress meter rewrites its line with \r: only the last state shows.
    writeFileSync(paths.log, "line 1\n 10%\r 55%\rline 2\r\n");
    writeFileSync(
      paths.installing,
      JSON.stringify({ since: "2026-09-29T10:00:00.000Z", pid: 1 }),
    );
    const fd = tryLock(paths.lock);
    expect(fd).not.toBeNull();
    expect(await depState(dep, { store, root: base })).toEqual({
      kind: "installing",
      since: "2026-09-29T10:00:00.000Z",
      logTail: ["line 1", "line 2"],
    });
    releaseLock(fd!);
    rmSync(paths.root, { recursive: true });

    // failed: the install threw, and ensureDep rethrows it.
    box.fail = "network unreachable";
    const err = await ensureDep(dep, exec, { store, root: base }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe("network unreachable");
    const failed = await depState(dep, { store, root: base });
    expect(failed.kind).toBe("failed");
    expect(failed.kind === "failed" && failed.message).toBe(
      "network unreachable",
    );

    // ready: a retry succeeds and clears the failure.
    box.fail = undefined;
    await ensureDep(dep, exec, { store, root: base });
    const ready = await depState(dep, { store, root: base });
    expect(ready.kind).toBe("ready");
    expect(ready.kind === "ready" && ready.identity).toBe(identity);
    expect(ready.kind === "ready" && ready.lastUsed).not.toBeNull();
    expect(existsSync(paths.failed)).toBe(false);
  });

  test("an identity that cannot be derived is a failure, not absent", async () => {
    const dep = defineDep({
      id: "no-installer",
      owner: "infra/deps",
      description: "",
      sizeHint: "",
      source: {
        kind: "fake",
        label: "",
        identityInputs: async () => {
          throw new Error("uv is not on the runtime PATH");
        },
        install: async () => {},
      },
      updates: { none: "a test fixture" },
    });
    const state = await depState(dep, { store, root: base });
    expect(state.kind).toBe("failed");
    expect(state.kind === "failed" && state.message).toContain("uv is not");
  });
});

describe("readyNow", () => {
  test("answers every arm without ever installing", async () => {
    const box: Box = { version: "1", installs: 0 };
    const dep = fakeDep(box);
    const identity = identityOf("fake", { version: "1" });
    const paths = installPaths(store, dep.id, identity);

    // absent: nothing installed, and asking does not install.
    expect(await readyNow(dep, { store, root: base })).toEqual({
      kind: "absent",
    });
    expect(box.installs).toBe(0);

    // installing: another process holds the lock.
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.log, "downloading\n");
    writeFileSync(
      paths.installing,
      JSON.stringify({ since: "2026-09-30T10:00:00.000Z", pid: 1 }),
    );
    const fd = tryLock(paths.lock);
    expect(fd).not.toBeNull();
    expect(await readyNow(dep, { store, root: base })).toEqual({
      kind: "installing",
      since: "2026-09-30T10:00:00.000Z",
      logTail: ["downloading"],
    });
    releaseLock(fd!);
    rmSync(paths.root, { recursive: true });

    // failed: the last install threw.
    box.fail = "disk full";
    await ensureDep(dep, exec, { store, root: base }).catch((e: unknown) => e);
    const failed = await readyNow(dep, { store, root: base });
    expect(failed.kind).toBe("failed");
    expect(failed.kind === "failed" && failed.message).toBe("disk full");

    // ready: the proof, pointing at the payload, counted as a use.
    box.fail = undefined;
    await ensureDep(dep, exec, { store, root: base });
    rmSync(paths.lastUsed);
    const ready = await readyNow(dep, { store, root: base });
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") throw new Error("unreachable");
    expect(ready.ready.identity).toBe(identity);
    expect(ready.ready.dir).toBe(paths.env);
    expect(ready.ready.dep).toBe(dep);
    expect(readFileSync(join(ready.ready.dir, "payload.txt"), "utf8")).toBe(
      "v1",
    );
    expect(existsSync(paths.lastUsed)).toBe(true);
    expect(box.installs).toBe(2);
  });

  test("a payload that is no longer intact is not ready", async () => {
    const box = { version: "1", installs: 0 };
    const dep = defineDep({
      id: "fragile-now",
      owner: "infra/deps",
      description: "",
      sizeHint: "",
      source: {
        ...fakeSource(box),
        isIntact: (dir: AppPath) => existsSync(join(dir, "payload.txt")),
      },
      updates: { none: "a test fixture" },
    });
    const installed = await ensureDep(dep, exec, { store, root: base });
    rmSync(join(installed.dir, "payload.txt"));
    expect(await readyNow(dep, { store, root: base })).toEqual({
      kind: "absent",
    });
  });

  test("an identity that cannot be derived is failed", async () => {
    const dep = defineDep({
      id: "underivable",
      owner: "infra/deps",
      description: "",
      sizeHint: "",
      source: {
        kind: "fake",
        label: "",
        identityInputs: async () => {
          throw new Error("go is not installed");
        },
        install: async () => {},
      },
      updates: { none: "a test fixture" },
    });
    const state = await readyNow(dep, { store, root: base });
    expect(state.kind).toBe("failed");
    expect(state.kind === "failed" && state.message).toContain(
      "cannot derive the identity: go is not installed",
    );
  });
});

describe("removeDep", () => {
  test("removes the install, refuses while locked, and is absent after", async () => {
    const box = { version: "1", installs: 0 };
    const dep = fakeDep(box);
    const ready = await ensureDep(dep, exec, { store, root: base });
    const paths = installPaths(store, dep.id, ready.identity);

    const fd = tryLock(paths.lock);
    expect(await removeDep(dep, { store, root: base })).toEqual({
      kind: "busy",
    });
    releaseLock(fd!);

    const removed = await removeDep(dep, { store, root: base });
    expect(removed.kind).toBe("removed");
    expect(existsSync(paths.root)).toBe(false);
    expect(await removeDep(dep, { store, root: base })).toEqual({
      kind: "absent",
    });
    expect((await depState(dep, { store, root: base })).kind).toBe("absent");
  });
});
