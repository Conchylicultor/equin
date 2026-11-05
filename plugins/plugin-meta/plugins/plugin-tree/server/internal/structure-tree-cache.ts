import {
  buildPluginTree,
  type PluginTree,
  type PluginTreeData,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import { appPathParent } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { createGitStateMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/server";
import { createTreeChangeSignal } from "./tree-change-signal";
import { FacetedTreeSource } from "./faceted-source";

// Cached, watcher-invalidated plugin-tree accessors: the structure tree built
// here, the faceted tree read as data from a child (`getFacetsTreeCached`).
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

// Full faceted tree, shared by the facet consumers (Studio's composition graph,
// the plugin detail pane, the deploy-secrets gate). Barrel-free, as data.
const facetsMemo = createGitStateMemo<PluginTreeData>({
  name: "plugin-tree.facets",
});

// How many file reads the structure build holds open at once. A backend's fs
// pool also serves its requests, and the build hands it every plugin's barrels
// at once (thousands of reads): at the file set's default width (64, over a
// pool of ~18 threads) every other fs call of the process queued behind it
// (fs-wait on main, 2026-11-04: ~100 ms per read, all queue time). Narrow, so
// the pool keeps threads for the request path; a background build takes a
// little longer instead.
const TREE_READ_CONCURRENCY = 8;

export async function getStructureTreeCached(): Promise<PluginTree> {
  await ensureWatcher();
  return structureMemo.get(
    PLUGINS_DIR,
    () => Promise.resolve(treeChange.token()),
    () =>
      withHeavyReadSlot(async () =>
        buildPluginTree(PLUGINS_DIR, {
          repo: await loadRepoFiles(appPathParent(PLUGINS_DIR), {
            readConcurrency: TREE_READ_CONCURRENCY,
          }),
        }),
      ),
  );
}

/**
 * The faceted tree, as data: what the facet extractors made of every plugin,
 * with no extractor in this process.
 *
 * Building it runs every facet extractor — build tooling, which reaches the
 * parsers, codegen and lint, and loads the extractors by a computed path. A
 * serving backend must not run that: the code it runs could no longer be
 * measured (`boot:closure-digestable`, research/
 * 2026-11-05-global-backend-code-identity.md), and the build is seconds of CPU
 * on the event loop. So the tree comes from the `FacetedTreeSource` host
 * service — on the desktop, `./equin plugin-tree-facets` run in a child
 * (`plugin-tree#machine`) — memoized on the same watcher generation as the
 * structure tree.
 */
export async function getFacetsTreeCached(): Promise<PluginTreeData> {
  await ensureWatcher();
  return facetsMemo.get(
    PLUGINS_DIR,
    () => Promise.resolve(treeChange.token()),
    () => withHeavyReadSlot(() => FacetedTreeSource.get().read()),
  );
}
