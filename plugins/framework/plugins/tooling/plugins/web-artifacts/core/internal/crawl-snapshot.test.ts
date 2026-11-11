import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { crawlSnapshotDirName } from "./crawl-snapshot";
import type { GlobPatternMemo } from "./store";

// A crawl snapshot's address covers everything its take reads, read off the
// build's repo snapshot — the WORKING TREE, so an uncommitted edit (or a new,
// untracked file) to what the take reads off disk is never published under
// an address that does not include it.

// Fixture plugin paths, spelled through a prefix: a fake tree's plugins are
// no plugins of this repo, so they are not plugin references.
const P = "plugins";
const TAKE = `${P}/site/plugins/crawl/bin/static-host.ts`;
const GENERATED = `${P}/site/plugins/crawl/bin/static-host.generated.ts`;
const RENDER_WEB = `${P}/site/plugins/crawl/plugins/render/web/index.ts`;
const RENDER_DEP = `${P}/renderer/web/index.ts`;
const FLEET_WEB = `${P}/site/web/index.ts`;
const OUTSIDE_WEB = `${P}/elsewhere/web/index.ts`;
const CONFIG_LAYER = `${P}/config/plugins/bundled-layer/server/index.ts`;
const MIGRATIONS = `${P}/migrations/plugins/bundled/server/index.ts`;
const CONFIG = "config/site/header.jsonc";
const MIGRATION = `${P}/migrations/data/0001_init.sql`;
const SCAN =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";

const BASE: Record<string, string> = {
  "bun.lock": '{ "lockfileVersion": 1, "workspaces": {}, "packages": {} }',
  [TAKE]: `import { hosts } from "./static-host.generated";\nexport const take = hosts;`,
  [GENERATED]: [
    "export const hosts = [",
    `  () => import("@plugins/config/plugins/bundled-layer/server"),`,
    `  () => import("@plugins/migrations/plugins/bundled/server"),`,
    "];",
  ].join("\n"),
  // The bundled providers: their globs are the roots the disk swaps read.
  [CONFIG_LAYER]: `export const files = () => import.meta.glob("/config/**/*.jsonc");`,
  [MIGRATIONS]: `export const files = () => import.meta.glob("../../../data/*.sql");`,
  [RENDER_WEB]: `export { render } from "@plugins/renderer/web";`,
  [RENDER_DEP]: `export const render = 1;`,
  [FLEET_WEB]: `export default {};`,
  [OUTSIDE_WEB]: `export default {};`,
  [CONFIG]: `{ "nav": ["a"] }`,
  [MIGRATION]: `-- migration 1`,
  [SCAN]: readFileSync(join(REPO_ROOT, SCAN), "utf8"),
};

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

const git = (root: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd: root, stdout: "ignore" });

/** A checkout with `BASE` committed, then `dirty` written over it uncommitted. */
function checkout(dirty: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "crawl-snapshot-"));
  roots.push(root);
  write(root, BASE);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "base",
  );
  write(root, dirty);
  return root;
}

function memoryGlobs(): GlobPatternMemo {
  const known = new Map<string, readonly string[]>();
  return {
    get: (blob) => known.get(blob),
    set: (blob, patterns) => void known.set(blob, patterns),
    save: () => {},
  };
}

async function address(dirty: Record<string, string> = {}): Promise<string> {
  const snapshot = await loadRepoSnapshot(asAppPath(checkout(dirty)));
  const { dirName } = await crawlSnapshotDirName({
    sources: { snapshot, globs: memoryGlobs() },
    composition: "site",
    webPlugins: ["site"],
    clusterDirName: "pglite.pglite-cluster.x",
  });
  return dirName;
}

describe("a crawl snapshot's address", () => {
  test("is stable for the same tree", async () => {
    expect(await address()).toBe(await address());
  });

  test("moves with an uncommitted edit to the config the take reads", async () => {
    expect(await address({ [CONFIG]: `{ "nav": ["a", "b"] }` })).not.toBe(
      await address(),
    );
  });

  test("moves with an untracked new config file", async () => {
    expect(
      await address({ "config/site/footer.jsonc": `{ "x": 1 }` }),
    ).not.toBe(await address());
  });

  test("moves with an uncommitted migration", async () => {
    expect(await address({ [MIGRATION]: `-- migration 1, edited` })).not.toBe(
      await address(),
    );
    expect(
      await address({
        [`${P}/migrations/data/0002_next.sql`]: `-- migration 2`,
      }),
    ).not.toBe(await address());
  });

  test("moves with the take's build-only render half and what it imports", async () => {
    // In no composition: covered as a web barrel of the take's own subtree.
    expect(
      await address({
        [RENDER_WEB]: `export { render } from "@plugins/renderer/web";\nexport const v = 2;`,
      }),
    ).not.toBe(await address());
    expect(
      await address({ [RENDER_DEP]: `export const render = 2;` }),
    ).not.toBe(await address());
  });

  test("moves with the composition's web code, not with a plugin outside it", async () => {
    const before = await address();
    expect(
      await address({ [FLEET_WEB]: `export default { changed: true };` }),
    ).not.toBe(before);
    expect(
      await address({ [OUTSIDE_WEB]: `export default { changed: true };` }),
    ).toBe(before);
  });
});
