import { sharedWork } from "@plugins/packages/plugins/shared-work/core";
import {
  buildPluginTree,
  type PluginNode,
  type PluginTree,
} from "./plugin-tree";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";

const structureTreeCache = new Map<string, Promise<PluginTree>>();

/**
 * The STRUCTURE-ONLY plugin tree (`buildPluginTree`: the walk,
 * each barrel's description/flags, the hierarchy — no facets, no barrels
 * imported), built once per `pluginsRoot` for the life of the process and
 * handed to every caller as the SAME frozen value.
 *
 * WHO IT IS FOR. One-shot processes that ask the same question many times —
 * above all a check pass, where ~100 checks share one JS thread and six of them
 * used to rebuild this tree each, back to back. The structure is a pure function
 * of the checkout's plugin folders and barrel headers, which nothing in such a
 * process writes, so one build answers them all.
 *
 * WHO IT IS NOT FOR. A long-lived server: the memo never invalidates, so a
 * plugin added after the first call is never seen. A backend reads
 * `getStructureTreeCached` from this plugin's `server` barrel, which rebuilds on
 * a filesystem watcher. The codegen trees (`buildBarrelFreeTree` /
 * `buildEnrichedTree`) are its facet-carrying twins, cached the same way.
 *
 * FROZEN, because it is shared: a check that sorted `roots` or deleted from
 * `byDir` would silently change what every later check reads, in whatever order
 * the run happened to schedule them. Nodes, their records and arrays are
 * `Object.freeze`d (a write throws — modules are strict), and the two maps'
 * mutators throw. A caller that needs a different shape builds its own from it.
 *
 * `repo`: the pass's file set (a check run's `ctx.repo()`, a build's
 * snapshot); the first call's builds the tree.
 *
 * Check code must come through here (or a codegen memo), never call
 * `buildPluginTree` itself — enforced by the `plugin-tree/no-uncached-tree-in-checks`
 * lint rule.
 */
export function buildStructureTreeOnce(
  pluginsRoot: AppPath,
  repo: RepoFiles,
): Promise<PluginTree> {
  let cached = structureTreeCache.get(pluginsRoot);
  if (!cached) {
    // Shared: built for every caller of the pass, so its file calls are
    // nobody's own (`sharedWork`).
    cached = sharedWork("plugin tree", () =>
      buildPluginTree(pluginsRoot, { repo }),
    ).then(freezePluginTree);
    structureTreeCache.set(pluginsRoot, cached);
  }
  return cached;
}

function freezeMap<K, V>(map: Map<K, V>, name: string): void {
  const refuse = (): never => {
    throw new TypeError(
      `plugin-tree: ${name} of a shared structure tree is read-only — ` +
        `buildStructureTreeOnce hands every caller the same tree. Copy it first.`,
    );
  };
  Object.defineProperties(map, {
    set: { value: refuse },
    delete: { value: refuse },
    clear: { value: refuse },
  });
  Object.freeze(map);
}

function freezeNode(node: PluginNode): void {
  if (Object.isFrozen(node)) return;
  Object.freeze(node.descriptions);
  Object.freeze(node.runtimes);
  Object.freeze(node.facets);
  for (const child of node.children) freezeNode(child);
  Object.freeze(node.children);
  Object.freeze(node);
}

/** Exported for its test only. */
export function freezePluginTree(tree: PluginTree): PluginTree {
  for (const node of tree.byDir.values()) freezeNode(node);
  Object.freeze(tree.roots);
  Object.freeze(tree.facets);
  freezeMap(tree.byDir, "byDir");
  freezeMap(tree.byPath, "byPath");
  return Object.freeze(tree);
}
