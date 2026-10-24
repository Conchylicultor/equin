import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { readyForTests } from "@plugins/infra/plugins/deps/deps/testing";
import type { LoginServiceJob } from "../../core";
import { defineLoginService, loginServiceId } from "./define";
import type { LoginService, LoginServiceState } from "./login-service";
import { reconcileLoginService, type ReconcilePolicy } from "./reconcile";

const dir = mkdtempSync(join(tmpdir(), "login-service-reconcile-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const helper = defineDep({
  id: "example-helper",
  owner: "example",
  description: "",
  sizeHint: "",
  source: {
    kind: "fake",
    label: "",
    identityInputs: async () => ({}),
    install: async () => {},
  },
  updates: { none: "a test fixture" },
});

const decl = defineLoginService({
  id: "dev.equin.example",
  owner: "example",
  description: "An example tray helper",
  session: "graphical",
  dep: helper,
  spec: (ready) => ({
    argv: [`${ready.dir}/bin`, "tray"],
    cwd: ready.dir,
    env: {},
    // A folder that does not exist yet: the reconcile creates it.
    stdioLog: join(dir, "logs", "example.log"),
  }),
});

// Not a real install dir, so `holdDep` leaves the deps cache alone.
const oldBuild = readyForTests(helper, "/cache/example-helper/old/env", "old");
const newBuild = readyForTests(helper, "/cache/example-helper/new/env", "new");

// Far beyond any pid a kernel hands out: "gone" the moment it is asked.
const DEAD_PID = 99_999_999;

type Registration = "unregistered" | "registered-unloaded" | "loaded";

/**
 * An in-memory LoginService: the definition is a string, the manager's state
 * a field, every call recorded in order.
 */
function fakeService(registration: Registration, writtenFrom: typeof oldBuild) {
  const calls: string[] = [];
  const render = (job: LoginServiceJob) => JSON.stringify(job);
  let definition: string | null =
    registration === "unregistered"
      ? null
      : render({ description: decl.description, ...decl.spec(writtenFrom) });
  let state: LoginServiceState =
    registration === "loaded"
      ? { kind: "loaded", pid: DEAD_PID, lastExit: null }
      : { kind: "not-loaded" };
  const definitionPath = join(dir, `${registration}-${Math.random()}.def`);
  if (definition !== null) writeFileSync(definitionPath, definition);

  const service: LoginService = {
    id: loginServiceId(decl),
    manager: "fake",
    startsAt: "login",
    definitionPath: () => definitionPath,
    state: async () => state,
    write: (job) => {
      calls.push("write");
      const next = render(job);
      const changed = next !== definition;
      definition = next;
      writeFileSync(definitionPath, next);
      return { path: definitionPath, changed };
    },
    isCurrent: (job) => render(job) === definition,
    installedJob: () => {
      throw new Error("not under test");
    },
    remove: async () => {
      throw new Error("not under test");
    },
    load: async () => {
      calls.push("load");
      state = { kind: "loaded", pid: 4242, lastExit: null };
      return 4242;
    },
    unload: async () => {
      calls.push("unload");
      state = { kind: "not-loaded" };
    },
  };
  return { service, calls, definition: () => definition };
}

const run = (
  registration: Registration,
  job: "same" | "changed",
  policy: ReconcilePolicy,
) => {
  const fake = fakeService(registration, oldBuild);
  const ready = job === "same" ? oldBuild : newBuild;
  return {
    fake,
    outcome: reconcileLoginService(fake.service, decl, ready, policy),
  };
};

describe("reconcileLoginService — follow (main's boot)", () => {
  test("never touches an unregistered service", async () => {
    for (const job of ["same", "changed"] as const) {
      const { fake, outcome } = run("unregistered", job, "follow");
      expect(await outcome).toEqual({ kind: "unregistered" });
      expect(fake.calls).toEqual([]);
      expect(fake.definition()).toBeNull();
    }
  });

  test("a stopped service: an unchanged job is left alone", async () => {
    const { fake, outcome } = run("registered-unloaded", "same", "follow");
    expect(await outcome).toEqual({ kind: "unchanged", pid: null });
    expect(fake.calls).toEqual(["write"]);
  });

  test("a stopped service: a changed job is rewritten, never loaded", async () => {
    const { fake, outcome } = run("registered-unloaded", "changed", "follow");
    expect((await outcome).kind).toBe("rewritten");
    expect(fake.calls).toEqual(["write"]);
    expect(fake.definition()).toContain("/new/env/bin");
  });

  test("a running service with an unchanged job keeps running", async () => {
    const { fake, outcome } = run("loaded", "same", "follow");
    expect(await outcome).toEqual({ kind: "unchanged", pid: DEAD_PID });
    expect(fake.calls).toEqual(["write"]);
  });

  test("a running service with a changed job is reloaded onto it", async () => {
    const { fake, outcome } = run("loaded", "changed", "follow");
    expect(await outcome).toMatchObject({
      kind: "started",
      pid: 4242,
      reloaded: true,
    });
    expect(fake.calls).toEqual(["write", "unload", "load"]);
  });
});

describe("reconcileLoginService — start", () => {
  test("loads a service that is not running, registered or not", async () => {
    for (const registration of [
      "unregistered",
      "registered-unloaded",
    ] as const) {
      for (const job of ["same", "changed"] as const) {
        const { fake, outcome } = run(registration, job, "start");
        expect(await outcome).toMatchObject({
          kind: "started",
          reloaded: false,
        });
        expect(fake.calls).toEqual(["write", "load"]);
      }
    }
  });

  test("leaves a running, unchanged service alone", async () => {
    const { fake, outcome } = run("loaded", "same", "start");
    expect(await outcome).toEqual({ kind: "unchanged", pid: DEAD_PID });
    expect(fake.calls).toEqual(["write"]);
  });

  test("reloads a running service whose job changed", async () => {
    const { fake, outcome } = run("loaded", "changed", "start");
    expect(await outcome).toMatchObject({ kind: "started", reloaded: true });
    expect(fake.calls).toEqual(["write", "unload", "load"]);
  });
});

describe("reconcileLoginService — force", () => {
  test("always (re)loads", async () => {
    for (const registration of [
      "unregistered",
      "registered-unloaded",
      "loaded",
    ] as const) {
      for (const job of ["same", "changed"] as const) {
        const { fake, outcome } = run(registration, job, "force");
        const loaded = registration === "loaded";
        expect(await outcome).toMatchObject({
          kind: "started",
          reloaded: loaded,
        });
        expect(fake.calls).toEqual(
          loaded ? ["write", "unload", "load"] : ["write", "load"],
        );
      }
    }
  });
});

test("a (re)load truncates the stdio log, creating its folder", async () => {
  const { outcome } = run("unregistered", "changed", "start");
  await outcome;
  expect(readFileSync(join(dir, "logs", "example.log"), "utf-8")).toBe("");
});
