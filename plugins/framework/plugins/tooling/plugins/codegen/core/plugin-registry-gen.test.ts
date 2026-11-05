/**
 * A composition's backend entry, and the registry renderer's bundle filter.
 * (Collected-dir discovery is tested in `collected-dir/discovery`, the
 * per-name registry grammar in `codegen/composition-registries`.)
 */

import { createSourceScans } from "./browser-host-coverage";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { test, expect } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  globPaths,
  repoFilesOver,
  type RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import { classifyEdges } from "@plugins/plugin-meta/plugins/closure/core";
import type { PluginNode } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  committedRegistryBundle,
  renderBackendEntry,
  renderCollectedDirRegistry,
  type RegistryGenContext,
} from "./plugin-registry-gen";
import type { DiscoveredCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/plugins/discovery/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";

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

test("a composition's backend entry imports its own registries by literal path", () => {
  const main = renderBackendEntry(MAIN_COMPOSITION_ID);
  expect(main).toContain('import * as server from "../core/server.generated";');
  expect(main).toContain(
    'import * as machine from "../core/machine.generated";',
  );
  const sonata = renderBackendEntry("sonata");
  expect(sonata).toContain(
    'import * as server from "../core/server.composition.sonata.generated";',
  );
  expect(sonata).toContain(
    'import * as machine from "../core/machine.composition.sonata.generated";',
  );
  // The namespace is declared before anything else is imported.
  expect(sonata.split("\n").find((l) => l.startsWith("import"))).toBe(
    'import "./declare-namespace";',
  );
  expect(() => renderBackendEntry("../evil")).toThrow();
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
//     `ctx.mainBundle`, which for the main composition is every id it reaches);
//   • dropping ONE id from the bundle drops exactly that entry, and prunes it out
//     of any surviving entry's `dependsOn` — a dangling dep would break the
//     loader's topo-sort.

/** A `PluginNode` with only the fields the entry collector reads set meaningfully. */
function fakeNode(pluginsRoot: AppPath, path: string): PluginNode {
  return {
    dir: joinAppPath(pluginsRoot as AppPath, path),
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
    runtimes: { web: true, server: false, machine: false, central: false },
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
  const fixtureRoot = asAppPath("/fixture");
  const pluginsRoot = joinAppPath(fixtureRoot, "plugins");
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
    repo: repoFilesOver(asAppPath(fixtureRoot), []),
  };
  const ctx: RegistryGenContext = {
    root: fixtureRoot,
    tree,
    // Pure over `node.facets` (empty here) — the renderer never reads the graph;
    // it is on the ctx so every consumer shares one classify pass.
    graph: classifyEdges(tree),
    mainBundle: new Set(nodes.map((n) => n.id)),
    main: { id: MAIN_COMPOSITION_ID, home: "alpha" },
    repo: () => Promise.resolve(repo),
    dirScans: new Map(),
    browserHostGraphs: new Map(),
    sourceScans: () => Promise.resolve(createSourceScans(repo)),
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

// ── The machine registry: a companion of the server graph ──────────────────
//
// A machine entry boots in the server graph as its own node: its id is
// `<id>#machine`, its `dependsOn` names `x#machine` for a machine-barrel import,
// the server node `x` for any other import of `x`, and its own server node
// implicitly. A dep on a plugin the bundle drops is pruned like any other.

function machineFixture(): {
  ctx: RegistryGenContext;
  def: DiscoveredCollectedDir;
} {
  const fixtureRoot = asAppPath("/fixture");
  const pluginsRoot = joinAppPath(fixtureRoot, "plugins");
  const repo = memRepo(fixtureRoot, {
    [pj("alpha/server/index.ts")]: "export default {};\n",
    [pj("alpha/machine/index.ts")]: "export default {};\n",
    [pj("beta/server/index.ts")]: "export default {};\n",
    [pj("beta/machine/index.ts")]:
      'import "@plugins/alpha/machine";\nimport "@plugins/gamma/core";\nexport default {};\n',
    [pj("gamma/server/index.ts")]: "export default {};\n",
    // A machine half with no server half of its own.
    [pj("delta/machine/index.ts")]:
      'import "@plugins/alpha/server";\nexport default {};\n',
  });
  const nodes = ["alpha", "beta", "gamma", "delta"].map((p) =>
    fakeNode(pluginsRoot, p),
  );
  const tree = {
    pluginsRoot,
    byDir: new Map(nodes.map((n) => [n.dir, n])),
    byPath: new Map(nodes.map((n) => [n.path, n])),
    roots: nodes,
    facets: [],
    repo: repoFilesOver(asAppPath(fixtureRoot), []),
  };
  const ctx: RegistryGenContext = {
    root: fixtureRoot,
    tree,
    graph: classifyEdges(tree),
    mainBundle: new Set(nodes.map((n) => n.id)),
    main: { id: MAIN_COMPOSITION_ID, home: null },
    repo: () => Promise.resolve(repo),
    dirScans: new Map(),
    browserHostGraphs: new Map(),
    sourceScans: () => Promise.resolve(createSourceScans(repo)),
  };
  return {
    ctx,
    def: {
      dir: "machine",
      membership: "composition",
      _brand: "CollectedDirDef",
      ownerDir: pluginsRoot,
    },
  };
}

test("machine entries are machine nodes depending on server and machine nodes", async () => {
  const { ctx, def } = machineFixture();
  const rendered = await renderCollectedDirRegistry({
    ctx,
    def,
    bundle: ctx.mainBundle,
    composition: ctx.main,
  });
  expect(rendered).toContain("export const machineEntries");
  expect(rendered).toMatch(/id: "alpha#machine".*dependsOn: \["alpha"\]/);
  expect(rendered).toMatch(
    /id: "beta#machine".*dependsOn: \["alpha#machine", "beta", "gamma"\]/,
  );
  expect(rendered).toMatch(/id: "delta#machine".*dependsOn: \["alpha"\]/);
});

test("a machine dep on a plugin outside the bundle is pruned", async () => {
  const { ctx, def } = machineFixture();
  const rendered = await renderCollectedDirRegistry({
    ctx,
    def,
    bundle: new Set([...ctx.mainBundle].filter((id) => id !== "gamma")),
    composition: ctx.main,
  });
  expect(rendered).toMatch(
    /id: "beta#machine".*dependsOn: \["alpha#machine", "beta"\]/,
  );
});
