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
import {
  defineDep,
  hostTarget,
  type DepSource,
  type DepTarget,
  type TargetedSource,
} from "./dep";
import { depState, ensureDep, readyNow, removeDep } from "./ensure";
import { holdDep } from "./hold";
import { sealDep } from "./seal";
import { readSealedManifest, SEALED_MANIFEST } from "./sealed";
import { identityOf, installPaths, type DepStore } from "./store";
import { sweepDeps } from "./sweep";

let base: AppPath;
let store: DepStore;
let bundle: AppPath;

beforeEach(() => {
  base = asAppPath(mkdtempSync(join(tmpdir(), "deps-seal-")));
  store = {
    cacheRoot: joinAppPath(base, "cache"),
    locksRoot: joinAppPath(base, "locks"),
  };
  bundle = joinAppPath(base, "bundle");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const exec = execContextForTests();

const HOST = hostTarget();
const FOREIGN: DepTarget =
  HOST.platform === "linux"
    ? { platform: "darwin", arch: "arm64" }
    : { platform: "linux", arch: "x64" };

interface Calls {
  identity: number;
  install: DepTarget[];
}

/**
 * A fake kind that can install for a target: its payload names the target,
 * and it counts every identity derivation and install, so a test can prove a
 * sealed root never reaches either.
 */
function targetable(
  calls: Calls,
  can: (t: DepTarget) => boolean = () => true,
): DepSource<"fake"> & { forTarget(t: DepTarget): TargetedSource } {
  const make = (
    target: DepTarget,
  ): DepSource<"fake"> & {
    forTarget(t: DepTarget): TargetedSource;
  } => ({
    kind: "fake",
    label: "fake targetable source",
    async identityInputs() {
      calls.identity++;
      return { version: "1", target: `${target.platform}/${target.arch}` };
    },
    async install(ctx) {
      calls.install.push(target);
      mkdirSync(ctx.dir, { recursive: true });
      writeFileSync(
        join(ctx.dir, "payload"),
        `${target.platform}/${target.arch}`,
      );
    },
    isIntact: (dir) => existsSync(join(dir, "payload")),
    forTarget: (t) =>
      can(t)
        ? { ok: true, source: make(t) }
        : { ok: false, reason: `cannot build ${t.platform}/${t.arch}` },
  });
  return make(HOST);
}

function fakeDep(
  calls: Calls,
  bundleSpec: "required" | { optional: string },
  can?: (t: DepTarget) => boolean,
  id = "fake-sealed",
) {
  return defineDep({
    id,
    owner: "infra/deps",
    description: "",
    sizeHint: "",
    source: targetable(calls, can),
    updates: { none: "a test fixture" },
    bundle: bundleSpec,
  });
}

describe("sealDep", () => {
  test("installs FOR the target, copies the payload and records its identity", async () => {
    const calls: Calls = { identity: 0, install: [] };
    const dep = fakeDep(calls, "required");
    const sealed = await sealDep(dep, {
      target: FOREIGN,
      outDir: bundle,
      exec,
      root: base,
      store,
    });
    if (sealed.kind !== "sealed") throw new Error("expected sealed");
    // The target reached the kind's install.
    expect(calls.install).toEqual([FOREIGN]);
    expect(readFileSync(join(sealed.dir, "payload"), "utf8")).toBe(
      `${FOREIGN.platform}/${FOREIGN.arch}`,
    );
    const manifest = readSealedManifest(join(bundle, SEALED_MANIFEST));
    expect(manifest.target).toEqual({ ...FOREIGN });
    expect(manifest.deps[dep.id]).toEqual({
      kind: "fake",
      identity: sealed.identity,
      dir: "deps/fake-sealed",
      bytes: sealed.bytes,
    });
    // A foreign identity names its target, so it is never the host's.
    expect(sealed.identity).toBe(
      identityOf("fake", {
        version: "1",
        target: `${FOREIGN.platform}/${FOREIGN.arch}`,
      }),
    );

    // Sealed again for the same target: the host cache already holds it.
    await sealDep(dep, {
      target: FOREIGN,
      outDir: bundle,
      exec,
      root: base,
      store,
    });
    expect(calls.install).toHaveLength(1);
  });

  test("a required dependency the kind cannot build for the target fails the release", async () => {
    const calls: Calls = { identity: 0, install: [] };
    const dep = fakeDep(calls, "required", (t) => t === HOST);
    expect(
      sealDep(dep, {
        target: FOREIGN,
        outDir: bundle,
        exec,
        root: base,
        store,
      }),
    ).rejects.toThrow(/required in every bundle.*cannot build/);
  });

  test("an optional one is left out, and the bundle says why", async () => {
    const calls: Calls = { identity: 0, install: [] };
    const dep = fakeDep(
      calls,
      { optional: "the app runs without it" },
      (t) => t === HOST,
    );
    const out = await sealDep(dep, {
      target: FOREIGN,
      outDir: bundle,
      exec,
      root: base,
      store,
    });
    expect(out.kind).toBe("left-out");
    const manifest = readSealedManifest(join(bundle, SEALED_MANIFEST));
    expect(manifest.unsealed[dep.id]).toContain("the app runs without it");
    expect(calls.install).toHaveLength(0);
  });

  test("one bundle holds one target", async () => {
    const calls: Calls = { identity: 0, install: [] };
    await sealDep(fakeDep(calls, "required"), {
      target: FOREIGN,
      outDir: bundle,
      exec,
      root: base,
      store,
    });
    expect(
      sealDep(fakeDep(calls, "required", undefined, "other-dep"), {
        target: HOST,
        outDir: bundle,
        exec,
        root: base,
        store,
      }),
    ).rejects.toThrow(/seals a bundle for/);
  });
});

describe("a sealed root", () => {
  test("resolves from the manifest: no identity derived, nothing installed", async () => {
    const calls: Calls = { identity: 0, install: [] };
    const dep = fakeDep(calls, "required");
    const sealed = await sealDep(dep, {
      target: HOST,
      outDir: bundle,
      exec,
      root: base,
      store,
    });
    if (sealed.kind !== "sealed") throw new Error("expected sealed");
    // The bundle is its own: nothing points back into the build machine's cache.
    rmSync(store.cacheRoot, { recursive: true, force: true });
    const before = { ...calls, install: [...calls.install] };

    const ready = await ensureDep(dep, exec, { root: bundle, store });
    expect(ready.dir).toBe(joinAppPath(bundle, "deps", dep.id));
    expect(ready.identity).toBe(sealed.identity);
    const now = await readyNow(dep, { root: bundle, store });
    expect(now.kind === "ready" && now.ready.dir).toBe(ready.dir);
    expect(await depState(dep, { root: bundle, store })).toEqual({
      kind: "ready",
      identity: sealed.identity,
      bytes: sealed.bytes,
      lastUsed: null,
    });
    // The manifest overrides identityInputs entirely.
    expect(calls.identity).toBe(before.identity);
    expect(calls.install).toEqual(before.install);
    expect(existsSync(store.cacheRoot)).toBe(false);
    expect(removeDep(dep, { root: bundle, store })).rejects.toThrow(
      /sealed release bundle/,
    );
  });

  test("a dependency it does not carry cannot be installed there", async () => {
    const calls: Calls = { identity: 0, install: [] };
    await sealDep(fakeDep(calls, "required"), {
      target: HOST,
      outDir: bundle,
      exec,
      root: base,
      store,
    });
    const missing = fakeDep(calls, "required", undefined, "not-in-bundle");
    const identityBefore = calls.identity;
    expect(ensureDep(missing, exec, { root: bundle, store })).rejects.toThrow(
      /not sealed into this bundle/,
    );
    const now = await readyNow(missing, { root: bundle, store });
    expect(now.kind).toBe("failed");
    expect(calls.identity).toBe(identityBefore);
  });

  test("an optional one left out reads as failed, with the reason", async () => {
    const calls: Calls = { identity: 0, install: [] };
    const dep = fakeDep(
      calls,
      { optional: "fine without it" },
      (t) => t === HOST,
    );
    await sealDep(dep, {
      target: FOREIGN,
      outDir: bundle,
      exec,
      root: base,
      store,
    });
    // Read on the bundle's own platform — simulated by rewriting the manifest's target.
    const path = join(bundle, SEALED_MANIFEST);
    const m = readSealedManifest(path);
    writeFileSync(path, JSON.stringify({ ...m, target: HOST }));
    const state = await depState(dep, { root: bundle, store });
    expect(state.kind === "failed" && state.message).toContain(
      "left out of this bundle",
    );
  });

  test("a bundle read on another platform fails instead of loading its payload", async () => {
    const calls: Calls = { identity: 0, install: [] };
    const dep = fakeDep(calls, "required");
    await sealDep(dep, {
      target: FOREIGN,
      outDir: bundle,
      exec,
      root: base,
      store,
    });
    const now = await readyNow(dep, { root: bundle, store });
    expect(now.kind === "failed" && now.message).toContain("sealed for");
  });
});

describe("holdDep", () => {
  test("keeps a held identity from the sweep, and moves with the holder", async () => {
    const box = { v: "1" };
    const dep = defineDep({
      id: "held-dep",
      owner: "infra/deps",
      description: "",
      sizeHint: "",
      source: {
        kind: "fake",
        label: "",
        identityInputs: async () => ({ v: box.v }),
        async install(ctx) {
          mkdirSync(ctx.dir, { recursive: true });
        },
      } satisfies DepSource<"fake">,
      updates: { none: "a test fixture" },
    });
    const first = await ensureDep(dep, exec, { root: base, store });
    holdDep(first, "machine-gateway", { store });
    box.v = "2";
    const second = await ensureDep(dep, exec, { root: base, store });

    // Long idle, and current for no checkout: only the hold keeps `first`.
    const sweep = () =>
      sweepDeps({
        store,
        deps: [dep],
        checkouts: [base],
        now: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        idleMs: 1,
      });
    expect((await sweep()).removed).toEqual([]);
    expect(existsSync(first.dir)).toBe(true);

    // Holding the new build releases the old one to the sweep.
    holdDep(second, "machine-gateway", { store });
    expect((await sweep()).removed).toEqual([`held-dep/${first.identity}`]);
    expect(existsSync(installPaths(store, dep.id, second.identity).root)).toBe(
      true,
    );
  });
});
