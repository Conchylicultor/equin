import { sharedWorkOver } from "@plugins/packages/plugins/shared-work/core";
// A browser host's PAGE scope — the web plugins of the composition its worker
// boots (`bundle ∩ web barrels`), the scope a page renders the host's subtree
// in (`<PluginScope>`) — and what a composition bundling the host's declaring
// plugin carries of it: those of its web plugins the composition does not
// bundle itself, on demand (the web registry's `scopedEntries`), never its
// server, machine or central halves (the worker's). The cheap half of the
// host's derivation (`browser-host-gen.ts`'s `inferBrowserHostGraph` builds on
// it): resolving one composition and filtering it, no import closure.

import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  asFsPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  flattenManifest,
  resolveComposition,
  type Composition,
} from "@plugins/plugin-meta/plugins/closure/core";
import {
  manifestItemToManifest,
  type CompositionManifestItem,
} from "@plugins/plugin-meta/plugins/composition/core";
import { readCompositionManifestsFromDisk } from "./main-bundle";
import type { RegistryGenContext } from "./plugin-registry-gen";

const DECLARATION_RE =
  /^plugins\/((?:[^/]+\/plugins\/)*[^/]+)\/bin\/browser-host\.composition\.ts$/;

/** One host: the plugin declaring it, its entry, and its generated file. */
export interface BrowserHostDecl {
  /** The declaring plugin's path (`apps/plugins/website/plugins/demos/plugins/workspace`). */
  pluginPath: string;
  /** Repo-relative `bin/browser-host.composition.ts`. */
  declaration: string;
  /** Repo-relative `bin/browser-host.ts` — the worker's entry. */
  entry: string;
  /**
   * Repo-relative `bin/browser-host.snapshot.ts` — the script the build takes
   * the host's starting snapshot with (web-artifacts' `host-snapshots.ts`).
   * Its server barrels are roots too: it seeds the same graph the worker boots.
   */
  snapshotEntry: string;
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
      snapshotEntry: path.replace(/\.composition\.ts$/, ".snapshot.ts"),
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

/** A host's composition, resolved, and the page scope it gives. */
export interface BrowserHostScope {
  /** Who the scope is for, in errors (`<declaration> (composition "<name>")`). */
  label: string;
  composition: string;
  /** The composition's manifest row (its `home`, `unlisted`). */
  row: CompositionManifestItem;
  /** The composition resolved under its own declared hosts. */
  resolved: Composition;
  /** The composition's web plugins (bundle ∩ web barrels), sorted: the scope. */
  webPlugins: PluginId[];
  /** The web plugins its negatives name directly, sorted. */
  negatedWebPlugins: PluginId[];
}

/**
 * `host`'s page scope. Throws when its composition is missing, is not declared
 * for the browser, or contradicts its own manifest. Memoized on `ctx` beside
 * the host's derivation (`RegistryGenContext.browserHostGraphs`).
 */
export function resolveHostScope(
  ctx: RegistryGenContext,
  host: BrowserHostDecl,
): Promise<BrowserHostScope> {
  let memo = ctx.browserHostGraphs.get(host.declaration);
  if (memo === undefined) {
    memo = {};
    ctx.browserHostGraphs.set(host.declaration, memo);
  }
  return (memo.scope ??= sharedWorkOver(ctx, "registry codegen context", () =>
    resolveScopeUncached(ctx, host),
  ));
}

async function resolveScopeUncached(
  ctx: RegistryGenContext,
  host: BrowserHostDecl,
): Promise<BrowserHostScope> {
  const repo = await ctx.repo();
  const composition = await declaredComposition(repo, host);
  const label = `${host.declaration} (composition "${composition}")`;
  const manifests = readCompositionManifestsFromDisk(ctx.root);
  const row = manifests.find((m) => m.id === composition);
  if (row === undefined) {
    throw new Error(
      `${label}: no composition "${composition}" in the manifests (plugins/plugin-meta/plugins/composition/core/config.ts).`,
    );
  }
  const manifest = manifestItemToManifest(row);
  // The composition says where it runs; a browser host only checks it says
  // so. Resolved under its own declaration — never a host passed from here —
  // so its closure follows no `machine/` or `central/` import.
  if (!manifest.hosts.includes("browser")) {
    throw new Error(
      `${label}: the composition is declared for ${manifest.hosts.join(", ")}, not for the browser — a browser host serves only a composition whose \`hosts\` include "browser" (plugins/plugin-meta/plugins/composition/core/config.ts).`,
    );
  }
  const resolved = resolveComposition(
    ctx.graph,
    flattenManifest(manifest, manifests.map(manifestItemToManifest)),
  );
  if (resolved.unsatisfiedExclusions.length > 0) {
    throw new Error(
      `${label}: the composition contradicts its own manifest — ${resolved.unsatisfiedExclusions.map((u) => u.target).join(", ")} still bundled despite a negative.`,
    );
  }
  const hasWeb = (id: PluginId) =>
    repo.has(`plugins/${asFsPath(id)}/web/index.ts`);
  return {
    label,
    composition,
    row,
    resolved,
    webPlugins: [...resolved.bundle].filter(hasWeb).sort(),
    negatedWebPlugins: [...resolved.negatedTargets].filter(hasWeb).sort(),
  };
}

/**
 * The web plugins a composition whose bundle is `bundle` carries ON DEMAND:
 * the page scope of every browser host a bundled plugin declares, minus what
 * the bundle holds itself — sorted. The composition's web registry lists them
 * apart (`scopedEntries`): loaded when a scope asks for them, visible inside
 * that scope only, and their other halves never in the composition's backend
 * (the host's worker serves them). Empty for a composition that bundles no
 * host's declaring plugin, or that bundles its whole scope (main).
 */
export async function scopedOnlyWebPlugins(
  ctx: RegistryGenContext,
  bundle: ReadonlySet<string>,
): Promise<PluginId[]> {
  const bundledPaths = new Set(
    [...bundle].map((id) => asFsPath(id as PluginId)),
  );
  const scoped = new Set<PluginId>();
  for (const host of discoverBrowserHosts(await ctx.repo())) {
    if (!bundledPaths.has(host.pluginPath)) continue;
    for (const id of (await resolveHostScope(ctx, host)).webPlugins) {
      if (!bundle.has(id)) scoped.add(id);
    }
  }
  return [...scoped].sort();
}
