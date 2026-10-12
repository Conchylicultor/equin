import {
  buildPluginTree,
  type PluginTree,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { createGitStateMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/server";
import { createTreeChangeSignal } from "./tree-change-signal";

// Cached, watcher-invalidated plugin-tree accessors.
//
// The hot path (the `plugin-view.tree` live value: chip mounts, Settings config-nav)
// only ever wants the cheap structural skeleton — never facets — so it is served
// structure-only and cached here. Caching is legitimate: it coalesces necessary,
// cheap structural work, not the eliminated facet walk.
//
// Invalidation is a single monotonic generation (`treeChange`), bumped by ONE
// lazy @parcel watcher on `PLUGINS_DIR`: any plugin add / remove / edit fires an
// event → the generation moves → the memo signature moves → the next `get`
// rebuilds. Between changes every call is a pure cache hit doing zero fs work.
// The same bump is exported as a change signal (`onPluginTreeChanged`, plus
// `pluginTreeGeneration` as a `revalidate` ETag) for live values over the tree.
//
// The watcher is armed BEFORE any tree is built (every accessor awaits it): a
// tree handed out before the watcher was listening could miss the change that
// made it stale, and nothing would ever move the generation for it.
//
// The memo's embedded single-flight coalesces the post-boot subscribe herd (every
// live-state resource re-subscribing at once) onto ONE build — the many concurrent
// callers share the single in-flight compute instead of each walking the tree.

/** The one lazy watcher over `PLUGINS_DIR`, opened by the first tree read. */
export const pluginsDirWatcher = defineFileWatcher({
  name: "plugin-tree.plugins-dir",
  description:
    "Watches the plugins folder so the next plugin-tree read rebuilds after a plugin is added, removed or edited.",
  ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**"],
});

const treeChange = createTreeChangeSignal();
let watcherStarted: Promise<FileWatcher> | null = null;

async function ensureWatcher(): Promise<void> {
  watcherStarted ??= pluginsDirWatcher.start({
    dirs: [PLUGINS_DIR],
    onChange: (events) => {
      if (events.length > 0) treeChange.bump();
    },
  });
  const starting = watcherStarted;
  try {
    await starting;
  } catch (err) {
    // Not cached: the next read tries to arm it again instead of failing
    // forever. Only this attempt is forgotten — never a newer one.
    if (watcherStarted === starting) watcherStarted = null;
    throw err;
  }
}

/**
 * Hear every change the plugins-dir watcher sees (a plugin added, removed or
 * any file under `plugins/` edited). Returns the unsubscribe.
 *
 * Registering does not arm the watcher — the first tree read (or
 * {@link pluginTreeGeneration}) does, and it is armed before that read builds
 * anything. So a process that never handed out a tree hears nothing, and has
 * nothing that could be stale. Listeners run synchronously on the watcher's
 * batch: keep them cheap (a `notify`), and expect one call per batch, not per
 * file.
 */
export function onPluginTreeChanged(listener: () => void): () => void {
  return treeChange.on(listener);
}

/**
 * The tree's current generation as an opaque token — a `revalidate` ETag for a
 * value derived from the tree: equal tokens mean the watcher saw no change in
 * between, and tokens from two processes never match. Arms the watcher first,
 * so a token is never minted for a tree nothing is watching.
 */
export async function pluginTreeGeneration(): Promise<string> {
  await ensureWatcher();
  return treeChange.token();
}

// Structure-only tree (facets OFF) — the hot path.
const structureMemo = createGitStateMemo<PluginTree>({
  name: "plugin-tree.structure",
});

// Full faceted tree, shared by the two genuine facet consumers (Contributions +
// the detail pane). `skipBarrelImport: true` mirrors the previous hot-path build.
const facetsMemo = createGitStateMemo<PluginTree>({
  name: "plugin-tree.facets",
});

export async function getStructureTreeCached(): Promise<PluginTree> {
  await ensureWatcher();
  return structureMemo.get(
    PLUGINS_DIR,
    () => Promise.resolve(treeChange.token()),
    () => withHeavyReadSlot(() => buildPluginTree(PLUGINS_DIR)),
  );
}

export async function getFacetsTreeCached(): Promise<PluginTree> {
  await ensureWatcher();
  return facetsMemo.get(
    PLUGINS_DIR,
    () => Promise.resolve(treeChange.token()),
    () =>
      withHeavyReadSlot(() =>
        buildPluginTree(PLUGINS_DIR, { skipBarrelImport: true, facets: true }),
      ),
  );
}
