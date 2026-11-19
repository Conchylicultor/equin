import type { LoadedPlugin, PluginDefinition } from "./types";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { loadAcrossReachLoss } from "./page-reach";

export interface PluginEntry {
  pluginPath: string;
  id?: string;
  loader: () => Promise<{ default: unknown }>;
}

export interface PluginLoadError {
  pluginPath: string;
  error: unknown;
}

export async function loadPlugins(
  entries: PluginEntry[],
): Promise<{ plugins: LoadedPlugin[]; errors: PluginLoadError[] }> {
  // ── Why flat concurrent import is safe HERE (unlike server/central) ──
  // The server and central loaders (`server-core/bin/index.ts`,
  // `central-core/bin/index.ts`) load in dependency-ordered `dependsOn` waves,
  // warming each wave's `core` barrels before its runtime barrels. This loader
  // deliberately does NOT — a single flat `Promise.allSettled` over every entry
  // — and that is correct, because the class of bug the waves close is
  // Bun-loader-specific and structurally absent on the web runtime:
  //   • In the BROWSER (native ESM via the artifact-mode import map), module
  //     evaluation follows the spec's single-module-map, depth-first ordering
  //     with the async-module evaluation-promise machinery — a dependency is
  //     fully evaluated before a dependent's body runs, EVEN with top-level
  //     await. So the concurrent-load ordering race (a dependent observing a
  //     dependency barrel's not-yet-initialized `const` exports as a TDZ
  //     `ReferenceError`) cannot occur here. Bun's loader violates that ordering
  //     under concurrent `import()`; the browser does not.
  //   • A release bundle is the same import-map artifact fleet (its dist is
  //     composed by the same pipeline, just with real copies instead of store
  //     symlinks), so the browser argument above covers it unchanged.
  // The claim is scoped to the concurrent-load ordering class only — NOT genuine
  // import cycles (a different class the boundary checker confirms doesn't
  // exist). Do NOT reorder this into waves: it would be dead complexity fighting
  // the deliberate deferred-batch boot-perf design, buying nothing. If this ever
  // regressed, `plugin-render.test.tsx` (a load-only canary that loads every web
  // plugin) would fail loudly.
  // A chunk the browser dropped while the page was hidden, offline or leaving
  // is loaded again once the page is back, not failed (`page-reach.ts`).
  const results = await Promise.allSettled(
    entries.map((e) => loadAcrossReachLoss(e.loader)),
  );
  const plugins: LoadedPlugin[] = [];
  const errors: PluginLoadError[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const entry = entries[i]!;
    if (result.status === "fulfilled") {
      // `id` is derived from the unique hierarchy path, never authored. The
      // duplicate guard is structurally unreachable (directory paths can't
      // collide) but fails loud if codegen ever regresses, rather than letting
      // one plugin silently drop the other during topo sort.
      const id = asPluginId(entry.id!);
      if (seenIds.has(id)) {
        throw new Error(
          `[plugin] duplicate derived plugin id "${id}" (${entry.pluginPath}) — two plugins resolve to the same hierarchy path`,
        );
      }
      seenIds.add(id);
      const plugin = result.value.default as PluginDefinition as LoadedPlugin;
      plugin.id = id;
      plugins.push(plugin);
    } else {
      console.error(
        `[plugin.${entry.pluginPath}] failed to load`,
        result.reason,
      );
      errors.push({ pluginPath: entry.pluginPath, error: result.reason });
    }
  }
  return { plugins, errors };
}
