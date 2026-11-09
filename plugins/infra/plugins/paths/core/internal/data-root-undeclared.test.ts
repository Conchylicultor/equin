import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { DATA_DIR_NAME } from "./data-root-layout";

// A path read in a process whose tree's root declared nothing throws; it never
// decides the layout on the spot. Each case runs in a fresh Bun process with a
// home of its own and a bare environment — the test process itself is declared
// by the preload, and HOME_DIR is read once at module eval.

const PATHS_CORE = join(REPO_ROOT, "plugins/infra/plugins/paths/core/index.ts");

const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "data-root-undeclared-"));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true });
});

/** Run `body` (after `const p = await import(<paths core>)`) and print what it returns or throws. */
function inChild(h: string, body: string): string {
  const script =
    `const p = await import(${JSON.stringify(PATHS_CORE)});\n` +
    `try { console.log("ok " + (${body})); }\n` +
    `catch (err) { console.log("threw " + err.name); }`;
  const out = spawnSync(process.execPath, ["-e", script], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h },
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(`child failed: ${out.stderr}`);
  return out.stdout.trim();
}

test("an undeclared process throws on its first path read", () => {
  expect(inChild(home(), "p.dataRoot()")).toBe("threw DataRootUndeclaredError");
});

test("a declared process reads the layout from its environment", () => {
  const h = home();
  expect(inChild(h, "(p.declareDataRootLayoutSync(), p.dataRoot())")).toBe(
    `ok ${join(h, DATA_DIR_NAME)}`,
  );
});

test("a root that found a split rethrows the split on every path read", () => {
  const h = home();
  mkdirSync(join(h, LEGACY_IDS.dataDirName));
  mkdirSync(join(h, DATA_DIR_NAME));
  expect(
    inChild(
      h,
      "(() => { try { p.declareDataRootLayoutSync(); } catch (err) { if (!(err instanceof p.DataRootSplitError)) throw err; } return p.dataRoot(); })()",
    ),
  ).toBe("threw DataRootSplitError");
});
