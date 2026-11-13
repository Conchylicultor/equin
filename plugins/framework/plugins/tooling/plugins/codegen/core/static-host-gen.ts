// A static host's plugin graphs, generated: for every composition declared
// `crawlable: true`, the portable server graph a build-time process boots
// in-process (`server-core`'s `bootBrowserHost`, on PGlite) and the web
// plugins it renders the composition's pages with — the crawlable website's
// static snapshot (web-artifacts' crawl-snapshot stage).
//
// The take is ONE script in the repo, `plugins/<p>/bin/static-host.ts`
// (discovered by that name; two is an error). Its graphs are written beside
// it, as `bin/static-host.generated.ts` (`staticHosts`, keyed by composition),
// committed, and held to this render by `plugins-registry-in-sync`.
//
// Each graph is inferred exactly as a browser host's (`browser-host-gen.ts`'s
// `resolveHostGraph`): the composition's portable server barrels, the portable
// barrels the take itself loads, one portable host provider per declared host
// service to a fixpoint — and, unlike a browser host, every portable barrel
// that code loads (a provider's own dependencies: there is no page scope to
// keep the graph to) — and the guard that it loads no non-portable one. A crawlable composition need not be declared for the
// `browser` host: it is served by the desktop, and only its snapshot is taken
// on a host without the computer. Every loader is a static `import()` thunk,
// so the snapshot's address (the take's module graph) covers every barrel the
// take can boot or render.

import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  asFsPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  flattenManifest,
  resolveComposition,
} from "@plugins/plugin-meta/plugins/closure/core";
import { manifestItemToManifest } from "@plugins/plugin-meta/plugins/composition/core";
import { serverPortabilityOf } from "@plugins/framework/plugins/tooling/plugins/boundaries/core";
import {
  bundledClosureOf,
  hostEntryLiteral,
  hostServiceDeclarationsOf,
  resolveHostGraph,
} from "./browser-host-gen";
import { discoverStaticHostTake } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/core";
import { hostProviderServerBarrels } from "./host-services";
import { readCompositionManifestsFromDisk } from "./main-bundle";
import {
  resolveRegistryHome,
  resolveRegistryUnlisted,
  scanCollectedDir,
  type RegistryGenContext,
} from "./plugin-registry-gen";
import type { CodegenStep } from "./regen-pipeline";
import { writeGenerated } from "./write-generated";

/** The one static-host take: the plugin holding it, its script and its generated graphs. */
export interface StaticHostDecl {
  pluginPath: string;
  /** Repo-relative `bin/static-host.ts`. */
  entry: string;
  /** Repo-relative `bin/static-host.generated.ts`. */
  generated: string;
}

/**
 * The repo's static-host take (web-artifacts' discovery: the crawl stage runs
 * the same script), or null when it has none; two throw.
 */
export function discoverStaticHost(
  files: Iterable<string>,
): StaticHostDecl | null {
  const take = discoverStaticHostTake(files);
  return take === null
    ? null
    : { ...take, generated: take.entry.replace(/\.ts$/, ".generated.ts") };
}

/** One crawlable composition's static-host graph. */
export interface StaticHostGraph {
  composition: string;
  home: string | null;
  unlisted: readonly string[];
  /** The composition's plugins with a `web/index.ts`, by path, sorted. */
  webPlugins: string[];
  /** Every server plugin the take boots, by path, sorted. */
  members: string[];
  /** Service id → the plugin path providing it. */
  providers: Record<string, string>;
}

/** Every crawlable composition's graph, sorted by composition. */
export async function deriveStaticHostGraphs(
  ctx: RegistryGenContext,
  host: StaticHostDecl,
): Promise<StaticHostGraph[]> {
  const repo = await ctx.repo();
  const manifests = readCompositionManifestsFromDisk(ctx.root);
  const all = manifests.map(manifestItemToManifest);
  const own = new Map([[host.generated, renderStaticHosts([], new Map())]]);
  const graphs: StaticHostGraph[] = [];
  for (const row of manifests
    .filter((m) => m.crawlable)
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const label = `${host.entry} (crawlable composition "${row.name}")`;
    const resolved = resolveComposition(
      ctx.graph,
      flattenManifest(manifestItemToManifest(row), all),
    );
    const barrelOf = (id: PluginId) =>
      `plugins/${asFsPath(id)}/server/index.ts`;
    const graph = await resolveHostGraph({
      label,
      entry: host.entry,
      bundleBarrels: [...resolved.bundle]
        .map(barrelOf)
        .filter((b) => repo.has(b))
        .sort(),
      candidateBarrels: hostProviderServerBarrels(ctx.graph),
      admitReached: true,
      read: async (path) => own.get(path) ?? (await repo.read(path)),
      declarations: hostServiceDeclarationsOf(repo, own),
      portability: await serverPortabilityOf(repo),
      closure: (entries) => bundledClosureOf(repo, entries, own),
    });
    graphs.push({
      composition: row.name,
      home: resolveRegistryHome(
        ctx.declaredApps,
        resolved.bundle,
        row.name,
        row.home,
      ),
      unlisted: resolveRegistryUnlisted(
        ctx.declaredApps,
        resolved.bundle,
        row.name,
        row.unlisted,
        row.home,
      ),
      webPlugins: [...resolved.bundle]
        .map((id) => asFsPath(id))
        .filter((p) => repo.has(`plugins/${p}/web/index.ts`))
        .sort(),
      members: graph.members,
      providers: graph.providers,
    });
  }
  return graphs;
}

/** The generated file's text, from the graphs and the server registry's edges. */
export function renderStaticHosts(
  graphs: readonly StaticHostGraph[],
  deps: ReadonlyMap<string, readonly string[]>,
): string {
  const lines = [
    "// DO NOT EDIT — autogenerated by `./equin build`",
    "// (see plugins/framework/plugins/tooling/plugins/codegen/core/static-host-gen.ts).",
    "//",
    "// Per crawlable composition: the portable server graph `./static-host.ts` boots",
    "// in-process and the web plugins it renders the composition's pages with. The",
    "// `plugins-registry-in-sync` check fails on drift.",
    "",
    'import type { ServerRegistryEntry } from "@plugins/framework/plugins/server-core/core";',
    'import type { CompositionIdentity } from "@plugins/framework/plugins/web-sdk/core";',
    "",
    "export interface StaticHost {",
    "  composition: CompositionIdentity;",
    "  /** The composition's web plugins, by plugin path. */",
    "  webPlugins: readonly string[];",
    "  hostEntries: ServerRegistryEntry[];",
    "  /** Host service id → the plugin providing it in this graph. */",
    "  hostProviders: Record<string, string>;",
    "}",
    "",
    "export const staticHosts: Record<string, StaticHost> = {",
  ];
  for (const g of graphs) {
    const members = new Set(g.members);
    lines.push(
      `  ${JSON.stringify(g.composition)}: {`,
      `    composition: { id: ${JSON.stringify(g.composition)}, home: ${JSON.stringify(g.home)}${g.unlisted.length > 0 ? `, unlisted: ${JSON.stringify(g.unlisted)}` : ""} },`,
      "    webPlugins: [",
      ...g.webPlugins.map((p) => `      ${JSON.stringify(p)},`),
      "    ],",
      "    hostEntries: [",
      ...g.members.map(
        (pluginPath) =>
          `      ${hostEntryLiteral({
            pluginPath,
            dependsOn: (deps.get(pluginPath) ?? []).filter((d) =>
              members.has(d),
            ),
          })},`,
      ),
      "    ],",
      "    hostProviders: {",
      ...Object.entries(g.providers).map(
        ([id, p]) => `      ${JSON.stringify(id)}: ${JSON.stringify(p)},`,
      ),
      "    },",
      "  },",
    );
  }
  lines.push("};", "");
  return lines.join("\n");
}

/** The file the repo's static host should hold, or null when it has no take. */
export async function renderStaticHostFile(
  ctx: RegistryGenContext,
): Promise<{ host: StaticHostDecl; content: string } | null> {
  const host = discoverStaticHost((await ctx.repo()).all());
  if (host === null) return null;
  const graphs = await deriveStaticHostGraphs(ctx, host);
  const { deps } = await scanCollectedDir(ctx, "server");
  return { host, content: renderStaticHosts(graphs, deps) };
}

/** Write the static host's graphs; one summary line per crawlable composition. */
export async function generateStaticHosts(
  ctx: RegistryGenContext,
  onStep: CodegenStep,
): Promise<void> {
  await onStep("staticHosts", "static host graphs", async () => {
    const rendered = await renderStaticHostFile(ctx);
    if (rendered === null) return;
    await writeGenerated({
      file: joinAppPath(ctx.root, rendered.host.generated),
      content: rendered.content,
    });
  });
}
