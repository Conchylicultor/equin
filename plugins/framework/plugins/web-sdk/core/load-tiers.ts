// Load-tier partition — the pure function that splits the web plugin registry
// into the **eager substrate** (chrome, providers, boot tasks, every app's
// shell) and the **deferred app content** loaded after first paint.
//
// The whole point (see
// research/2026-07-02-cold-deeplink-boot-saturation-deferred-loading.md): the
// boot effect used to `loadPlugins(webEntries)` over all ~643 chunks before it
// could paint or even construct the notifications socket — ~8s of route-
// independent main-thread saturation. Deferring app *content* (which only ever
// renders inside its own app surface) shrinks the eager set to what the chrome
// actually needs, so the socket + first paint land seconds sooner.
//
// The tiers are DERIVED, not hand-listed. `web-tiers.generated.ts` (produced by
// `codegen/core/eager-tier-gen.ts`) is the committed source of truth: a plugin
// is EAGER iff it is non-app-content / a shell subtree (structural), calls a
// watched boot slot (Core.Root / Core.Boot / Apps.App / ActionBar.Item / Shell.Sidebar), owns a
// preloaded resource descriptor, or is pulled in by the transitive dependsOn
// closure of any of those. Every app is deferrable by default; the historical
// hand-maintained allowlists (DEFERRABLE_APPS / EAGER_EXCEPTIONS) are gone.
//
// Fail-safe direction: the generated artifact is the DEFERRED set, so an unknown
// path is treated as EAGER — a modeling gap only makes a plugin needlessly eager
// (slower boot), never wrongly deferred. The `eager-tier-in-sync` check fails on
// drift, and a preloaded descriptor whose owner has no web entry fails
// generation outright (the reachability guard). The rule stays a pure function of
// `pluginPath` — trivially unit-testable (see load-tiers.test.ts) and leaving the
// concatenated `webEntries` as the single source of truth (the partition is
// derived, so `--composition` builds and the plugin-load smoke test are unaffected).

import { DEFERRED_PLUGIN_PATHS } from "./web-tiers.generated";

/**
 * True IFF `pluginPath` is deferred app content — a membership lookup against the
 * generated {@link DEFERRED_PLUGIN_PATHS} set. Everything not in the set (an
 * unknown or newly-added path included) is eager, the fail-safe direction.
 */
export function isDeferredPluginPath(pluginPath: string): boolean {
  return DEFERRED_PLUGIN_PATHS.has(pluginPath);
}

/**
 * Split registry entries into `{ eager, deferred }` by {@link isDeferredPluginPath}.
 * Order-preserving within each tier and total (every input lands in exactly one
 * tier), so the concatenation source of truth is fully reconstructable.
 */
export function partitionWebEntries<T extends { pluginPath: string }>(
  entries: T[],
): { eager: T[]; deferred: T[] } {
  const eager: T[] = [];
  const deferred: T[] = [];
  for (const e of entries) {
    if (isDeferredPluginPath(e.pluginPath)) deferred.push(e);
    else eager.push(e);
  }
  return { eager, deferred };
}

/**
 * Plan the deferred tier's registration: the active app's content first (its
 * `priority` batch), then the `rest` drained in batches of `batchSize`, each
 * batch one `registry.append`.
 *
 * The invariant: **a plugin never registers before a plugin it depends on**
 * (its `dependsOn`, the codegen-derived import graph). A plugin that reads
 * something another plugin registers — a `useConfig(descriptor)` whose
 * `ConfigV2.WebRegister` lives in the descriptor's own plugin, a slot another
 * plugin declares — imports it, so it depends on that plugin; registering it
 * earlier mounts its contributions against a registry still missing the
 * registration (Sonata's audio engine reading the look config before
 * `apps.sonata.look` registered, report-1795199408-r8vxjo, when the page
 * reached /sonata mid-drain). Importing the dependency's module is not enough:
 * its contributions register only when its own entry's batch appends.
 *
 * So the plan is dependency-closed by construction:
 *  - `priority` is the entries under `activePrefix` plus every deferred entry
 *    they transitively depend on (another app's content they import included);
 *  - `rest` is topo-ordered (dependencies first, input order otherwise kept),
 *    so slicing it puts each entry's deferred dependencies in its own batch or
 *    an earlier one.
 * Dependencies outside `deferred` (the eager tier, registered first) are not
 * followed. The import graph is a DAG (boundary checks); a cycle throws.
 */
export function planDeferredLoad<
  T extends { pluginPath: string; dependsOn: readonly string[] },
>(
  deferred: readonly T[],
  activePrefix: string | null,
  batchSize: number,
): { priority: T[]; rest: T[][] } {
  const byPath = new Map(deferred.map((e) => [e.pluginPath, e] as const));
  const ordered: T[] = [];
  const placed = new Set<string>();
  const stack = new Set<string>();
  const visit = (e: T, trail: readonly string[]): void => {
    if (placed.has(e.pluginPath)) return;
    if (stack.has(e.pluginPath)) {
      throw new Error(
        `[plugins] deferred dependsOn cycle: ${[...trail, e.pluginPath].join(" → ")}`,
      );
    }
    stack.add(e.pluginPath);
    for (const d of e.dependsOn) {
      const dep = byPath.get(d);
      if (dep) visit(dep, [...trail, e.pluginPath]);
    }
    stack.delete(e.pluginPath);
    placed.add(e.pluginPath);
    ordered.push(e);
  };
  if (activePrefix !== null) {
    for (const e of deferred)
      if (e.pluginPath.startsWith(activePrefix)) visit(e, []);
  }
  const priority = [...ordered];
  for (const e of deferred) visit(e, []);
  const tail = ordered.slice(priority.length);
  const rest: T[][] = [];
  for (let i = 0; i < tail.length; i += batchSize)
    rest.push(tail.slice(i, i + batchSize));
  return { priority, rest };
}
