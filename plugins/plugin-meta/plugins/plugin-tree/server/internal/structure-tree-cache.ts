import type { PluginTreeData } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { withHeavyReadSlot } from "@plugins/infra/plugins/host/plugins/host-read-pool/server";
import {
  defineFileWatcher,
  type FileChangeEvent,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/server";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { createTreeChangeSignal } from "./tree-change-signal";
import {
  FacetedSessionEnded,
  FacetedTreeSource,
  FacetsUnavailable,
  type FacetedTreeSession,
} from "./faceted-source";

// Watcher-kept plugin-tree accessors: the structure tree and the faceted tree,
// both held by ONE session of the `FacetedTreeSource` host service (on the
// desktop, a worker holding the faceted index) and kept up to date there by
// what changed.
//
// The structure is the first thing that index builds — from the key-file
// fold records, off this thread — and the session hands it out on its own,
// ahead of the facets (`structure()`), so a structure reader never waits for
// facet records or relate. The backend used to build it a second time, in
// process: the whole repo listed and ~3.8k key files read and parsed on this
// event loop, right in a restart's resubscribe burst (0.3–0.5 s alone,
// 0.7–2.5 s wall on main's boots, 2026-11-14), the same tree the worker
// already held.
//
// ONE lazy @parcel watcher on `PLUGINS_DIR` feeds the session each batch's
// paths through one coalescer (`facetsRefresh`); the index re-asks git about
// those paths only, re-keys the plugins owning them and re-extracts only the
// records whose key moved. Two signals come out:
//
// - `facetsChange` — the FACETED tree changed: the refresh handed back a tree
//   that differs. An edit the facets do not see (a function body, a test)
//   moves nothing (`onPluginFacetsChanged`, `pluginFacetsGeneration`).
// - `structureChange` — the STRUCTURE tree changed (a plugin added, removed,
//   or one of its key files edited), told by the session within the refresh,
//   before its facet work (`onPluginStructureChanged`,
//   `pluginStructureGeneration`). The `plugin-view.tree` hot path listens to
//   this one only.
//
// The session is opened by the first read of either tree, and opened again
// after it ended — its worker died or was stopped, its code changed, a
// refresh failed, the watcher lost events (`onLost`), or a batch named more
// than 2,000 paths (a checkout / rebase). A new session's index starts from
// the last one's checkpoint (`bin/faceted-tree-worker.ts`).
//
// The watcher is armed BEFORE any session opens (every accessor awaits it): a
// tree handed out before the watcher was listening could miss the change that
// made it stale, and nothing would ever move the generation for it.

/** The one lazy watcher over `PLUGINS_DIR`, opened by the first tree read. */
export const pluginsDirWatcher = defineFileWatcher({
  name: "plugin-tree.plugins-dir",
  description:
    "Watches the plugins folder so the plugin trees follow a plugin added, removed or edited — by re-reading only what changed.",
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
      if (facets !== null) facetsRefresh.trigger(events);
    },
    onLost: () => {
      // Events may be gone: nothing the session holds can be trusted.
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
 * its key files edited — its barrels, its package.json — or the tree
 * dropped), and only those: an edit to any other file under `plugins/` is not
 * one. Same arming and listener rules as {@link onPluginFacetsChanged}.
 * Returns the unsubscribe.
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

const PLUGINS_REL = "plugins";

// A batch naming more paths than this is a checkout, a rebase or a mass move:
// a new session (from the checkpoint, or one cold listing) is cheaper than a
// scoped query of that many paths (and keeps git's argv bounded).
const MAX_SCOPED_PATHS = 2_000;

/**
 * The STRUCTURE tree (no facets): every plugin, its key-file fields and the
 * hierarchy, as data — the session's, handed out as soon as its index has it.
 * Kept up to date by the watcher; a read never rebuilds it.
 */
export async function getStructureTreeCached(): Promise<PluginTreeData> {
  return readSession((session) => session.structure());
}

// ── the session ──
//
// One session per process (opened by the first read, kept until it ends or is
// dropped), refreshed by every watcher batch through one coalescer — batches
// that land while a refresh runs fold into one trailing refresh, so a burst of
// saves costs two refreshes, not one each. A faceted read waits for the
// refresh covering the batches before it, so it never hands out a tree older
// than the edits the watcher already reported; a structure read takes the
// structure as the session last told it (as the in-process index did).

/** The open session — null until the first read, and after it ended. */
let facets: FacetedTreeSession | null = null;

/** Both trees are gone with their session: the next read of either is new. */
function bumpBoth(): void {
  facetsChange.bump();
  structureChange.bump();
}

function openFacets(): FacetedTreeSession {
  if (facets !== null) return facets;
  const session = FacetedTreeSource.get().open({
    onEnded: (ended, held) => {
      // Ended on its own: the next read opens a new one, on the code on
      // disk now. By design (its code changed, its facets are retried, it
      // was stopped), the trees it had told a reader about move, and their
      // readers open the next session. On an error (its worker died, its
      // snapshot or structure failed) nothing moves — it is reported — so
      // `plugin-view.tree`, which re-reads on every structure bump, cannot
      // loop re-opening a worker that keeps failing; the next read or
      // change opens a new one.
      if (facets !== session) return;
      facets = null;
      if (ended.failed) {
        reportServerError({ message: ended.message });
        return;
      }
      if (held.structure) structureChange.bump();
      if (held.facets) facetsChange.bump();
    },
    onStructureChanged: () => {
      if (facets === session) structureChange.bump();
    },
  });
  facets = session;
  return session;
}

/** The session being opened: waiting for its heavy-read slot. */
let opening: Promise<FacetedTreeSession> | null = null;

/**
 * The open session, or one opened now. Its first build (the worker's
 * snapshot, structure, records and relate) reads every plugin's files, so the
 * session is opened inside a heavy-read slot, held until that build is done —
 * whichever tree the read that opened it wanted (the structure comes first).
 */
function sessionOpened(): Promise<FacetedTreeSession> {
  if (facets !== null) return Promise.resolve(facets);
  if (opening !== null) return opening;
  const { promise, resolve, reject } =
    Promise.withResolvers<FacetedTreeSession>();
  opening = promise;
  let opened = false;
  void runTracked("plugin-tree:first-build", async () => {
    try {
      await withHeavyReadSlot(async () => {
        if (opening === promise) opening = null;
        const session = openFacets();
        opened = true;
        resolve(session);
        await session.tree();
      });
    } catch (err) {
      if (opening === promise) opening = null;
      // Never opened (the slot failed): the reads waiting on it report it.
      if (!opened) return reject(err);
      // The build failed or the session ended: told to its readers.
      if (
        err instanceof FacetedSessionEnded ||
        err instanceof FacetsUnavailable
      )
        return;
      throw err;
    }
  });
  return promise;
}

function dropFacets(): void {
  const session = facets;
  if (session === null) return;
  facets = null;
  bumpBoth();
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
 * (`plugin-tree/faceted`) — built by the first read of the process, then
 * kept up to date by the watcher's paths: O(changes), not a rebuild per edit.
 * Every batch the watcher handed over before this read is applied first.
 */
export async function getFacetsTreeCached(): Promise<PluginTreeData> {
  return readSession(async (session) => {
    await facetsRefresh.run();
    // A refresh that ended the session rejects this read; the loop in
    // `readSession` follows it to the next one.
    return await session.tree();
  });
}

/**
 * Read from the session, opening it when there is none. A session that ends
 * by design while this read waits on it (stopped on a restart-skip, its code
 * changed) is followed to the next one; each turn of this loop needs such an
 * end — an event, never a spin.
 */
async function readSession(
  read: (session: FacetedTreeSession) => Promise<PluginTreeData>,
): Promise<PluginTreeData> {
  await ensureWatcher();
  for (;;) {
    try {
      return await read(await sessionOpened());
    } catch (err) {
      if (err instanceof FacetedSessionEnded && !err.failed) continue;
      throw err;
    }
  }
}
