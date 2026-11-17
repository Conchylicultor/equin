import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import { defineDep, type DepSource } from "./dep";
import { removeDep } from "./ensure";
import { heldDep } from "./hold";
import { holdRunningDep, pinDep, pinnedDep } from "./pin";
import { sweepDeps } from "./sweep";

let base: string;
let root: AppPath;
let store: { cacheRoot: AppPath; locksRoot: AppPath };
const exec = execContextForTests();

/** A source whose identity is the checkout's `version` file, installing it as `env/v`. */
const source: DepSource<"pin-test"> = {
  kind: "pin-test",
  label: "the version file",
  async identityInputs(r) {
    return { version: await readFile(join(r, "version"), "utf8") };
  },
  async install(ctx) {
    mkdirSync(ctx.dir, { recursive: true });
    writeFileSync(
      join(ctx.dir, "v"),
      readFileSync(join(ctx.root, "version"), "utf8"),
    );
  },
};

const dep = defineDep({
  id: "pin-test",
  owner: "infra/deps",
  description: "",
  sizeHint: "",
  source,
  updates: { none: "test" },
  pin: { holder: "machine-pin-test", appliesAt: "the next restart" },
});

const version = (v: string) => writeFileSync(join(root, "version"), v);
const payload = (dir: string) => readFileSync(join(dir, "v"), "utf8");

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "deps-pin-test-"));
  root = joinAppPath(asAppPath(base), "repo");
  store = {
    cacheRoot: joinAppPath(asAppPath(base), "cache"),
    locksRoot: joinAppPath(asAppPath(base), "locks"),
  };
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("pinned dependencies", () => {
  test("the first start pins the checkout's install; later ones keep it whatever the checkout declares", async () => {
    version("1");
    const first = await pinnedDep(dep, exec, { root, store });
    expect(first.adopted).toBe(true);
    expect(payload(first.ready.dir)).toBe("1");

    version("2");
    const later = await pinnedDep(dep, exec, { root, store });
    expect(later.adopted).toBe(false);
    expect(later.ready.identity).toBe(first.ready.identity);
    expect(payload(later.ready.dir)).toBe("1");
    expect(later.drift.kind).toBe("differs");
  });

  test("pinDep is the switch: the next start runs the checkout's install", async () => {
    version("1");
    const old = (await pinnedDep(dep, exec, { root, store })).ready;
    version("2");
    const moved = await pinDep(dep, exec, { root, store });
    expect(moved.from?.identity).toBe(old.identity);
    expect(payload(moved.to.dir)).toBe("2");
    const next = await pinnedDep(dep, exec, { root, store });
    expect(next.ready.identity).toBe(moved.to.identity);
    expect(next.drift).toEqual({ kind: "same" });
  });

  test("the install a running daemon started from survives a moved pin and the sweep", async () => {
    version("1");
    const running = (await pinnedDep(dep, exec, { root, store })).ready;
    await holdRunningDep(running, { store });
    version("2");
    await pinDep(dep, exec, { root, store });

    const held = await heldDep(dep, "machine-pin-test-running", { store });
    expect(held.kind === "held" && held.ready.identity).toBe(running.identity);
    await sweepDeps({
      store,
      deps: [dep],
      checkouts: [root],
      now: new Date(Date.now() + 365 * 86_400_000),
      idleMs: 0,
    });
    expect(existsSync(join(running.dir, "v"))).toBe(true);
  });

  test("a pinned install cannot be removed from under the daemon", async () => {
    version("1");
    await pinnedDep(dep, exec, { root, store });
    expect(await removeDep(dep, { root, store })).toEqual({
      kind: "held",
      holders: ["machine-pin-test"],
    });
  });

  test("a dependency without a pin cannot be pinned", async () => {
    const unpinned = defineDep({
      id: "unpinned",
      owner: "infra/deps",
      description: "",
      sizeHint: "",
      source,
      updates: { none: "test" },
    });
    version("1");
    expect(pinnedDep(unpinned, exec, { root, store })).rejects.toThrow(
      /declares no pin/,
    );
  });
});
