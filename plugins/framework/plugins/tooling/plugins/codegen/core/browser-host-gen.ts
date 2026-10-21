// A browser host's plugin graph, generated: the registry entries a page's Web
// Worker boots (`server-core`'s `bootBrowserHost`), and which plugin provides
// each host service there.
//
// A host names ONE composition, as plain data, in
// `plugins/<p>/bin/browser-host.composition.ts`
// (`export const hostComposition = "<name>";`). Its graph is INFERRED from it,
// the way the desktop server loads every plugin of its composition
// (`deriveBrowserHostGraph`):
//
// - the roots: every plugin of the composition's bundle whose server barrel is
//   `portable: true`, plus every portable server barrel the host's own entry
//   (`bin/browser-host.ts` — its seed) loads;
// - the providers: the portable server barrels a `base-exclusions` negative
//   names (no desktop ships them) that provide a host service the graph
//   declares, added to a fixpoint — exactly one per service;
// - the guard: every server barrel the graph's code statically loads
//   (`importClosure`) must be in it, so a portable barrel reaching a
//   non-portable one fails here, naming the import chain, not at worker boot.
//
// Each entry's `dependsOn` is the server registry's raw edges, kept to the
// graph. Written beside the declaration as `bin/browser-host.generated.ts`,
// committed, and held to this render by `plugins-registry-in-sync`.
//
// The host's PAGE side is generated from the same derivation, as
// `core/browser-host.generated.ts` (`browserHost`: the composition's id, home,
// web plugins and the host's `start`): the scope a page renders the host's
// subtree in (`<PluginScope>`), so the page shows exactly the plugins the
// worker serving it boots — at most: the scope is an upper bound, and a page
// lacking a scoped plugin renders less (see `renderBrowserHostScope`).

import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { importClosure } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import {
  asFsPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  flattenManifest,
  resolveComposition,
} from "@plugins/plugin-meta/plugins/closure/core";
import { manifestItemToManifest } from "@plugins/plugin-meta/plugins/composition/core";
import { isPortableServerBarrel } from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  baseExclusionServerBarrels,
  hostServicesByName,
  parseHostServiceDeclarations,
  providedServiceNames,
  type HostServiceDecl,
} from "./host-services";
import { readCompositionManifestsFromDisk } from "./main-bundle";
import {
  resolveRegistryHome,
  scanCollectedDir,
  type RegistryGenContext,
} from "./plugin-registry-gen";
import { writeGenerated } from "./write-generated";

const DECLARATION_RE =
  /^plugins\/((?:[^/]+\/plugins\/)*[^/]+)\/bin\/browser-host\.composition\.ts$/;

const SERVER_BARREL_RE =
  /^plugins\/((?:[^/]+\/plugins\/)*[^/]+)\/server\/index\.ts$/;

/** One host: the plugin declaring it, its entry, and its generated file. */
export interface BrowserHostDecl {
  /** The declaring plugin's path (`apps/plugins/agent-manager/plugins/demo`). */
  pluginPath: string;
  /** Repo-relative `bin/browser-host.composition.ts`. */
  declaration: string;
  /** Repo-relative `bin/browser-host.ts` — the worker's entry. */
  entry: string;
  /** Repo-relative `bin/browser-host.generated.ts` — the worker's graph. */
  generated: string;
  /** Repo-relative `core/browser-host.generated.ts` — the page's scope (`browserHost`). */
  scopeGenerated: string;
}

/** Every browser host the repo declares. */
export function discoverBrowserHosts(repo: RepoFiles): BrowserHostDecl[] {
  const hosts: BrowserHostDecl[] = [];
  for (const path of repo.all()) {
    const m = DECLARATION_RE.exec(path);
    if (m === null) continue;
    hosts.push({
      pluginPath: m[1]!,
      declaration: path,
      entry: path.replace(/\.composition\.ts$/, ".ts"),
      generated: path.replace(/\.composition\.ts$/, ".generated.ts"),
      scopeGenerated: `plugins/${m[1]!}/core/browser-host.generated.ts`,
    });
  }
  return hosts.sort((a, b) => a.pluginPath.localeCompare(b.pluginPath));
}

/**
 * The host's composition, read off the declaration's text: one string literal,
 * so the generator and the check read the same file through the run's file set
 * and never evaluate it.
 */
async function declaredComposition(
  repo: RepoFiles,
  host: BrowserHostDecl,
): Promise<string> {
  const text = (await repo.read(host.declaration)) ?? "";
  const m = /export const hostComposition = "([^"]+)";/.exec(text);
  if (m === null) {
    throw new Error(
      `${host.declaration} must export \`export const hostComposition = "<composition name>";\` — one string literal.`,
    );
  }
  return m[1]!;
}

/** What `importClosure` answers that the derivation reads. */
export interface HostClosure {
  modules: ReadonlySet<string>;
  importChain(module: string): string[];
}

/** The inputs of {@link resolveHostGraph}, each already read off the repo. */
export interface HostGraphInputs {
  /** Who the graph is for, in errors (`<declaration> (composition "<name>")`). */
  label: string;
  /** Repo-relative entry module (`bin/browser-host.ts`). */
  entry: string;
  /** The server barrels of the composition's bundle (portable or not). */
  bundleBarrels: readonly string[];
  /** The server barrels a `base-exclusions` negative names. */
  candidateBarrels: readonly string[];
  read(path: string): Promise<string | null>;
  closure(entry: string): Promise<HostClosure>;
}

/** A browser host's inferred graph. */
export interface BrowserHostGraph {
  /** Every plugin the host boots, by path, sorted. */
  members: string[];
  /** Service id → the plugin path providing it, sorted by id. */
  providers: Record<string, string>;
}

/**
 * A declared host's graph, with the composition it was inferred from and that
 * composition's page side: the web plugins a page scoped to it renders, its
 * home app, and what leaves when a page is scoped to it.
 */
export interface DerivedBrowserHostGraph extends BrowserHostGraph {
  composition: string;
  /** The composition's resolved home app (`defineApp` id); null when it bundles no app. */
  home: string | null;
  /** The bundle's plugins that have a `web/index.ts`, by dot id, sorted. */
  webPlugins: PluginId[];
  /**
   * The composition's option frontier (`resolveComposition`'s `available`):
   * plugins NOT in the bundle that soft-contribute to a bundled one — exactly
   * what a page scoped to the composition stops rendering. Sorted.
   */
  available: PluginId[];
}

const pluginOfBarrel = (barrel: string): string =>
  SERVER_BARREL_RE.exec(barrel)![1]!;

/**
 * The graph rule over its read inputs (see the header): roots, providers to a
 * fixpoint, exactly one provider per declared service, and the closure guard.
 * Throws — naming the service and its candidates, or the import chain — rather
 * than emitting a graph the worker would refuse at boot.
 */
export async function resolveHostGraph(
  inputs: HostGraphInputs,
): Promise<BrowserHostGraph> {
  const { label, entry } = inputs;
  const source = async (path: string): Promise<string> => {
    const text = await inputs.read(path);
    if (text === null) {
      throw new Error(`${label}: cannot read ${path}.`);
    }
    return text;
  };
  const portable = async (barrel: string): Promise<boolean> =>
    isPortableServerBarrel(await source(barrel));

  // Every module the graph's code loads, with the chain that first reached it.
  const reached = new Map<string, string[]>();
  const absorb = (closure: HostClosure): void => {
    for (const module of closure.modules) {
      if (!reached.has(module))
        reached.set(module, closure.importChain(module));
    }
  };
  const declared = new Map<string, HostServiceDecl & { module: string }>();
  const scanned = new Set<string>();
  const scanDeclarations = async (): Promise<void> => {
    for (const module of [...reached.keys()].sort()) {
      if (scanned.has(module)) continue;
      scanned.add(module);
      const text = await source(module);
      if (!text.includes("defineHostService")) continue;
      for (const d of parseHostServiceDeclarations(text)) {
        declared.set(d.id, { ...d, module });
      }
    }
  };

  const members = new Set<string>();
  for (const barrel of inputs.bundleBarrels) {
    if (await portable(barrel)) members.add(barrel);
  }
  // The entry's own imports (its seed) are roots by rule.
  absorb(await inputs.closure(entry));
  for (const module of [...reached.keys()].sort()) {
    if (SERVER_BARREL_RE.test(module) && (await portable(module))) {
      members.add(module);
    }
  }

  // A member already reached by another closure loads nothing that closure
  // did not (dynamic imports cut on both), so only the unreached are measured.
  const measured = new Set<string>();
  const measure = async (): Promise<void> => {
    for (const barrel of [...members].sort()) {
      if (measured.has(barrel)) continue;
      measured.add(barrel);
      if (reached.has(barrel)) continue;
      absorb(await inputs.closure(barrel));
    }
    await scanDeclarations();
  };
  await measure();

  const candidates: { barrel: string; provides: string[] }[] = [];
  for (const barrel of inputs.candidateBarrels) {
    if (!(await portable(barrel))) continue;
    candidates.push({
      barrel,
      provides: providedServiceNames(await source(barrel)),
    });
  }
  // Providers to a fixpoint: a provider's own code may declare a service.
  for (;;) {
    const names = hostServicesByName(declared.values());
    const added = candidates.filter(
      (c) => !members.has(c.barrel) && c.provides.some((n) => names.has(n)),
    );
    if (added.length === 0) break;
    for (const c of added) members.add(c.barrel);
    await measure();
  }

  const providers: Record<string, string> = {};
  const problems: string[] = [];
  const memberProvides = new Map<string, string[]>();
  for (const barrel of members) {
    memberProvides.set(barrel, providedServiceNames(await source(barrel)));
  }
  for (const service of [...declared.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const by = [...members]
      .filter((b) => memberProvides.get(b)!.includes(service.name))
      .sort();
    if (by.length === 1) {
      providers[service.id] = pluginOfBarrel(by[0]!);
      continue;
    }
    problems.push(
      by.length === 0
        ? `host service "${service.id}" (${service.module}) has no provider: no portable server barrel a \`base-exclusions\` negative names spells ${service.name}.provide(…)`
        : `host service "${service.id}" has ${by.length} providers: ${by.map(pluginOfBarrel).join(", ")}`,
    );
  }

  // The guard: the graph's code loads no server barrel outside it.
  for (const [module, chain] of [...reached].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!SERVER_BARREL_RE.test(module) || members.has(module)) continue;
    problems.push(
      `the graph loads ${module}, which is not in it (${(await portable(module)) ? "portable, but neither in the composition nor a provider" : "not portable"})\n      via ${chain.join(" → ")}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `${label}: the inferred browser-host graph is invalid:\n  - ${problems.join("\n  - ")}`,
    );
  }
  return {
    members: [...members].map(pluginOfBarrel).sort(),
    providers,
  };
}

/**
 * A declared host's graph, inferred from its composition (the header's rule).
 * Shared by the generator, `plugins-registry-in-sync` and the tests, so all
 * three read one derivation.
 */
export async function deriveBrowserHostGraph(
  ctx: RegistryGenContext,
  host: BrowserHostDecl,
): Promise<DerivedBrowserHostGraph> {
  const repo = await ctx.repo();
  const composition = await declaredComposition(repo, host);
  const label = `${host.declaration} (composition "${composition}")`;
  if (!repo.has(host.entry)) {
    throw new Error(`${label}: the host has no entry (${host.entry}).`);
  }
  const manifests = readCompositionManifestsFromDisk(ctx.root);
  const row = manifests.find((m) => m.id === composition);
  if (row === undefined) {
    throw new Error(
      `${label}: no composition "${composition}" in the manifests (plugins/plugin-meta/plugins/composition/core/config.ts).`,
    );
  }
  const resolved = resolveComposition(
    ctx.graph,
    flattenManifest(
      manifestItemToManifest(row),
      manifests.map(manifestItemToManifest),
    ),
  );
  if (resolved.unsatisfiedExclusions.length > 0) {
    throw new Error(
      `${label}: the composition contradicts its own manifest — ${resolved.unsatisfiedExclusions.map((u) => u.target).join(", ")} still bundled despite a negative.`,
    );
  }
  const barrelOf = (id: PluginId): string =>
    `plugins/${asFsPath(id)}/server/index.ts`;
  const graph = await resolveHostGraph({
    label,
    entry: host.entry,
    bundleBarrels: [...resolved.bundle]
      .map(barrelOf)
      .filter((b) => repo.has(b))
      .sort(),
    candidateBarrels: baseExclusionServerBarrels(ctx.graph, manifests, (p) =>
      repo.has(p),
    ),
    read: (path) => repo.read(path),
    // What the bundler loads from this module, as the bundle will.
    closure: (entry) =>
      importClosure(ctx.root, entry, { dynamicImports: "cut" }),
  });
  const webPlugins = [...resolved.bundle]
    .filter((id) => repo.has(`plugins/${asFsPath(id)}/web/index.ts`))
    .sort();
  return {
    ...graph,
    composition,
    home: resolveRegistryHome(ctx.tree, resolved.bundle, composition, row.home),
    webPlugins,
    available: resolved.available,
  };
}

function header(composition: string): string {
  return [
    "// DO NOT EDIT — autogenerated by `./singularity build`",
    "// (see plugins/framework/plugins/tooling/plugins/codegen/core/browser-host-gen.ts).",
    "//",
    `// This browser host's plugin graph, inferred from the "${composition}" composition`,
    "// (`./browser-host.composition.ts`): its portable server barrels, the ones",
    "// `./browser-host.ts` loads, and one provider per host service. The",
    "// `plugins-registry-in-sync` check fails on drift.",
  ].join("\n");
}

/** The generated file of one host, rendered from its derived graph. */
export async function renderBrowserHost(
  ctx: RegistryGenContext,
  { members, providers, composition }: DerivedBrowserHostGraph,
): Promise<string> {
  const graph = new Set(members);
  const { deps } = await scanCollectedDir(ctx, "server");
  const lines = [
    header(composition),
    "",
    'import type { ServerRegistryEntry } from "@plugins/framework/plugins/server-core/core";',
    "",
    "export const hostEntries: ServerRegistryEntry[] = [",
  ];
  for (const pluginPath of members) {
    const dependsOn = (deps.get(pluginPath) ?? []).filter((d) => graph.has(d));
    lines.push(
      `  { pluginPath: ${JSON.stringify(pluginPath)}, id: ${JSON.stringify(pluginPath.split("/plugins/").join("."))}, loader: () => import(${JSON.stringify(`@plugins/${pluginPath}/server`)}), dependsOn: ${JSON.stringify(dependsOn)} },`,
    );
  }
  lines.push(
    "];",
    "",
    "/** Host service id → the plugin providing it in this graph. */",
    "export const hostProviders: Record<string, string> = {",
  );
  for (const [id, pluginPath] of Object.entries(providers)) {
    lines.push(`  ${JSON.stringify(id)}: ${JSON.stringify(pluginPath)},`);
  }
  lines.push("};", "");
  return lines.join("\n");
}

/**
 * The page side of one host, rendered from its derived graph: `browserHost`,
 * the `DemoHost` a scenario names — the scope (`ScopedComposition`) and the
 * worker's start, from one derivation.
 *
 * The scope is an UPPER bound on what the host's subtree renders, not a
 * promise that the page ships it: a page whose own composition lacks some
 * scoped plugin (e.g. `agent-manager-lean`, without the self-improvement pack)
 * simply renders less inside the scope. So no build-time assertion ties the
 * scope to every composition carrying the declaring plugin.
 */
export function renderBrowserHostScope(
  host: BrowserHostDecl,
  { composition, home, webPlugins }: DerivedBrowserHostGraph,
): string {
  return [
    "// DO NOT EDIT — autogenerated by `./singularity build`",
    "// (see plugins/framework/plugins/tooling/plugins/codegen/core/browser-host-gen.ts).",
    "//",
    `// This browser host's page side: the "${composition}" composition's identity and`,
    "// web plugins (its bundle ∩ web barrels) — the scope a page renders the host's",
    "// subtree in, so it shows exactly what the worker (`../bin/browser-host.ts`)",
    "// serves. The `plugins-registry-in-sync` check fails on drift.",
    "",
    'import type { DemoHost } from "@plugins/framework/plugins/browser-server/plugins/demo/core";',
    "",
    "export const browserHost = {",
    `  id: ${JSON.stringify(composition)},`,
    `  home: ${JSON.stringify(home)},`,
    "  plugins: [",
    ...webPlugins.map((id) => `    ${JSON.stringify(id)},`),
    "  ],",
    `  start: () => import(${JSON.stringify(`@browser-host/${host.pluginPath}`)}),`,
    "} satisfies DemoHost;",
    "",
  ].join("\n");
}

/**
 * Write every host's generated graph. Returns one line per host naming what its
 * composition leaves out (`available`) — the soft contributors a page scoped to
 * it does not render — for the caller to log.
 */
export async function generateBrowserHosts(
  ctx: RegistryGenContext,
): Promise<string[]> {
  const summaries: string[] = [];
  for (const host of discoverBrowserHosts(await ctx.repo())) {
    const graph = await deriveBrowserHostGraph(ctx, host);
    await writeGenerated({
      file: `${ctx.root}/${host.generated}`,
      content: await renderBrowserHost(ctx, graph),
    });
    await writeGenerated({
      file: `${ctx.root}/${host.scopeGenerated}`,
      content: renderBrowserHostScope(host, graph),
    });
    summaries.push(
      `browser host ${host.pluginPath} (composition "${graph.composition}"): ${graph.members.length} server plugins, ${graph.webPlugins.length} web plugins; left out (available, ${graph.available.length}): ${graph.available.join(", ") || "none"}`,
    );
  }
  return summaries;
}
