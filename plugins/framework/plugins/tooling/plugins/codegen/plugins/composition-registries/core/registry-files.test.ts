/**
 * The per-name composition registry grammar: the path builder, main resolving
 * to the committed registry, parse, and the on-disk listing.
 */

import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { DiscoveredCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/plugins/discovery/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import { backendEntryFor } from "@plugins/infra/plugins/paths/core";
import {
  collectedDirNamedCompositionRegistryPath,
  compositionOutputIgnorePatterns,
  compositionOutputLocations,
  compositionOutputPath,
  deadCompositionOutputs,
  isCompositionOutputName,
  removeDeadCompositionOutputs,
  compositionRegistryFileName,
  compositionRegistryPath,
  listNamedCompositionRegistries,
  parseNamedCompositionRegistryFileName,
} from "./registry-files";

// Fixture paths go through `pj(rel)` rather than bare `plugins/<seg>/…`
// literals — the repo's own `plugin-refs-resolve` check validates that every
// such literal in source resolves to a real plugin, and these are synthetic.
const pj = (rel: string): string => `plugins/${rel}`;

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

// ── Per-name composition registries ────────────────────────────────
//
// The composition-name vocabulary itself (assertCompositionName, the
// reserved/owned split) is tested beside its source, in
// plugins/plugin-meta/plugins/composition/core/namespace.test.ts. What is tested
// HERE is only that the registry path builder routes a name through it.

test("per-name registry path renders and round-trips through parse", () => {
  const def: DiscoveredCollectedDir = {
    dir: "web",
    membership: "composition",
    _brand: "CollectedDirDef",
    ownerDir: asAppPath("/repo/plugins/framework/plugins/web-sdk"),
  };
  const file = collectedDirNamedCompositionRegistryPath(def, "sonata");
  expect(file).toBe(
    asAppPath(
      "/repo/plugins/framework/plugins/web-sdk/core/web.composition.sonata.generated.ts",
    ),
  );
  expect(
    parseNamedCompositionRegistryFileName(
      "web.composition.sonata.generated.ts",
    ),
  ).toEqual({
    dir: "web",
    name: "sonata",
  });
  expect(() =>
    collectedDirNamedCompositionRegistryPath(def, "../evil"),
  ).toThrow("Invalid composition name");
});

/**
 * The one place that knows main's registry is the committed file.
 *
 * the main composition is an ordinary composition — it just happens to be the one whose
 * closure is the whole tree, which is exactly what `plugins-registry-in-sync`
 * re-derives and asserts on every build. So asking for its registry must hand
 * back `<dir>.generated.ts`, and nothing may ever emit a
 * `<dir>.composition.<main>.generated.ts` for a backend to pick up by
 * presence.
 */
test("the main composition resolves to the committed registry, every other to a filtered one", () => {
  const def: DiscoveredCollectedDir = {
    dir: "server",
    membership: "composition",
    _brand: "CollectedDirDef",
    ownerDir: asAppPath("/repo/plugins/framework/plugins/server-core"),
  };
  expect(compositionRegistryPath(def, MAIN_COMPOSITION_ID)).toBe(
    "/repo/plugins/framework/plugins/server-core/core/server.generated.ts",
  );
  expect(compositionRegistryPath(def, "sonata")).toBe(
    "/repo/plugins/framework/plugins/server-core/core/server.composition.sonata.generated.ts",
  );
  // The filename half, which `release` asks directly (it holds a repo-relative
  // path, not a DiscoveredCollectedDir).
  expect(compositionRegistryFileName("web", MAIN_COMPOSITION_ID)).toBe(
    "web.generated.ts",
  );
  expect(compositionRegistryFileName("web", "sonata")).toBe(
    "web.composition.sonata.generated.ts",
  );
  expect(() => compositionRegistryFileName("web", "../evil")).toThrow(
    "Invalid composition name",
  );
});

// The pre-S1 checkout-global singleton spelling is gone (S5): nothing writes,
// selects or reaps it. These two tests pin that a stray leftover of that name in
// an old checkout stays INERT — never parsed as a per-name registry, never
// listed as one (which would make the auto-serve sweep delete or adopt it).
test("parse rejects the singleton, committed, and non-registry file names", () => {
  expect(
    parseNamedCompositionRegistryFileName("web.composition.generated.ts"),
  ).toBeNull();
  expect(parseNamedCompositionRegistryFileName("web.generated.ts")).toBeNull();
  expect(
    parseNamedCompositionRegistryFileName(
      "web.composition.Sonata.generated.ts",
    ),
  ).toBeNull();
  expect(
    parseNamedCompositionRegistryFileName(
      "web.composition.sonata.generated.ts.bak",
    ),
  ).toBeNull();
});

test("listNamedCompositionRegistries finds per-name files, skipping singletons", async () => {
  // The collected dirs come from git; the per-name registries are found by
  // reading the owning core dirs (in the real repo they are gitignored).
  const names = [
    "web.composition.sonata.generated.ts",
    "web.composition.generated.ts", // pre-S1 singleton stray — not per-name
    "server.composition.sonata.generated.ts",
    "server.composition.pages.generated.ts",
    "prewarm.composition.sonata.generated.ts",
    "web.generated.ts", // committed — never listed
  ];
  const namedRoot = gitFixture({
    [pj("sdk/core/index.ts")]: [
      'export const webDir = defineCollectedDir("web");',
      'export const serverDir = defineCollectedDir("server");',
      'export const prewarmDir = defineCollectedDir("prewarm");',
    ].join("\n"),
    ...Object.fromEntries(
      names.map((f) => [`plugins/sdk/core/${f}`, "export const x = [];\n"]),
    ),
    // A composition's backend entry, written with its registries.
    "plugins/framework/plugins/server-core/bin/index.composition.sonata.generated.ts":
      "export {};\n",
    "plugins/framework/plugins/server-core/bin/index.ts": "export {};\n",
  });

  const listed = (
    await listNamedCompositionRegistries(await loadRepoFiles(namedRoot))
  )
    .map((e) => `${e.dir}:${e.name}`)
    .sort();
  expect(listed).toEqual([
    "bin:sonata",
    "prewarm:sonata",
    "server:pages",
    "server:sonata",
    "web:sonata",
  ]);
});

// ── The output locations: writer, listing and .gitignore read one list ──

function outputsFixture(): AppPath {
  return gitFixture({
    [pj("sdk/core/index.ts")]: [
      'export const webDir = defineCollectedDir("web");',
      'export const serverDir = defineCollectedDir("server");',
      'export const checkDir = defineCollectedDir("check");',
    ].join("\n"),
    // Ignored exactly as `.gitignore` must: these two are live outputs.
    ".gitignore": [
      `/${pj("sdk/core")}/web.composition.*.generated.ts`,
      `/${pj("sdk/core")}/server.composition.*.generated.ts`,
      "/plugins/framework/plugins/server-core/bin/index.composition.*.generated.ts",
      "",
    ].join("\n"),
    [pj("sdk/core/web.composition.sonata.generated.ts")]: "export {};\n",
    // A retired output's leftover: no pattern hides it, so git sees it.
    [pj("apps/server/internal/apps.composition.sonata.generated.ts")]:
      "export {};\n",
    [pj("apps/server/internal/apps.generated.ts")]: "export {};\n",
    "plugins/framework/plugins/server-core/bin/index.ts": "export {};\n",
  });
}

test("the output locations are the runtime dirs' core/ folders and the backend entry", async () => {
  const root = outputsFixture();
  const locs = await compositionOutputLocations(await loadRepoFiles(root));
  expect(locs.map((l) => `${l.listedAs}:${l.stem}`).sort()).toEqual([
    "bin:index",
    "server:server",
    "web:web",
  ]);
  // The backend entry is where the gateway's spec runs it from.
  const backend = locs.find((l) => l.def === null)!;
  expect(compositionOutputPath(backend, "sonata")).toBe(
    asAppPath(
      join(
        root,
        "plugins/framework/plugins/server-core",
        backendEntryFor("sonata"),
      ),
    ),
  );
  expect(() => compositionOutputPath(backend, MAIN_COMPOSITION_ID)).toThrow();
});

test("the ignore patterns name exactly the output locations", async () => {
  const root = outputsFixture();
  expect(
    await compositionOutputIgnorePatterns(await loadRepoFiles(root)),
  ).toEqual([
    "/plugins/framework/plugins/server-core/bin/index.composition.*.generated.ts",
    `/${pj("sdk/core")}/server.composition.*.generated.ts`,
    `/${pj("sdk/core")}/web.composition.*.generated.ts`,
  ]);
});

test("a per-composition output git sees is dead; a live (ignored) one is not", async () => {
  const root = outputsFixture();
  expect(deadCompositionOutputs(await loadRepoFiles(root))).toEqual([
    pj("apps/server/internal/apps.composition.sonata.generated.ts"),
  ]);
});

test("isCompositionOutputName: per-name and singleton spellings, nothing else", () => {
  expect(isCompositionOutputName("web.composition.sonata.generated.ts")).toBe(
    true,
  );
  expect(isCompositionOutputName("web.composition.generated.ts")).toBe(true);
  expect(isCompositionOutputName("browser-host.composition.ts")).toBe(false);
  expect(isCompositionOutputName("web.generated.ts")).toBe(false);
});

test("removeDeadCompositionOutputs deletes untracked leftovers, never a tracked file", async () => {
  const root = outputsFixture();
  // A committed file spelled like an output: someone's commit, which the
  // check names — never silently deleted.
  const tracked = pj("other/core/x.composition.sonata.generated.ts");
  mkdirSync(dirname(join(root, tracked)), { recursive: true });
  writeFileSync(join(root, tracked), "export {};\n");
  for (const argv of [
    ["git", "add", "--", tracked],
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "t"],
  ]) {
    const r = Bun.spawnSync(argv, { cwd: root });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  }
  const leftover = pj(
    "apps/server/internal/apps.composition.sonata.generated.ts",
  );
  const removed = await removeDeadCompositionOutputs(await loadRepoFiles(root));
  expect(removed).toEqual([leftover]);
  expect(existsSync(join(root, leftover))).toBe(false);
  expect(existsSync(join(root, tracked))).toBe(true);
  // The live (ignored) output is untouched.
  expect(
    existsSync(join(root, pj("sdk/core/web.composition.sonata.generated.ts"))),
  ).toBe(true);
});
