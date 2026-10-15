/**
 * Collected-dir discovery (over a file set, over git, over a tree-build
 * snapshot), per-name composition registries, and the registry renderer's
 * bundle filter.
 *
 * Discovery must ignore a `defineCollectedDir("…")` written inside a comment or
 * string (routed through `findMarkerCalls`), and must consider only the files a
 * collected dir can be declared in: directly under a `core/` that has a barrel,
 * at a plugin position, and not a test.
 */

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  asPluginId,
  PLUGIN_FOLDERS,
} from "@plugins/framework/plugins/plugin-id/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { classifyEdges } from "@plugins/plugin-meta/plugins/closure/core";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  collectedDirNamedCompositionRegistryPath,
  compositionRegistryFileName,
  compositionRegistryPath,
  committedRegistryBundle,
  discoverCollectedDirs,
  discoverCollectedDirsIn,
  listNamedCompositionRegistries,
  parseNamedCompositionRegistryFileName,
  renderCollectedDirRegistry,
  standardPluginDirsFromSnapshot,
  standardPluginDirsIn,
  type DiscoveredCollectedDir,
  type RegistryGenContext,
} from "./plugin-registry-gen";

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
    root,
    reads,
    all: () => paths,
    has: (p) => Object.hasOwn(files, p),
    under: (dir) =>
      dir === "" ? paths : paths.filter((p) => p.startsWith(`${dir}/`)),
    read: (p) => {
      reads.push(p);
      return Promise.resolve(Object.hasOwn(files, p) ? files[p]! : null);
    },
  };
}

/** A fresh git repository holding `files` untracked (so `--others` lists them). */
function gitFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "collected-dir-git-"));
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
  const refused = await discoverCollectedDirsIn(
    memRepo("/repo", {
      [pj("d/core/index.ts")]: 'defineCollectedDir("exempt", OPTS);',
    }),
  ).then(
    () => null,
    (err: unknown) => err,
  );
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toContain(
    "second argument must be the literal",
  );
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
    "/repo/plugins/outer/plugins/inner",
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

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test, so this asserts
 * the rejection for real.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

test("an undeclared collected-dir name throws, naming the file", async () => {
  const file = pj("sdk/core/dirs.ts");
  const files = {
    [pj("sdk/core/index.ts")]: "export {};",
    [file]: 'defineCollectedDir("widget");',
  };
  const repo = memRepo("/repo", files);
  expect((await rejection(discoverCollectedDirsIn(repo))).message).toMatch(
    new RegExp(`${file}.*"widget".*not a plugin folder`),
  );
  expect((await rejection(standardPluginDirsIn(repo))).message).toMatch(
    /not a plugin folder/,
  );
  // The sync and snapshot fronts share the same pure core.
  const root = gitFixture(files);
  expect(() => discoverCollectedDirs(root)).toThrow(/not a plugin folder/);
  const fs = {
    files: new Map(
      Object.entries(files).map(([rel, text]) => [`/repo/${rel}`, text]),
    ),
    dirs: new Map(),
  };
  expect(() => standardPluginDirsFromSnapshot("/repo", fs)).toThrow(
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
  const root = "/repo";
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
    ownerDir: "/repo/plugins/framework/plugins/web-sdk",
  };
  const file = collectedDirNamedCompositionRegistryPath(def, "sonata");
  expect(file).toBe(
    "/repo/plugins/framework/plugins/web-sdk/core/web.composition.sonata.generated.ts",
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
 * `singularity` is an ordinary composition — it just happens to be the one whose
 * closure is the whole tree, which is exactly what `plugins-registry-in-sync`
 * re-derives and asserts on every build. So asking for its registry must hand
 * back `<dir>.generated.ts`, and nothing may ever emit a
 * `<dir>.composition.singularity.generated.ts` for a backend to pick up by
 * presence.
 */
test("the main composition resolves to the committed registry, every other to a filtered one", () => {
  const def: DiscoveredCollectedDir = {
    dir: "server",
    membership: "composition",
    _brand: "CollectedDirDef",
    ownerDir: "/repo/plugins/framework/plugins/server-core",
  };
  expect(compositionRegistryPath(def, "singularity")).toBe(
    "/repo/plugins/framework/plugins/server-core/core/server.generated.ts",
  );
  expect(compositionRegistryPath(def, "sonata")).toBe(
    "/repo/plugins/framework/plugins/server-core/core/server.composition.sonata.generated.ts",
  );
  // The filename half, which `release` asks directly (it holds a repo-relative
  // path, not a DiscoveredCollectedDir).
  expect(compositionRegistryFileName("web", "singularity")).toBe(
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

test("listNamedCompositionRegistries finds per-name files, skipping singletons", () => {
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
  });

  const listed = listNamedCompositionRegistries(namedRoot)
    .map((e) => `${e.dir}:${e.name}`)
    .sort();
  expect(listed).toEqual([
    "prewarm:sonata",
    "server:pages",
    "server:sonata",
    "web:sonata",
  ]);
});

// ── The bundle filter is the WHOLE filter ──────────────────────────
//
// Since Phase 7 a registry is always the registry OF a composition: `bundle` is
// required, and it is the only thing that decides who is emitted. These two tests
// pin that property directly, on a synthetic tree, so it holds independently of
// what any real manifest says:
//
//   • the full id set renders every entry, with the dependency graph intact —
//     this is what the committed `<dir>.generated.ts` files are (rendered with
//     `ctx.mainBundle`, which for `singularity` is every id it reaches);
//   • dropping ONE id from the bundle drops exactly that entry, and prunes it out
//     of any surviving entry's `dependsOn` — a dangling dep would break the
//     loader's topo-sort.

/** A `PluginNode` with only the fields the entry collector reads set meaningfully. */
function fakeNode(pluginsRoot: string, path: string): PluginNode {
  return {
    dir: join(pluginsRoot, path),
    path,
    name: path.split("/").at(-1)!,
    id: asPluginId(
      path
        .split("/")
        .filter((s) => s !== "plugins")
        .join("."),
    ),
    descriptions: {},
    loadBearing: false,
    collapsed: false,
    compositionRoot: false,
    runtimes: { web: true, server: false, central: false },
    children: [],
    facets: {},
  };
}

/**
 * A synthetic three-plugin tree over an in-memory file set: `beta/web` imports
 * `alpha`'s web barrel, so the emitted `beta` entry carries
 * `dependsOn: ["alpha"]`. A `web/plugins/` file of `gamma`'s that imports
 * `alpha` is a sub-plugin's, not gamma's, and gamma's test code (a
 * `*.test.ts`, a `__tests__/` helper, a `testing/` barrel) importing `alpha` is
 * not what gamma ships — so gamma depends on nothing.
 *
 * The ctx is built by hand rather than through `buildRegistryGenContext` on
 * purpose: what is under test is the renderer's bundle-dependence, and a
 * hand-built ctx keeps `graph`/`mainBundle` (which the renderer never reads) out
 * of the picture entirely.
 */
function bundleFixture(): {
  ctx: RegistryGenContext;
  def: DiscoveredCollectedDir;
} {
  const fixtureRoot = "/fixture";
  const pluginsRoot = join(fixtureRoot, "plugins");
  const repo = memRepo(fixtureRoot, {
    [pj("alpha/web/index.ts")]: "export default { name: 'alpha' };\n",
    [pj("beta/web/index.ts")]:
      'import x from "@plugins/alpha/web";\nexport default { name: "beta", x };\n',
    [pj("gamma/web/index.ts")]: "export default { name: 'gamma' };\n",
    [pj("gamma/web/plugins/sub/x.ts")]: 'import "@plugins/alpha/web";\n',
    [pj("gamma/web/x.test.ts")]: 'import "@plugins/alpha/web";\n',
    [pj("gamma/web/__tests__/helper.ts")]: 'import "@plugins/alpha/web";\n',
    [pj("gamma/web/testing/index.ts")]: 'export * from "@plugins/alpha/web";\n',
  });
  const nodes = ["alpha", "beta", "gamma"].map((p) => fakeNode(pluginsRoot, p));
  const tree = {
    pluginsRoot,
    byDir: new Map(nodes.map((n) => [n.dir, n])),
    byPath: new Map(nodes.map((n) => [n.path, n])),
    roots: nodes,
    facets: [],
  };
  const ctx: RegistryGenContext = {
    root: fixtureRoot,
    tree,
    // Pure over `node.facets` (empty here) — the renderer never reads the graph;
    // it is on the ctx so every consumer shares one classify pass.
    graph: classifyEdges(tree),
    mainBundle: new Set(nodes.map((n) => n.id)),
    main: { id: "singularity", home: "alpha" },
    repo: () => Promise.resolve(repo),
    dirScans: new Map(),
  };
  return {
    ctx,
    def: {
      dir: "web",
      membership: "composition",
      _brand: "CollectedDirDef",
      ownerDir: pluginsRoot,
    },
  };
}

test("a bundle carrying every id renders every entry, with its deps", async () => {
  const { ctx, def } = bundleFixture();
  const rendered = await renderCollectedDirRegistry({
    ctx,
    def,
    bundle: ctx.mainBundle,
    composition: ctx.main,
  });

  expect(rendered).toContain('id: "alpha"');
  expect(rendered).toContain('id: "beta"');
  expect(rendered).toContain('dependsOn: ["alpha"]');
  expect(rendered).toMatch(/id: "gamma".*dependsOn: \[\]/);
  // Exactly one emitted entry per plugin — no duplicates, nothing dropped.
  expect(rendered.match(/^ {2}\{ pluginPath:/gm)).toHaveLength(3);
});

test("a composition registry names its composition; a checkout one names none", async () => {
  const { ctx, def } = bundleFixture();
  const rendered = await renderCollectedDirRegistry({
    ctx,
    def,
    bundle: ctx.mainBundle,
    composition: { id: "website", home: "website" },
  });
  expect(rendered).toContain(
    'export const composition: CompositionIdentity = { id: "website", home: "website" };',
  );
  const checkout = await renderCollectedDirRegistry({
    ctx,
    def: { ...def, membership: "checkout" },
    bundle: ctx.mainBundle,
    composition: ctx.main,
  });
  expect(checkout).not.toContain("export const composition");
});

test("the committed bundle is main's closure for a composition dir, every plugin for a checkout dir", () => {
  const { ctx, def } = bundleFixture();
  const narrowed: RegistryGenContext = {
    ...ctx,
    mainBundle: new Set([...ctx.mainBundle].filter((id) => id === "alpha")),
  };
  expect([...committedRegistryBundle(narrowed, def)]).toEqual(["alpha"]);
  expect(
    [
      ...committedRegistryBundle(narrowed, {
        ...def,
        dir: "exempt",
        membership: "checkout",
      }),
    ].sort(),
  ).toEqual(["alpha", "beta", "gamma"]);
});

test("a bundle missing one id differs by exactly that entry, and prunes the dep on it", async () => {
  const { ctx, def } = bundleFixture();
  const full = await renderCollectedDirRegistry({
    ctx,
    def,
    bundle: ctx.mainBundle,
    composition: ctx.main,
  });
  const withoutAlpha = await renderCollectedDirRegistry({
    ctx,
    def,
    bundle: new Set([...ctx.mainBundle].filter((id) => id !== "alpha")),
    composition: ctx.main,
  });

  expect(withoutAlpha).not.toContain('id: "alpha"');
  expect(withoutAlpha).toContain('id: "beta"');
  // `beta` survives, but its dependency on the absent `alpha` is pruned — a
  // dangling `dependsOn` would break the loader's topo-sort.
  expect(withoutAlpha).not.toContain('dependsOn: ["alpha"]');
  // The difference is exactly one entry line, not a reshuffle.
  const lines = (s: string) =>
    s.split("\n").filter((l) => l.startsWith("  { pluginPath:"));
  expect(lines(full)).toHaveLength(3);
  expect(lines(withoutAlpha)).toHaveLength(2);
});
