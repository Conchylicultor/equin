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
//   portable (`serverPortabilityOf`: nothing its static closure loads needs
//   the computer — derived, never declared), plus every portable server
//   barrel the host's own entry (`bin/browser-host.ts`) loads, and — when the
//   host ships a starting snapshot — every one its snapshot script
//   (`bin/browser-host.snapshot.ts`, the seed run at build time over this same
//   graph) loads;
// - the providers: the portable host providers (`EdgeGraph.hostProviders`: a
//   plugin whose `server/index.ts` provides a host service, which no
//   composition bundles) that provide a host service the graph declares, added
//   to a fixpoint — exactly one per service;
// - the guard: every server barrel the graph's code statically loads
//   (the plugin-records module graph's bundler view, one per fixpoint
//   round — its file facts are records) must be in it,
//   so a portable barrel reaching a non-portable one fails here, naming the
//   import chain, not at worker boot.
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
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  buildModuleGraph,
  type BundledClosure,
  currentRecordStore,
  NO_OUTSIDE_FILES,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  asFsPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  hostServicesByName,
  parseHostServiceDeclarations,
  providedServiceNames,
  type HostServiceDecl,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { parseExternalHostsDeclarations } from "./external-hosts";
import {
  serverPortabilityOf,
  type ServerPortability,
} from "@plugins/framework/plugins/tooling/plugins/boundaries/core";
import {
  resolveHostCoverage,
  serverBarrelBlockers,
  type HostRead,
} from "./browser-host-coverage";
import { hostProviderServerBarrels } from "./host-services";
import {
  discoverBrowserHosts,
  resolveHostScope,
  type BrowserHostDecl,
} from "./browser-host-scope";
import {
  resolveRegistryHome,
  resolveRegistryUnlisted,
  scanCollectedDir,
  type BrowserHostGraphMemo,
  type RegistryGenContext,
} from "./plugin-registry-gen";
import type { CodegenStep } from "./regen-pipeline";
import { writeGenerated } from "./write-generated";

const SERVER_BARREL_RE =
  /^plugins\/((?:[^/]+\/plugins\/)*[^/]+)\/server\/index\.ts$/;

/**
 * What `importClosures` answers that the derivation reads: the union of some
 * entrypoints' closures, with the chain to a module from the first entrypoint
 * reaching it.
 */
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
  /** Repo-relative snapshot script (`bin/browser-host.snapshot.ts`), when the host has one. */
  snapshotEntry?: string;
  /** The server barrels of the composition's bundle (portable or not). */
  bundleBarrels: readonly string[];
  /** The host providers' server barrels (`hostProviderServerBarrels`). */
  candidateBarrels: readonly string[];
  read(path: string): Promise<string | null>;
  /**
   * Which server barrels are portable, and why one is not
   * (`serverPortabilityOf`) — an input like {@link closure}, so a test
   * injects it.
   */
  portability: Pick<ServerPortability, "isPortable" | "offenders">;
  /**
   * The union closure of `entries` (in order), measured at once — the
   * derivation asks once for the entry, then once per fixpoint round for the
   * members no earlier closure reached.
   */
  closure(entries: readonly string[]): Promise<HostClosure>;
}

/** A browser host's inferred graph. */
export interface BrowserHostGraph {
  /** Every plugin the host boots, by path, sorted. */
  members: string[];
  /** Service id → the plugin path providing it, sorted by id. */
  providers: Record<string, string>;
  /** How many closure measurements the derivation ran (its cost; logged by the generator). */
  closures: number;
}

/**
 * A declared host's graph, with the composition it was inferred from and that
 * composition's page side: the web plugins a page scoped to it renders, its
 * home app, and what leaves when a page is scoped to it.
 */
export interface InferredBrowserHostGraph extends BrowserHostGraph {
  /** Who the graph is for, in errors (`<declaration> (composition "<name>")`). */
  label: string;
  composition: string;
  /** The composition's whole bundle, by dot id. */
  bundle: ReadonlySet<PluginId>;
  /** The composition's resolved home app (`defineApp` id); null when it bundles no app. */
  home: string | null;
  /** The bundled apps its launchers do not offer (`defineApp` ids), sorted. */
  unlisted: readonly string[];
  /** The bundle's plugins that have a `web/index.ts`, by dot id, sorted. */
  webPlugins: PluginId[];
  /**
   * The plugins with a `web/index.ts` the composition negates by name (its
   * negatives' direct targets), sorted — left out of the scope on purpose, so
   * a dispatch falling back for one is no surprise (`ScopedComposition.negated`).
   */
  negatedWebPlugins: PluginId[];
  /**
   * The composition's option frontier (`resolveComposition`'s `available`):
   * plugins NOT in the bundle that soft-contribute to a bundled one — exactly
   * what a page scoped to the composition stops rendering. Sorted.
   */
  available: PluginId[];
}

/** An inferred host graph that passed the coverage guard. */
export interface DerivedBrowserHostGraph extends InferredBrowserHostGraph {
  /**
   * Every live read the scoped page references, each served by the graph or
   * declared `needsMachine` — the coverage guard's answer
   * (`browser-host-coverage.ts`), emitted as the page side's `hostReads` so
   * the boot test holds the booted graph to it. Sorted by key.
   */
  reads: HostRead[];
  /**
   * The third-party hosts the scoped page may reach — each declared by a
   * scoped web plugin's `ExternalHosts.Declare` — emitted as the page side's
   * `externalHosts`, which the demo's no-leak e2e holds every off-origin
   * request to. Sorted by host, then plugin.
   */
  externalHosts: HostExternalHost[];
}

/** One declared third-party host, as the generated `externalHosts` lists it. */
export interface HostExternalHost {
  host: string;
  plugin: string;
  reason: string;
}

/** Every `ExternalHosts.Declare` of the scoped web barrels, one entry per host. */
async function scopedExternalHosts(
  repo: RepoFiles,
  webPlugins: readonly PluginId[],
): Promise<HostExternalHost[]> {
  const out: HostExternalHost[] = [];
  for (const id of webPlugins) {
    const barrel = `plugins/${asFsPath(id)}/web/index.ts`;
    const text = await repo.read(barrel);
    if (text === null) throw new Error(`cannot read ${barrel}`);
    if (!text.includes("ExternalHosts")) continue;
    for (const decl of parseExternalHostsDeclarations(text)) {
      for (const host of decl.hosts) {
        out.push({ host, plugin: id, reason: decl.reason });
      }
    }
  }
  return out.sort(
    (a, b) => a.host.localeCompare(b.host) || a.plugin.localeCompare(b.plugin),
  );
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
  const portable = (barrel: string): boolean =>
    inputs.portability.isPortable(barrel);

  // Every module the graph's code loads, with the closure that first reached
  // it — whose chain to it is asked for only when the guard fails on it.
  const reached = new Map<string, HostClosure>();
  let closures = 0;
  const absorb = async (entries: readonly string[]): Promise<void> => {
    closures++;
    const closure = await inputs.closure(entries);
    for (const module of closure.modules) {
      if (!reached.has(module)) reached.set(module, closure);
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
    if (portable(barrel)) members.add(barrel);
  }
  // The entry's own imports — and its snapshot script's (its seed) — are
  // roots by rule.
  await absorb(
    inputs.snapshotEntry === undefined
      ? [entry]
      : [entry, inputs.snapshotEntry],
  );
  for (const module of [...reached.keys()].sort()) {
    if (SERVER_BARREL_RE.test(module) && portable(module)) {
      members.add(module);
    }
  }

  // A member already reached by another closure loads nothing that closure
  // did not (dynamic imports cut on both), so only the unreached are measured
  // — all of them in one union closure, sorted, so a module's chain is the one
  // the first member reaching it answers.
  const measured = new Set<string>();
  const measure = async (): Promise<void> => {
    const unreached: string[] = [];
    for (const barrel of [...members].sort()) {
      if (measured.has(barrel)) continue;
      measured.add(barrel);
      if (!reached.has(barrel)) unreached.push(barrel);
    }
    if (unreached.length > 0) await absorb(unreached);
    await scanDeclarations();
  };
  await measure();

  const candidates: { barrel: string; provides: string[] }[] = [];
  for (const barrel of inputs.candidateBarrels) {
    if (!portable(barrel)) continue;
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
        ? `host service "${service.id}" (${service.module}) has no provider: no portable host provider (a plugin whose \`server/index.ts\` spells ${service.name}.provide(…))`
        : `host service "${service.id}" has ${by.length} providers: ${by.map(pluginOfBarrel).join(", ")}`,
    );
  }

  // The guard: the graph's code loads no server barrel outside it.
  for (const [module, closure] of [...reached].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!SERVER_BARREL_RE.test(module) || members.has(module)) continue;
    const why = portable(module)
      ? "portable, but neither in the composition nor a provider"
      : `not portable: ${inputs.portability
          .offenders(module)
          .slice(0, 3)
          .map((o) => `${o.module} needs ${o.needs.join(", ")}`)
          .join("; ")}`;
    problems.push(
      `the graph loads ${module}, which is not in it (${why})\n      via ${closure.importChain(module).join(" → ")}`,
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
    closures,
  };
}

/** `host`'s memo slot on `ctx` (see `RegistryGenContext.browserHostGraphs`). */
function hostMemo(
  ctx: RegistryGenContext,
  host: BrowserHostDecl,
): BrowserHostGraphMemo {
  let memo = ctx.browserHostGraphs.get(host.declaration);
  if (memo === undefined) {
    memo = {};
    ctx.browserHostGraphs.set(host.declaration, memo);
  }
  return memo;
}

/**
 * A declared host's graph, inferred from its composition (the header's rule)
 * and held to the coverage guard (`browser-host-coverage.ts`): everything its
 * scoped page reads or calls is served by the graph or declared
 * `needsMachine`, else this throws naming each gap. Shared by the generator,
 * `plugins-registry-in-sync` and the tests, so all three read one derivation
 * — a gap fails `build` and `push`.
 *
 * Memoized on `ctx` (a snapshot): every caller holding the same ctx shares
 * one derivation, and its inference with `inferBrowserHostGraph`'s callers.
 */
export function deriveBrowserHostGraph(
  ctx: RegistryGenContext,
  host: BrowserHostDecl,
): Promise<DerivedBrowserHostGraph> {
  return (hostMemo(ctx, host).derived ??= deriveUncached(ctx, host));
}

async function deriveUncached(
  ctx: RegistryGenContext,
  host: BrowserHostDecl,
): Promise<DerivedBrowserHostGraph> {
  const graph = await inferBrowserHostGraph(ctx, host);
  const repo = await ctx.repo();
  const { reads } = await resolveHostCoverage({
    label: graph.label,
    members: graph.members,
    webPlugins: graph.webPlugins,
    bundle: graph.bundle,
    sources: await ctx.sourceScans(),
    blockers: async (barrel) =>
      serverBarrelBlockers(await serverPortabilityOf(repo), barrel),
  });
  return {
    ...graph,
    reads,
    externalHosts: await scopedExternalHosts(repo, graph.webPlugins),
  };
}

/**
 * A declared host's graph, inferred from its composition (the header's rule),
 * before the coverage guard: what `deriveBrowserHostGraph` builds on, and what
 * the guard's config and contribution arms (run by
 * `config-v2:registrations-paired` and `browser-host:contributions-covered`,
 * where the barrels are imported) read. Memoized on `ctx`, like the
 * derivation.
 */
export function inferBrowserHostGraph(
  ctx: RegistryGenContext,
  host: BrowserHostDecl,
): Promise<InferredBrowserHostGraph> {
  return (hostMemo(ctx, host).inferred ??= inferUncached(ctx, host));
}

async function inferUncached(
  ctx: RegistryGenContext,
  host: BrowserHostDecl,
): Promise<InferredBrowserHostGraph> {
  const repo = await ctx.repo();
  const { label, composition, row, resolved, webPlugins, negatedWebPlugins } =
    await resolveHostScope(ctx, host);
  if (!repo.has(host.entry)) {
    throw new Error(`${label}: the host has no entry (${host.entry}).`);
  }
  const own = ownOutputs(host);
  const barrelOf = (id: PluginId): string =>
    `plugins/${asFsPath(id)}/server/index.ts`;
  const graph = await resolveHostGraph({
    label,
    entry: host.entry,
    ...(repo.has(host.snapshotEntry)
      ? { snapshotEntry: host.snapshotEntry }
      : {}),
    bundleBarrels: [...resolved.bundle]
      .map(barrelOf)
      .filter((b) => repo.has(b))
      .sort(),
    candidateBarrels: hostProviderServerBarrels(ctx.graph),
    read: async (path) => own.get(path) ?? (await repo.read(path)),
    portability: await serverPortabilityOf(repo),
    // What the bundler loads from these modules, as the bundle will: the
    // record module graph's bundler view (`serverPortabilityOf`'s reading),
    // over the host's own outputs as they render empty (`ownOutputs`).
    closure: (entries) => bundledClosureOf(repo, entries, own),
  });
  return {
    ...graph,
    label,
    composition,
    bundle: resolved.bundle,
    home: resolveRegistryHome(ctx.tree, resolved.bundle, composition, row.home),
    unlisted: resolveRegistryUnlisted(
      ctx.tree,
      resolved.bundle,
      composition,
      row.unlisted,
      row.home,
    ),
    webPlugins,
    negatedWebPlugins,
    available: resolved.available,
  };
}

function header(composition: string): string {
  return [
    "// DO NOT EDIT — autogenerated by `./equin build`",
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
  return renderHostGraphFile(
    composition,
    members.map((pluginPath) => ({
      pluginPath,
      dependsOn: (deps.get(pluginPath) ?? []).filter((d) => graph.has(d)),
    })),
    providers,
  );
}

/** {@link renderBrowserHost}'s text, from the graph's entries and providers. */
function renderHostGraphFile(
  composition: string,
  entries: readonly { pluginPath: string; dependsOn: readonly string[] }[],
  providers: Record<string, string>,
): string {
  const lines = [
    header(composition),
    "",
    'import type { ServerRegistryEntry } from "@plugins/framework/plugins/server-core/core";',
    "",
    "export const hostEntries: ServerRegistryEntry[] = [",
  ];
  // `core: null` throughout: the host is one bundle, every module it can reach
  // is already in it, so there is no cold core barrel to warm.
  for (const { pluginPath, dependsOn } of entries) {
    lines.push(
      `  { pluginPath: ${JSON.stringify(pluginPath)}, id: ${JSON.stringify(pluginPath.split("/plugins/").join("."))}, loader: () => import(${JSON.stringify(`@plugins/${pluginPath}/server`)}), dependsOn: ${JSON.stringify(dependsOn)}, core: null },`,
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
  {
    composition,
    home,
    unlisted,
    webPlugins,
    negatedWebPlugins,
    reads,
    externalHosts,
  }: Pick<
    DerivedBrowserHostGraph,
    | "composition"
    | "home"
    | "unlisted"
    | "webPlugins"
    | "negatedWebPlugins"
    | "reads"
    | "externalHosts"
  >,
): string {
  return [
    "// DO NOT EDIT — autogenerated by `./equin build`",
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
    ...(unlisted.length > 0
      ? [`  unlisted: ${JSON.stringify(unlisted)},`]
      : []),
    "  plugins: [",
    ...webPlugins.map((id) => `    ${JSON.stringify(id)},`),
    "  ],",
    ...(negatedWebPlugins.length > 0
      ? [
          "  negated: [",
          ...negatedWebPlugins.map((id) => `    ${JSON.stringify(id)},`),
          "  ],",
        ]
      : []),
    `  module: ${JSON.stringify(`@browser-host/${host.pluginPath}`)},`,
    `  start: () => import(${JSON.stringify(`@browser-host/${host.pluginPath}`)}),`,
    "} satisfies DemoHost;",
    "",
    "/**",
    " * Every live read the scoped page references (the coverage guard's answer):",
    " * served by the worker's graph, or declared `needsMachine` and rendered",
    ' * "not available". The host\'s boot test holds the booted graph to it.',
    " */",
    "export const hostReads: readonly {",
    "  readonly key: string;",
    "  readonly needsMachine: boolean;",
    "}[] = [",
    ...reads.map(
      (r) =>
        `  { key: ${JSON.stringify(r.key)}, needsMachine: ${r.needsMachine} },`,
    ),
    "];",
    "",
    "/**",
    " * The third-party hosts the scoped page may reach, each declared by the",
    " * plugin that needs it (`ExternalHosts.Declare`): the one exception to",
    ' * "no request leaves the browser". The page\'s own server is never one.',
    " */",
    "export const externalHosts: readonly {",
    "  readonly host: string;",
    "  readonly plugin: string;",
    "  readonly reason: string;",
    "}[] = [",
    ...externalHosts.map(
      (h) =>
        `  { host: ${JSON.stringify(h.host)}, plugin: ${JSON.stringify(h.plugin)}, reason: ${JSON.stringify(h.reason)} },`,
    ),
    "];",
    "",
  ].join("\n");
}

/**
 * Write every host's generated graph. Returns one line per host naming what its
 * composition leaves out (`available`) — the soft contributors a page scoped to
 * it does not render — for the caller to log.
 *
 * Each host is three `onStep` spans (ids suffixed with the host's plugin path,
 * so two hosts' spans stay apart), so build's profiler shows where the guard's
 * cost goes: the inference (its import closures), the coverage guard (the
 * derivation, whose inference is then a memo hit), and the writes. `onStep`
 * is the pipeline's (`regenerateRegistryCodegen`, which runs inline unless
 * build threads its profiler through).
 */
export async function generateBrowserHosts(
  ctx: RegistryGenContext,
  onStep: CodegenStep,
): Promise<string[]> {
  const summaries: string[] = [];
  for (const host of discoverBrowserHosts(await ctx.repo())) {
    const name = `browser host ${host.pluginPath}`;
    const inferred = await stepped(
      onStep,
      `browserHostInfer:${host.pluginPath}`,
      `${name}: graph inference`,
      () => inferBrowserHostGraph(ctx, host),
    );
    const graph = await stepped(
      onStep,
      `browserHostCoverage:${host.pluginPath}`,
      `${name}: coverage guard`,
      () => deriveBrowserHostGraph(ctx, host),
    );
    await onStep(
      `browserHostWrite:${host.pluginPath}`,
      `${name}: write`,
      async () => {
        await writeGenerated({
          file: joinAppPath(ctx.root, host.generated),
          content: await renderBrowserHost(ctx, graph),
        });
        await writeGenerated({
          file: joinAppPath(ctx.root, host.scopeGenerated),
          content: renderBrowserHostScope(host, graph),
        });
      },
    );
    summaries.push(
      `${name} (composition "${graph.composition}"): ${graph.members.length} server plugins, ${graph.webPlugins.length} web plugins, ${inferred.closures} import-closure builds; left out (available, ${graph.available.length}): ${graph.available.join(", ") || "none"}`,
    );
  }
  return summaries;
}

/** `run` as one `onStep` span, handing back its value. */
async function stepped<T>(
  onStep: CodegenStep,
  id: string,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  const out: T[] = [];
  await onStep(id, label, async () => {
    out.push(await run());
  });
  if (out.length !== 1) {
    throw new Error(
      `onStep("${id}") ran its step ${out.length} times, not once.`,
    );
  }
  return out[0]!;
}

/**
 * The host's own generated files as they render over an EMPTY graph, by
 * repo-relative path: what the derivation measures in place of the files on
 * disk. Those are this generator's previous output — the entry imports its
 * graph file — and a stale one (naming a server barrel since moved or
 * deleted) would otherwise fail the very closure that regenerates it, so the
 * build could never repair it. The empty render loses nothing: both files
 * load their graph only through dynamic imports (`loader`, `start`), which a
 * bundled closure cuts, so their static imports do not depend on the graph.
 */
function ownOutputs(host: BrowserHostDecl): ReadonlyMap<string, string> {
  return new Map([
    [host.generated, renderHostGraphFile("", [], {})],
    [
      host.scopeGenerated,
      renderBrowserHostScope(host, {
        composition: "",
        home: null,
        unlisted: [],
        webPlugins: [],
        negatedWebPlugins: [],
        reads: [],
        externalHosts: [],
      }),
    ],
  ]);
}

/**
 * The union closure of `entries` as a bundler measures it (dynamic imports
 * cut, unused TypeScript imports dropped), from the plugin-records module
 * graph — its file facts are records, so a build reads only changed modules.
 * `written` overlays files whose content is not the file set's. Every module
 * is a member of the file set: an import resolving to none throws, naming it.
 */
async function bundledClosureOf(
  repo: RepoFiles,
  entries: readonly string[],
  written: ReadonlyMap<string, string>,
): Promise<BundledClosure> {
  const graph = await buildModuleGraph(
    {
      snapshot: repo,
      written,
      store: currentRecordStore(),
      readOutside: NO_OUTSIDE_FILES,
    },
    entries,
  );
  const closure = graph.bundledClosure(entries);
  for (const m of closure.modules) {
    const unresolved = graph.modules.get(m)!.unresolved;
    if (unresolved.length > 0)
      throw new Error(
        `${m} imports ${unresolved.map((u) => JSON.stringify(u)).join(", ")}, which resolves to no file of the checkout: a browser host's closure is measured over the file set.`,
      );
  }
  return closure;
}
