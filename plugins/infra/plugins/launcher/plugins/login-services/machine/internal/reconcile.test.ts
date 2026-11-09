import { afterAll, describe, expect, test } from "bun:test";
import {
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { readyForTests } from "@plugins/infra/plugins/deps/deps/testing";
import {
  componentIdentity,
  unbundledExecutable,
  type LoginServiceJob,
} from "../../core";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { defineLoginService, loginServiceId, loginServiceJob } from "./define";
import type {
  LoginService,
  LoginServiceManager,
  LoginServiceState,
} from "./login-service";
import type { BundleSigner } from "@plugins/infra/plugins/codesign/deps";
import type { MacosAppHost } from "./macos-app";
import {
  reconcileLoginService,
  reloadService,
  type ReconcilePolicy,
} from "./reconcile";

const dir = asAppPath(mkdtempSync(join(tmpdir(), "login-service-reconcile-")));
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
  executable: {
    name: "example",
    build: (ready) => ({
      file: asAppPath(`${ready.dir}/bin`),
      identity: componentIdentity(helper.id, ready.identity),
    }),
  },
  spec: (ready, executable, _labels, signer) => ({
    argv: [executable, "tray"],
    cwd: ready.dir,
    env:
      signer === null
        ? {}
        : ({ SIGNER: signer.sha1 } as Record<string, string>),
    // A folder that does not exist yet: the reconcile creates it.
    stdioLog: joinAppPath(dir, "logs", "example.log"),
  }),
});

// Not a real install dir, so `holdDep` leaves the deps cache alone.
const oldBuild = readyForTests(
  helper,
  asAppPath("/cache/example-helper/old/env"),
  "old",
);
const newBuild = readyForTests(
  helper,
  asAppPath("/cache/example-helper/new/env"),
  "new",
);

// Far beyond any pid a kernel hands out: "gone" the moment it is asked.
const DEAD_PID = 99_999_999;

type Registration = "unregistered" | "registered-unloaded" | "loaded";

/**
 * An in-memory LoginService: the definition is a string, the manager's state
 * a field, every call recorded in order.
 */
function fakeService(
  registration: Registration,
  writtenFrom: typeof oldBuild,
  d: typeof decl = decl,
  loadedPid: number | null = DEAD_PID,
) {
  const calls: string[] = [];
  const render = (job: LoginServiceJob) => JSON.stringify(job);
  let definition: string | null =
    registration === "unregistered"
      ? null
      : render(
          loginServiceJob(
            d,
            writtenFrom,
            unbundledExecutable(d.executable.build(writtenFrom)),
            {},
            null,
          ),
        );
  let state: LoginServiceState =
    registration === "loaded"
      ? { kind: "loaded", pid: loadedPid, lastExit: null }
      : { kind: "not-loaded" };
  const definitionPath = joinAppPath(
    dir,
    `${registration}-${Math.random()}.def`,
  );
  if (definition !== null) writeFileSync(definitionPath, definition);

  const service: LoginService = {
    id: loginServiceId(d),
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
      return Promise.resolve({ path: definitionPath, changed });
    },
    isCurrent: (job) => Promise.resolve(render(job) === definition),
    installedJob: async () => {
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
  // The manager hands out this one service: the reconcile binds it itself.
  const manager: LoginServiceManager = {
    manager: "fake",
    service: async (id) => {
      if (id.label !== service.id.label)
        throw new Error(`no fake service ${id.label}`);
      return service;
    },
  };
  return { service, manager, calls, definition: () => definition };
}

/** A host with no app bundle (Linux): the service runs its build where it is. */
const unbundled: MacosAppHost = {
  platform: "linux",
  bundle: asAppPath("/nowhere/equin.app"),
  withLock: () => {
    throw new Error("nothing is installed off macOS");
  },
  sign: () => {
    throw new Error("nothing is signed off macOS");
  },
  isSigned: () => {
    throw new Error("nothing is signed off macOS");
  },
  signer: async () => null,
  register: () => {
    throw new Error("nothing is registered off macOS");
  },
  executablesInUse: () => {
    throw new Error("nothing is swapped off macOS");
  },
};

const run = (
  registration: Registration,
  job: "same" | "changed",
  policy: ReconcilePolicy,
) => {
  const fake = fakeService(registration, oldBuild);
  const ready = job === "same" ? oldBuild : newBuild;
  return {
    fake,
    outcome: reconcileLoginService(fake.manager, decl, ready, policy, {
      host: unbundled,
      log: () => {},
    }).then((r) => r.outcome),
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

describe("reconcileLoginService — a periodic service", () => {
  const periodic = defineLoginService({
    ...decl,
    id: "dev.equin.example-monitor",
    schedule: { everySeconds: 30 },
  });

  test("held by the manager between runs (no pid) counts as running", async () => {
    const fake = fakeService("loaded", oldBuild, periodic, null);
    const { outcome } = await reconcileLoginService(
      fake.manager,
      periodic,
      oldBuild,
      "start",
      { host: unbundled, log: () => {} },
    );
    expect(outcome).toEqual({ kind: "unchanged", pid: null });
    expect(fake.calls).toEqual(["write"]);
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

describe("reconcileLoginService — macOS (the equin app bundle)", () => {
  // Real build files, so the install copies something; signing is faked.
  const builds = joinAppPath(dir, "builds");
  const build = (identity: string) => {
    const env = joinAppPath(builds, identity);
    mkdirSync(env, { recursive: true });
    writeFileSync(join(env, "bin"), `binary ${identity}`);
    return readyForTests(helper, env, identity);
  };
  const bundle = joinAppPath(dir, "app", "equin.app");
  let signer: BundleSigner | null = null;
  const host: MacosAppHost = {
    platform: "darwin",
    bundle,
    withLock: (fn) => fn(),
    sign: async () => {},
    isSigned: async () => true,
    signer: async () => signer,
    register: async () => {},
    executablesInUse: async () => [],
  };
  const reconcile = (
    manager: LoginServiceManager,
    ready: ReturnType<typeof build>,
  ) =>
    reconcileLoginService(manager, decl, ready, "follow", {
      host,
      log: () => {},
    }).then((r) => r.outcome);

  test("the job runs the executable from the bundle and names its build in the environment", async () => {
    const one = build("one");
    const fake = fakeService("loaded", one);
    await reconcile(fake.manager, one);
    const job = JSON.parse(fake.definition()!) as LoginServiceJob;
    expect(job.argv[0]).toBe(join(bundle, "Contents", "MacOS", "example"));
    expect(readEnv("APP_COMPONENT", job.env)).toBe("example-helper@one");
    expect(
      readFileSync(join(bundle, "Contents", "MacOS", "example"), "utf8"),
    ).toBe("binary one");
  });

  test("a rebuilt component is a changed job at the same path, and reloads", async () => {
    const one = build("one");
    const two = build("two");
    const fake = fakeService("loaded", one);
    await reconcile(fake.manager, one);
    fake.calls.length = 0;
    const outcome = await reconcile(fake.manager, two);
    expect(outcome).toMatchObject({ kind: "started", reloaded: true });
    expect(fake.calls).toEqual(["write", "unload", "load"]);
    const job = JSON.parse(fake.definition()!) as LoginServiceJob;
    expect(job.argv[0]).toBe(join(bundle, "Contents", "MacOS", "example"));
    expect(readEnv("APP_COMPONENT", job.env)).toBe("example-helper@two");
  });

  test("the machine's signer reaches the job: a new identity is a changed job, and reloads", async () => {
    const one = build("one");
    const fake = fakeService("loaded", one);
    signer = { sha1: "aa", label: "A", sign: ["sign"], verify: ["verify"] };
    await reconcile(fake.manager, one);
    expect((JSON.parse(fake.definition()!) as LoginServiceJob).env.SIGNER).toBe(
      "aa",
    );
    fake.calls.length = 0;
    signer = { ...signer, sha1: "bb" };
    const outcome = await reconcile(fake.manager, one);
    expect(outcome).toMatchObject({ kind: "started", reloaded: true });
    expect((JSON.parse(fake.definition()!) as LoginServiceJob).env.SIGNER).toBe(
      "bb",
    );
    signer = null;
  });
});

describe("reloadService — once unloaded, always loaded", () => {
  // This test process: alive for the whole test, like an old generation that
  // will not die.
  const LIVE_PID = process.pid;

  test("a wait that gives up still loads, and a load that goes through is the proof the old one is gone", async () => {
    const fake = fakeService("loaded", oldBuild, decl, LIVE_PID);
    const pid = await reloadService(
      fake.service,
      LIVE_PID,
      () => {
        fake.calls.push("before-load");
      },
      200,
    );
    expect(pid).toBe(4242);
    // beforeLoad (the log truncation) is skipped: the old process's output is
    // the record of what it was stuck in.
    expect(fake.calls).toEqual(["unload", "load"]);
  });

  test("when the load fails too, both failures are thrown together", async () => {
    const fake = fakeService("loaded", oldBuild, decl, LIVE_PID);
    fake.service.load = async () => {
      fake.calls.push("load");
      throw new Error("Bootstrap failed: 5: Input/output error");
    };
    const err = await reloadService(
      fake.service,
      LIVE_PID,
      () => {},
      200,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    const { errors, message } = err as AggregateError;
    expect(errors).toHaveLength(2);
    expect(String(errors[0])).toContain(`Process ${LIVE_PID} is still running`);
    expect(message).toContain("Input/output error");
    expect(fake.calls).toEqual(["unload", "load"]);
  });

  test("beforeLoad runs between the wait and the load", async () => {
    const fake = fakeService("loaded", oldBuild);
    await reloadService(fake.service, DEAD_PID, () => {
      fake.calls.push("before-load");
    });
    expect(fake.calls).toEqual(["unload", "before-load", "load"]);
  });
});
