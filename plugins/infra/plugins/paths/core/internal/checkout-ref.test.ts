import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { checkoutRef } from "./checkout-ref";
import { SERVER_CORE_RELATIVE } from "./paths";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";

// Each case owns a data root and real git repos: `checkoutRef` asks git which
// checkout is main, and the spec's checkout is matched by its real path.

const ORIGINAL_ROOT = readEnv("DIR");
const dirs: string[] = [];
afterAll(() => {
  if (ORIGINAL_ROOT === undefined) unsetEnv("DIR");
  else setEnv("DIR", ORIGINAL_ROOT);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sandbox(): { dir: string; claimMain: (checkout: string) => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "checkout-ref-")));
  dirs.push(dir);
  setEnv("DIR", join(dir, "data"));
  return {
    dir,
    claimMain: (checkout) => {
      const ns = join(dir, "data", "worktrees", MAIN_WORKTREE_NAME);
      mkdirSync(ns, { recursive: true });
      writeFileSync(
        join(ns, "spec.json"),
        JSON.stringify({ server: join(checkout, SERVER_CORE_RELATIVE) }),
      );
    },
  };
}

async function repo(path: string): Promise<string> {
  mkdirSync(path, { recursive: true });
  await spawnExpectOk(["git", "init", "-q"], { cwd: path, timeoutMs: 30_000 });
  return path;
}

describe("checkoutRef", () => {
  test("a main checkout is main while nothing claims the main namespace", async () => {
    const { dir } = sandbox();
    const root = await repo(join(dir, "fresh"));
    expect(await checkoutRef(root)).toEqual({ kind: "main" });
  });

  test("the checkout the main spec names is main", async () => {
    const { dir, claimMain } = sandbox();
    const root = await repo(join(dir, "installed"));
    claimMain(root);
    expect(await checkoutRef(root)).toEqual({ kind: "main" });
  });

  test("another repository's main checkout is named by its directory", async () => {
    const { dir, claimMain } = sandbox();
    claimMain(await repo(join(dir, "installed")));
    const clone = await repo(join(dir, "e2e-clone"));
    expect(await checkoutRef(clone)).toEqual({
      kind: "worktree",
      name: "e2e-clone",
    });
  });

  test("a spec naming a checkout that no longer exists claims nothing", async () => {
    const { dir, claimMain } = sandbox();
    claimMain(join(dir, "moved-away"));
    const root = await repo(join(dir, "here"));
    expect(await checkoutRef(root)).toEqual({ kind: "main" });
  });

  test("a second clone named like the main namespace is refused", async () => {
    const { dir, claimMain } = sandbox();
    claimMain(await repo(join(dir, "installed")));
    const clash = await repo(join(dir, "other", MAIN_WORKTREE_NAME));
    let caught: unknown;
    try {
      await checkoutRef(clash);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe("MainNamespaceCollisionError");
  });

  test("an unreadable main spec is an error, never 'unclaimed'", async () => {
    const { dir } = sandbox();
    const ns = join(dir, "data", "worktrees", MAIN_WORKTREE_NAME);
    mkdirSync(ns, { recursive: true });
    writeFileSync(join(ns, "spec.json"), "{not json");
    const root = await repo(join(dir, "any"));
    let caught: unknown;
    try {
      await checkoutRef(root);
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain("Cannot tell which checkout serves");
  });
});
