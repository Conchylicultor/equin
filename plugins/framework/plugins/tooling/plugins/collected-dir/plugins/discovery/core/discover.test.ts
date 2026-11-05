/**
 * Collected-dir discovery (over a file set, over git, over a tree-build
 * snapshot).
 *
 * Discovery must ignore a `defineCollectedDir("…")` written inside a comment or
 * string (routed through `findMarkerCalls`), and must consider only the files a
 * collected dir can be declared in: directly under a `core/` that has a barrel,
 * at a plugin position, and not a test.
 */

import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { PLUGIN_FOLDERS } from "@plugins/framework/plugins/plugin-id/core";
import {
  globPaths,
  type RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import {
  discoverCollectedDirs,
  discoverCollectedDirsIn,
  standardPluginDirsFromSnapshot,
  standardPluginDirsIn,
  type DiscoveredCollectedDir,
} from "./discover";

// Fixture paths go through `pj(rel)` rather than bare `plugins/<seg>/…`
// literals — the repo's own `plugin-refs-resolve` check validates that every
// such literal in source resolves to a real plugin, and these are synthetic.
const pj = (rel: string): string => `plugins/${rel}`;

/**
 * A `RepoFiles` over an in-memory `{ path: text }` map — the file set a run
 * hands a check. `reads` records every path read, so a test can assert what a
 * scan opened.
 */
function memRepo(
  root: string,
  files: Record<string, string>,
): RepoFiles & { reads: string[] } {
  const paths = Object.keys(files).sort();
  const reads: string[] = [];
  return {
    root: asAppPath(root),
    reads,
    all: () => paths,
    has: (p) => Object.hasOwn(files, p),
    under: (dir) =>
      dir === "" ? paths : paths.filter((p) => p.startsWith(`${dir}/`)),
    glob: (pattern) => globPaths(paths, pattern),
    read: (p) => {
      reads.push(p);
      return Promise.resolve(Object.hasOwn(files, p) ? files[p]! : null);
    },
  };
}

/** A fresh git repository holding `files` untracked (so `--others` lists them). */
function gitFixture(files: Record<string, string>): AppPath {
  const root = asAppPath(mkdtempSync(join(tmpdir(), "collected-dir-git-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const sortedDirs = (defs: DiscoveredCollectedDir[]) =>
  defs.map((d) => d.dir).sort();

test("discovery ignores commented/stringified markers but finds real calls", async () => {
  const repo = memRepo("/repo", {
    [pj("real/core/index.ts")]:
      'export const realDir = defineCollectedDir("check");',
    [pj("phantoms/core/index.ts")]: [
      '// defineCollectedDir("phantom")',
      "const s = \"defineCollectedDir('stringed')\";",
      '/* block defineCollectedDir("blocked") */',
    ].join("\n"),
  });
  // Only the genuine call is discovered; the comment- and string-embedded
  // markers must not produce phantom collected dirs.
  expect(sortedDirs(await discoverCollectedDirsIn(repo))).toEqual(["check"]);
});

test("discovery reads a literal membership argument, and throws on one it cannot read", async () => {
  const defs = await discoverCollectedDirsIn(
    memRepo("/repo", {
      [pj("a/core/index.ts")]: 'defineCollectedDir("check");',
      [pj("b/core/index.ts")]:
        'defineCollectedDir("exempt", {\n  membership: "checkout",\n});',
      [pj("c/core/index.ts")]:
        "defineCollectedDir('lint', { membership: 'composition' });",
    }),
  );
  expect(
    defs
      .map((d) => [d.dir, d.membership])
      .sort(([a], [b]) => a!.localeCompare(b!)),
  ).toEqual([
    ["check", "composition"],
    ["exempt", "checkout"],
    ["lint", "composition"],
  ]);

  // A second argument the regex reader cannot see through would otherwise
  // silently mean "composition".
  const refused = discoverCollectedDirsIn(
    memRepo("/repo", {
      [pj("d/core/index.ts")]: 'defineCollectedDir("exempt", OPTS);',
    }),
  );
  expect(refused).rejects.toBeInstanceOf(Error);
  expect(refused).rejects.toThrow("second argument must be the literal");
});

test("discovery reads only core files at a plugin position whose core has a barrel", async () => {
  const deep = (n: number) =>
    Array.from({ length: n }, (_, i) => `d${i + 1}`).join("/plugins/");
  const repo = memRepo("/repo", {
    [pj("real/core/index.ts")]: "export {};",
    [pj("real/core/dirs.ts")]: 'defineCollectedDir("check");',
    // A nested sub-plugin is a plugin position; its parent needs no core.
    [pj("outer/plugins/inner/core/index.ts")]: 'defineCollectedDir("lint");',
    // Ten names deep is the deepest position; eleven is past it.
    [`plugins/${deep(10)}/core/index.ts`]: 'defineCollectedDir("facet");',
    [`plugins/${deep(11)}/core/index.ts`]: 'defineCollectedDir("eleven");',
    // No barrel → not a core a collected dir can live in.
    [pj("nobarrel/core/dirs.ts")]: 'defineCollectedDir("orphan");',
    // Not directly under core/.
    [pj("real/core/sub/deep.ts")]: 'defineCollectedDir("subdir");',
    // A `core/` that is not at a plugin position.
    [pj("real/lib/core/index.ts")]: 'defineCollectedDir("lib");',
    // A test never declares one.
    [pj("real/core/define.test.ts")]: 'defineCollectedDir("fromtest");',
  });

  const defs = await discoverCollectedDirsIn(repo);
  expect(sortedDirs(defs)).toEqual(["check", "facet", "lint"]);
  expect(defs.find((d) => d.dir === "lint")?.ownerDir).toBe(
    asAppPath("/repo/plugins/outer/plugins/inner"),
  );
  // Nothing outside the candidates was opened.
  expect(repo.reads.sort()).toEqual(
    [
      pj("outer/plugins/inner/core/index.ts"),
      pj("real/core/dirs.ts"),
      pj("real/core/index.ts"),
      `plugins/${deep(10)}/core/index.ts`,
    ].sort(),
  );
});

test("the standard folder set is the plugin-folder vocabulary plus plugins/", async () => {
  const repo = memRepo("/repo", {
    [pj("sdk/core/index.ts")]: 'defineCollectedDir("check");',
  });
  expect([...(await standardPluginDirsIn(repo))].sort()).toEqual(
    [...PLUGIN_FOLDERS, "plugins"].sort(),
  );
});

test("an undeclared collected-dir name throws, naming the file", async () => {
  const file = pj("sdk/core/dirs.ts");
  const files = {
    [pj("sdk/core/index.ts")]: "export {};",
    [file]: 'defineCollectedDir("widget");',
  };
  const repo = memRepo("/repo", files);
  expect(discoverCollectedDirsIn(repo)).rejects.toThrow(
    new RegExp(`${file}.*"widget".*not a plugin folder`),
  );
  expect(standardPluginDirsIn(repo)).rejects.toThrow(/not a plugin folder/);
  // The sync and snapshot fronts share the same pure core.
  const root = gitFixture(files);
  expect(() => discoverCollectedDirs(root)).toThrow(/not a plugin folder/);
  const fs = {
    files: new Map(
      Object.entries(files).map(([rel, text]) => [`/repo/${rel}`, text]),
    ),
    dirs: new Map(),
  };
  expect(() => standardPluginDirsFromSnapshot(asAppPath("/repo"), fs)).toThrow(
    /not a plugin folder/,
  );
});

test("the sync front lists the same universe from git: untracked counts, gitignored does not", () => {
  const root = gitFixture({
    ".gitignore": "plugins/ignored/\n",
    [pj("fresh/core/index.ts")]: 'defineCollectedDir("check");',
    [pj("ignored/core/index.ts")]: 'defineCollectedDir("hidden");',
  });
  expect(sortedDirs(discoverCollectedDirs(root))).toEqual(["check"]);
});

test("the snapshot front answers from a tree build's snapshot alone", () => {
  const root = asAppPath("/repo");
  const fs = {
    files: new Map([
      [`${root}/plugins/sdk/core/index.ts`, 'defineCollectedDir("check");'],
      [`${root}/plugins/sdk/web/index.ts`, 'defineCollectedDir("notcore");'],
    ]),
    dirs: new Map(),
  };
  const std = standardPluginDirsFromSnapshot(root, fs);
  expect(std.has("check")).toBe(true);
  expect(std.has("notcore")).toBe(false);
  // One answer per snapshot.
  expect(standardPluginDirsFromSnapshot(root, fs)).toBe(std);
});
