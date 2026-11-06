import {
  createStructureIndex,
  type PluginTreeData,
  type StructureIndex,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  listAllRepoMembers,
  listRepoMembers,
  repoFileReader,
} from "@plugins/framework/plugins/tooling/core";
import { appPathParent } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import {
  defineFileWatcher,
  type FileChangeEvent,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/server";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createTreeChangeSignal } from "./tree-change-signal";
import {
  FacetedSessionEnded,
  FacetedTreeSource,
  type FacetedTreeSession,
} from "./faceted-source";

// Watcher-kept plugin-tree accessors: the structure tree, kept up to date here
// by what changed, and the faceted tree, kept up to date by what changed in a
// worker (`getFacetsTreeCached`).
//
// ONE lazy @parcel watcher on `PLUGINS_DIR` feeds two signals:
//
// - `facetsChange` — the FACETED tree changed. The watcher hands each batch's
//   paths to the faceted session (`FacetedTreeSource`), which re-keys only the
//   plugins owning them and re-extracts only the records whose key moved; the
//   signal moves only when the tree it hands back differs — an edit the facets
//   do not see (a function body, a test) moves nothing
//   (`onPluginFacetsChanged`, `pluginFacetsGeneration`).
// - `structureChange` — the STRUCTURE tree changed. The structure tree (the
//   `plugin-view.tree` hot path: chip mounts, Settings config-nav) is a
//   function of which plugin folders hold files and of each plugin's key files
//   only, so it is a `StructureIndex` (core): the watcher hands it the changed
//   paths, it re-asks git about those paths only and re-reads the key files of
//   the plugins they touch — O(changes). An edit to an ordinary source file
//   costs one scoped `git ls-files` and moves nothing
//   (`onPluginStructureChanged`, `pluginStructureGeneration`).
//
// Only the first read builds cold (the whole plugins root listed and every key
// file read, in the heavy-read slot). After that the index is dropped and
// rebuilt cold only when the watcher may have lost events (`onLost`), when a
// batch is too large to be worth scoping (a checkout / rebase), or when a
// refresh failed.
//
// The watcher is armed BEFORE any tree is built (every accessor awaits it): a
// tree handed out before the watcher was listening could miss the change that
// made it stale, and nothing would ever move the generation for it.

/** The one lazy watcher over `PLUGINS_DIR`, opened by the first tree read. */
export const pluginsDirWatcher = defineFileWatcher({
  name: "plugin-tree.plugins-dir",
  description:
    "Watches the plugins folder so the plugin trees follow a plugin added, removed or edited — the structure tree by re-reading only what changed.",
  // An optimisation only: membership is git's (`listRepoMembers`), so an
  // ignored file the watcher reports is dropped there. Never `**/build/**` —
  // `plugins/build` is a plugin, and its edits went unheard behind that glob.
  ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**"],
});

const facetsChange = createTreeChangeSignal();
const structureChange = createTreeChangeSignal();
let watcherStarted: Promise<FileWatcher> | null = null;

async function ensureWatcher(): Promise<void> {
  watcherStarted ??= pluginsDirWatcher.start({
    dirs: [PLUGINS_DIR],
    onChange: (events) => {
      if (events.length === 0) return;
      // Its own queue: a facets refresh never holds up the structure's.
      if (facets !== null) facetsRefresh.trigger(events);
      return refreshStructure(events);
    },
    onLost: () => {
      // Events may be gone: nothing either index holds can be trusted.
      dropIndex();
      dropFacets();
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
 * Hear every change of the FACETED tree ({@link getFacetsTreeCached}): an edit
 * under `plugins/` that moved what a facet extracts, a plugin added or
 * removed, or the tree dropped (rebuilt on the next read). Returns the
 * unsubscribe.
 *
 * Registering does not arm the watcher — the first tree read (or
 * {@link pluginFacetsGeneration}) does, and it is armed before that read builds
 * anything. So a process that never handed out a tree hears nothing, and has
 * nothing that could be stale. Listeners run synchronously on the watcher's
 * batch: keep them cheap (a `notify`), and expect one call per batch, not per
 * file.
 */
export function onPluginFacetsChanged(listener: () => void): () => void {
  return facetsChange.on(listener);
}

/**
 * The faceted tree's current generation as an opaque token — a `revalidate`
 * ETag for a value derived from it: equal tokens mean it did not change in
 * between, and tokens from two processes never match. Arms the watcher first,
 * so a token is never minted for a tree nothing is watching.
 */
export async function pluginFacetsGeneration(): Promise<string> {
  await ensureWatcher();
  return facetsChange.token();
}

/**
 * Hear every change of the STRUCTURE tree (a plugin added, removed, or one of
 * its key files edited — its barrels, its package.json), and only those: an
 * edit to any other file under `plugins/` is not one. Same arming and listener
 * rules as {@link onPluginFacetsChanged}. Returns the unsubscribe.
 */
export function onPluginStructureChanged(listener: () => void): () => void {
  return structureChange.on(listener);
}

/**
 * The structure tree's generation as an opaque token — the `revalidate` ETag
 * of a value derived from {@link getStructureTreeCached} (see
 * {@link pluginFacetsGeneration}). Arms the watcher first.
 */
export async function pluginStructureGeneration(): Promise<string> {
  await ensureWatcher();
  return structureChange.token();
}

// How many file reads the structure index holds open at once. A backend's fs
// pool also serves its requests, and the cold build hands it every plugin's
// key files at once (~3.5k reads): at 64 (over a pool of ~18 threads) every
// other fs call of the process queued behind it (fs-wait on main, 2026-11-04:
// ~100 ms per read, all queue time). Narrow, so the pool keeps threads for the
// request path; a cold build takes a little longer instead.
const TREE_READ_CONCURRENCY = 8;

// A batch naming more paths than this is a checkout, a rebase or a mass move:
// one cold listing of the plugins root is cheaper than a scoped query of that
// many paths (and keeps git's argv bounded).
const MAX_SCOPED_PATHS = 2_000;

const REPO_ROOT = appPathParent(PLUGINS_DIR);
const PLUGINS_REL = PLUGINS_DIR.slice(REPO_ROOT.length + 1);

const io = {
  allMembers: () => listAllRepoMembers(REPO_ROOT),
  membersIn: (paths: readonly string[]) => listRepoMembers(REPO_ROOT, paths),
  read: repoFileReader(REPO_ROOT, { readConcurrency: TREE_READ_CONCURRENCY }),
};

/** The structure index — null until the first read, and after it was dropped. */
let index: Promise<StructureIndex> | null = null;

function dropIndex(): void {
  if (index === null) return;
  index = null;
  structureChange.bump();
}

function coldIndex(): Promise<StructureIndex> {
  if (index !== null) return index;
  const self: { building: Promise<StructureIndex> | null } = { building: null };
  self.building = buildCold(self);
  index = self.building;
  return self.building;
}

async function buildCold(self: {
  building: Promise<StructureIndex> | null;
}): Promise<StructureIndex> {
  try {
    return await withHeavyReadSlot(() =>
      createStructureIndex(REPO_ROOT, PLUGINS_REL, io),
    );
  } catch (err) {
    // A failed cold build is not kept: the next read builds again.
    if (index === self.building) index = null;
    throw err;
  }
}

/**
 * The batch as repo-relative paths — `edited` for a watcher `update` (the file
 * is there, its content changed), `paths` for a create or delete — or null
 * when one is outside the root.
 */
function repoPathsOf(
  events: FileChangeEvent[],
): { paths: string[]; edited: string[] } | null {
  const paths: string[] = [];
  const edited: string[] = [];
  for (const { path, type } of events) {
    if (path !== PLUGINS_DIR && !path.startsWith(`${PLUGINS_DIR}/`)) {
      return null;
    }
    const rel = `${PLUGINS_REL}${path.slice(PLUGINS_DIR.length)}`;
    (type === "update" ? edited : paths).push(rel);
  }
  return { paths, edited };
}

/**
 * Bring the structure index up to date with one watcher batch. Runs one at a
 * time (the watcher folds batches that land meanwhile into the next call). A
 * batch that lands while the cold build runs is applied after it — the cold
 * listing may or may not have seen it, and a refresh of an up-to-date path is
 * a no-op.
 */
async function refreshStructure(events: FileChangeEvent[]): Promise<void> {
  const current = index;
  if (current === null) return; // nothing built: the cold build reads it all
  const built = await current.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  );
  // A failed cold build was already reported to the read that ran it.
  if (!built.ok || index !== current) return;
  const batch = repoPathsOf(events);
  if (batch === null) {
    dropIndex();
    throw new Error(
      `plugin-tree: the plugins-dir watcher reported a path outside ${PLUGINS_DIR} — the structure index was dropped and is rebuilt cold on the next read.`,
    );
  }
  if (batch.paths.length + batch.edited.length > MAX_SCOPED_PATHS) {
    dropIndex();
    return;
  }
  let changed: boolean;
  try {
    changed = await built.value.refresh(batch.paths, batch.edited);
  } catch (err) {
    // A half-applied refresh leaves the index inconsistent: drop it, so the
    // next read rebuilds cold (and fails the same way while the cause stays).
    if (index === current) dropIndex();
    throw err;
  }
  if (changed && index === current) structureChange.bump();
}

/**
 * The STRUCTURE tree (no facets): every plugin, its key-file fields and the
 * hierarchy, as data. Kept up to date by the watcher — a read never rebuilds
 * it; only the first read of the process (or the first after the index was
 * dropped) builds it cold.
 */
export async function getStructureTreeCached(): Promise<PluginTreeData> {
  await ensureWatcher();
  return (await coldIndex()).tree();
}

// ── faceted tree ──
//
// One session per process (opened by the first read, kept until it ends or is
// dropped): the faceted index lives in a worker, refreshed by every watcher
// batch through one coalescer — batches that land while a refresh runs fold
// into one trailing refresh, so a burst of saves costs two refreshes, not one
// each. A read waits for the refresh covering the batches before it, so it
// never hands out a tree older than the edits the watcher already reported.

/** The open faceted session — null until the first read, and after it ended. */
let facets: FacetedTreeSession | null = null;

function openFacets(): FacetedTreeSession {
  if (facets !== null) return facets;
  const session = FacetedTreeSource.get().open(() => {
    // Ended on its own (its worker stopped, its code changed): the next read
    // opens a new one, on the code on disk now.
    if (facets !== session) return;
    facets = null;
    facetsChange.bump();
  });
  facets = session;
  return session;
}

function dropFacets(): void {
  const session = facets;
  if (session === null) return;
  facets = null;
  facetsChange.bump();
  void runTracked("plugin-tree:facets-close", () => session.close());
}

const facetsRefresh = createCoalescer<FileChangeEvent>({
  run: (events) => refreshFacets(events),
});

async function refreshFacets(events: FileChangeEvent[]): Promise<void> {
  const session = facets;
  if (session === null || events.length === 0) return;
  const batch = repoPathsOf(events);
  if (batch === null) {
    dropFacets();
    throw new Error(
      `plugin-tree: the plugins-dir watcher reported a path outside ${PLUGINS_DIR} — the faceted tree was dropped and is rebuilt cold on the next read.`,
    );
  }
  if (batch.paths.length + batch.edited.length > MAX_SCOPED_PATHS) {
    dropFacets();
    return;
  }
  let changed: boolean;
  try {
    changed = await session.refresh(batch.paths, batch.edited);
  } catch (err) {
    // Ended by design (dropped, stopped on a restart-skip, its code changed):
    // not a failure — the next read opens a new session.
    if (err instanceof FacetedSessionEnded && !err.failed) return;
    // A failed refresh leaves the index unusable: drop it, so the next read
    // rebuilds cold (and fails the same way while the cause stays).
    if (facets === session) dropFacets();
    throw err;
  }
  if (changed && facets === session) facetsChange.bump();
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
 * service — on the desktop, a worker thread holding the faceted index
 * (`plugin-tree/faceted`) — built cold by the first read of the process, then
 * kept up to date by the watcher's paths: O(changes), not a rebuild per edit.
 */
export async function getFacetsTreeCached(): Promise<PluginTreeData> {
  await ensureWatcher();
  // A session that ends by design while this read waits on it (stopped on a
  // restart-skip, its code changed) is followed to the next one; each turn
  // of this loop needs such an end — an event, never a spin.
  for (;;) {
    try {
      // Every batch the watcher handed over before this read is applied first.
      await facetsRefresh.run();
      if (facets === null) {
        // The cold build (the worker's snapshot, records and relate) holds
        // the heavy-read slot like the structure's: it reads every plugin's
        // files.
        return await withHeavyReadSlot(() => openFacets().tree());
      }
      return await facets.tree();
    } catch (err) {
      if (err instanceof FacetedSessionEnded && !err.failed) continue;
      throw err;
    }
  }
}
