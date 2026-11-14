import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadRepoSnapshot,
  type RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  globRootsOf,
  hashedRootsFor,
  isHashedFile,
  listOwnFiles,
  ownHashFor,
  type OwnSources,
} from "./own-files";
import type { GlobPatternMemo } from "./store";

// A repo holding one plugin with one file per folder, so which folders an
// artifact HASHES is readable straight off the returned list.
const repo = asAppPath(mkdtempSync(join(tmpdir(), "own-files-test-")));
const dir = join(repo, "p");
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function write(rel: string, content: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

let snapshot!: RepoSnapshot;
beforeAll(async () => {
  for (const folder of ["web", "shared", "core", "prewarm", "exhibits"]) {
    write(`p/${folder}/index.ts`, `export const ${folder} = 1;\n`);
  }
  write("p/package.json", "{}\n");
  write("p/web/testing/index.ts", "export const fixture = 1;\n"); // never hashed
  write("p/web/ignored.generated.ts", "export const g = 1;\n"); // gitignored
  write(".gitignore", "*.generated.ts\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  snapshot = await loadRepoSnapshot(repo);
});

const rel = (kind: string): string[] =>
  listOwnFiles(snapshot, dir, kind)
    .map((abs) => abs.slice(dir.length + 1))
    .sort();

describe("listOwnFiles lists exactly inlinedRootsFor(kind)", () => {
  test("prewarm: its own folder + shared + package.json — never web or core", () => {
    expect(rel("prewarm")).toEqual([
      "package.json",
      "prewarm/index.ts",
      "shared/index.ts",
    ]);
  });

  // The `web` hash NARROWS here: own-core is rewritten to the external barrel,
  // so it never enters the bytes and hashing it only forced spurious rebuilds.
  test("web: web + shared + its co-built exhibits + package.json — NOT core, test code or gitignored files", () => {
    expect(rel("web")).toEqual([
      "exhibits/index.ts",
      "package.json",
      "shared/index.ts",
      "web/index.ts",
    ]);
  });

  test("core: core + shared + package.json", () => {
    expect(rel("core")).toEqual([
      "core/index.ts",
      "package.json",
      "shared/index.ts",
    ]);
  });
});

describe("hashedRootsFor", () => {
  test("entry hashes the passed dir itself (web-core/web, no plugin around it)", () => {
    expect(hashedRootsFor(dir, "entry")).toEqual([dir]);
  });

  test("a plugin kind hashes its own folder plus shared", () => {
    expect(hashedRootsFor(dir, "prewarm")).toEqual([
      join(dir, "prewarm"),
      join(dir, "shared"),
    ]);
  });
});

describe("isHashedFile", () => {
  const roots = ["/p/web", "/p/shared"];

  test("a source file inside a root is hashed", () => {
    expect(isHashedFile(roots, "/p/web/index.ts")).toBe(true);
    expect(isHashedFile(roots, "/p/shared/deep/util.tsx")).toBe(true);
  });

  test("outside every root is not hashed", () => {
    expect(isHashedFile(roots, "/p/core/index.ts")).toBe(false);
    expect(isHashedFile(roots, "/p/webx/index.ts")).toBe(false);
  });

  test("what the walk skips is not hashed, though inside a root", () => {
    for (const abs of [
      "/p/web/testing/index.ts",
      "/p/web/a/__tests__/x.tsx",
      "/p/web/a.test.ts",
      "/p/web/node_modules/dep/index.js",
      "/p/web/public/logo.svg",
      "/p/web/dist.live.1/x.js",
    ]) {
      expect(isHashedFile(roots, abs)).toBe(false);
    }
  });

  test("agrees with listOwnFiles on a real tree", () => {
    const files = listOwnFiles(snapshot, dir, "web");
    for (const f of files.filter((f) => !f.endsWith("package.json"))) {
      expect(isHashedFile(hashedRootsFor(dir, "web"), f)).toBe(true);
    }
  });
});

describe("globRootsOf", () => {
  test("a relative pattern's static base resolves against its module", () => {
    expect(
      globRootsOf(
        "/repo",
        "pkg/a/b/server/internal/bundled.ts",
        'const f = import.meta.glob<string>("../../../../data/*.sql", { eager: true });',
      ),
    ).toEqual(["pkg/data"]);
  });

  test("a root-absolute pattern's static base resolves against the repo", () => {
    expect(
      globRootsOf(
        "/repo",
        "pkg/x/server/internal/bundled.ts",
        "import.meta.glob('/config/**/*.jsonc', { query: '?raw' })",
      ),
    ).toEqual(["config"]);
  });

  test("a mention outside a call is not a pattern", () => {
    expect(
      globRootsOf("/repo", "a.ts", "// vite rewrites `import.meta.glob` here"),
    ).toEqual([]);
  });

  test("a non-literal pattern throws, naming the module", () => {
    expect(() =>
      globRootsOf("/repo", "pkg/x/a.ts", "import.meta.glob(PATTERN)"),
    ).toThrow(/pkg\/x\/a\.ts/);
  });

  test("a pattern reaching outside the repo throws", () => {
    expect(() =>
      globRootsOf("/repo", "a.ts", 'import.meta.glob("../outside/*.ts")'),
    ).toThrow(/outside the repo/);
  });
});

describe("ownHashFor", () => {
  /** A memo that counts what it had to learn. */
  function countingMemo(): GlobPatternMemo & { learned: () => number } {
    const known = new Map<string, readonly string[]>();
    let learned = 0;
    return {
      get: (blob) => known.get(blob),
      set: (blob, patterns) => {
        known.set(blob, patterns);
        learned++;
      },
      save: () => {},
      learned: () => learned,
    };
  }

  test("follows content, reads a module only the first time its blob is seen", async () => {
    const globs = countingMemo();
    const sources = (): OwnSources => ({ snapshot, globs });
    const a = await ownHashFor({
      pluginDir: dir,
      kind: "web",
      sources: sources(),
    });
    expect(a.globRoots).toEqual([]);
    const seen = globs.learned();
    expect(seen).toBe(3); // web, shared, exhibits — package.json is no module
    const again = await ownHashFor({
      pluginDir: dir,
      kind: "web",
      sources: sources(),
    });
    expect(again.ownHash).toBe(a.ownHash);
    expect(globs.learned()).toBe(seen); // nothing new to read

    write("p/web/index.ts", "export const web = 2;\n");
    try {
      snapshot = await loadRepoSnapshot(repo);
      const edited = await ownHashFor({
        pluginDir: dir,
        kind: "web",
        sources: { snapshot, globs },
      });
      expect(edited.ownHash).not.toBe(a.ownHash);
      expect(globs.learned()).toBe(seen + 1); // only the edited module
    } finally {
      write("p/web/index.ts", "export const web = 1;\n");
      snapshot = await loadRepoSnapshot(repo);
    }
  });

  test("a glob root's files join the address", async () => {
    write("data/a.sql", "select 1;\n");
    write(
      "p/core/bundled.ts",
      'export const sql = import.meta.glob("../../data/*.sql", { eager: true });\n',
    );
    try {
      snapshot = await loadRepoSnapshot(repo);
      const before = await ownHashFor({
        pluginDir: dir,
        kind: "core",
        sources: { snapshot, globs: countingMemo() },
      });
      expect(before.globRoots).toEqual([join(repo, "data")]);
      expect(before.globFiles).toEqual([join(repo, "data/a.sql")]);

      write("data/b.sql", "select 2;\n");
      snapshot = await loadRepoSnapshot(repo);
      const after = await ownHashFor({
        pluginDir: dir,
        kind: "core",
        sources: { snapshot, globs: countingMemo() },
      });
      expect(after.ownHash).not.toBe(before.ownHash);
    } finally {
      rmSync(join(repo, "data"), { recursive: true, force: true });
      rmSync(join(repo, "p/core/bundled.ts"));
      snapshot = await loadRepoSnapshot(repo);
    }
  });

  test("a page worker's whole closure joins the address, and only it", async () => {
    // another plugin's barrel, outside p's own roots
    write("q/core/index.ts", 'export { q } from "./q";\n');
    write("q/core/q.ts", "export const q = 1;\n");
    write(
      "p/web/bake.worker.ts",
      'import { q } from "../../q/core";\nself.postMessage(q);\n',
    );
    const plan = () =>
      ownHashFor({
        pluginDir: dir,
        kind: "web",
        sources: { snapshot, globs: countingMemo() },
      });
    try {
      snapshot = await loadRepoSnapshot(repo);
      const before = await plan();
      expect(before.workerFiles).toEqual([
        join(repo, "p/web/bake.worker.ts"),
        join(repo, "q/core/index.ts"),
        join(repo, "q/core/q.ts"),
      ]);
      // the closure is the worker pass's, never an own file of the page bundle
      expect(before.ownFiles).not.toContain(join(repo, "q/core/q.ts"));

      write("q/core/q.ts", "export const q = 2;\n");
      snapshot = await loadRepoSnapshot(repo);
      const after = await plan();
      expect(after.ownHash).not.toBe(before.ownHash);
    } finally {
      rmSync(join(repo, "q"), { recursive: true, force: true });
      rmSync(join(repo, "p/web/bake.worker.ts"));
      snapshot = await loadRepoSnapshot(repo);
    }
  });

  test("an artifact without a worker keeps the address of its files alone", async () => {
    const a = await ownHashFor({
      pluginDir: dir,
      kind: "web",
      sources: { snapshot, globs: countingMemo() },
    });
    expect(a.workerFiles).toEqual([]);
  });
});
