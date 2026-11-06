# plugin-tree

## The faceted tree is data in a backend (`server/internal/structure-tree-cache.ts`)

`core/` builds the STRUCTURE tree only (`buildPluginTree`: the walk, each
barrel's description and flags, the hierarchy). Extracting facets is build
tooling — it loads every facet extractor by a computed path
(`facets/loader`), and through them the parsers and codegen — so it lives in
the `faceted` sub-plugin (`buildFacetedPluginTree`), which only the CLI, the
check runner and codegen import.

A serving backend never runs it: `getFacetsTreeCached` reads the tree through
the `FacetedTreeSource` host service, whose desktop provider
(`machine/`) keeps it in a worker thread — the
`plugin-tree.faceted-index` daemon running `bin/faceted-tree-worker.ts`
— and hands the backend a `PluginTreeData` (the nodes and their indexes, no
extractors, no file set). Why: a backend whose closure reaches a computed load
has code no digest can measure (`boot:closure-digestable`,
`research/2026-11-05-global-backend-code-identity.md`), and the extraction is
CPU that must not run on the backend's event loop. The tree's consumers —
`classifyEdges`, plugin-view's payload, the deploy-secrets gate — take
`PluginTreeData`, so a faceted tree built in-process and one read back are the
same input to them.

## The faceted tree follows what changed (`faceted/core/internal/faceted-index.ts`)

It used to be rebuilt whole on every file event under `plugins/`: a child
(`./equin plugin-tree-facets`) took a whole snapshot, the structure, every
plugin's record keys and reads, relate, and a 7.8 MB JSON round trip, on top of
its own boot and tooling load — 30–80 s of wall time per change on a loaded
host (2026-11-06, load 45–75; ~3.5–5 s of it in-process work with every record
warm), hidden behind a 2 s throttle on each consumer.

A plugin's facets are plugin records: a function of its own files
(`pluginFilesManifest`), the facet's code and its batch inputs. So the worker
holds a `FacetedIndex`: a live snapshot of the checkout (`live-snapshot.ts`:
`loadRepoSnapshot` once, then each batch's paths re-asked of git and its edited
files re-hashed), the structure index over it, and each plugin's record keys
and texts. The backend's one `plugins/` watcher hands it every batch (through
a coalescer: batches landing mid-refresh fold into one trailing refresh), and
a refresh:

- re-keys only the plugins that own a changed path (the owner for an edited
  file; every ancestor too for a file added or removed — a folder line of
  theirs may move), all of them only when a batch input changed;
- reads, or extracts and stores, only the records whose key moved;
- runs `relate` — the one whole-tree step, it joins every plugin's data in
  place — only when a record's TEXT or the structure changed. A save the facets
  do not see (a function body, a test, a comment) moves a key, not a text:
  nothing else runs;
- sends the backend only the nodes whose related facets changed
  (`pluginTreeDelta`, applied by `pluginTreeFromDelta`), and
  `onPluginFacetsChanged` fires only then. Its consumers (plugin-view's facets
  tree, the composition graph, deploy-secrets) have no throttle.

A read waits for the refresh covering the batches the watcher reported before
it. Measured by `scripts/bench-faceted-index.ts` (2026-11-06, load ~19,
records warm): the old per-change work 1.2–2.1 s in-process (the child's boot
and tooling load on top); now a cold build ~2.4 s once per process, then a
save the facets do not see 1–5 ms, an export added ~210–350 ms (relate + one
node shipped), a file created or deleted ~40–90 ms; the tree after every edit
equals a fresh build. `e2e/facets-tree-live.ts` checks the deploy: a plugin
added / an export added / the plugin removed seen in ~300 / ~280 / ~470 ms, an
ordinary file or a body edit a 304, a worker module rewritten served again by
a fresh worker in ~2.5 s.

The session ends — and the next read opens a new one, cold — when the worker
dies, a refresh fails, the watcher loses events or reports a batch over 2,000
paths, or a changed path is code the worker loaded (`require.cache`: the
extractors, the index; its records were made by code no longer on disk). On
a restart-skip the daemon is stopped rather than judged
(`onCodeAdopted: "stop"`, `infra/spawn/daemon`): its code is tooling no digest
can measure, and it holds only what that code rebuilds. Files outside
`plugins/` that key records (`bun.lock`, the runtime) are read at the cold
build only.

## The structure tree follows what changed (`core/internal/structure-index.ts`)

A node is a function of two inputs only: whether its folder holds any file of
the repo's set (the content gate, `pluginPositionsOf`), and the text of its own
key files (`PLUGIN_KEY_FILES`: the four runtime barrels and `package.json`). So
a backend does not rebuild the tree on a change — it holds a `StructureIndex`
(those inputs: the member files under `plugins/`, sorted; a support count per
plugin position; each plugin's read fields) and `getStructureTreeCached` hands
out its current tree. The one `plugins/` watcher feeds it each batch:

- a watcher `update` of a file that is already a member: membership cannot have
  moved, so nothing is asked — a key file is re-read, any other file costs
  nothing at all;
- a create / delete (a file or a folder): re-asked of git for those paths only
  (`listRepoMembers` — `loadRepoFiles`' membership rule, scoped by literal
  pathspecs), support counts moved, and the key files of the plugins touched
  re-read. A `.gitignore` edit re-asks its folder.

The tree is re-linked (`assemblePluginTree`, in memory) only when a plugin
actually changed, and only then does `onPluginStructureChanged` fire — the
`plugin-view.tree` live value listens to that, not to every edit, and has no
throttle. The faceted tree has its own signal (`onPluginFacetsChanged`, above).

Cold builds happen once per process (the first read) and again only when the
index was dropped: the watcher lost events (`onLost`), a batch named more than
2,000 paths (a checkout or rebase — one listing is cheaper), a path came outside
the root, or a refresh failed (a half-applied refresh is never kept). A cold
build lists the whole repo's members (`listAllRepoMembers`: one `git status`
over the untracked cache, then only the wholly-untracked folders walked) and
keeps those under `plugins/` — a pathspec-scoped listing would bypass the cache
and walk all of `plugins/`. It reads key files at width 8:
the fs pool also serves the backend's requests — at 64 every other fs call of
main queued behind the warm-up (fs-wait, 2026-11-04: ~100 ms per read, all
queue time). The listing was its biggest cost while it was git's untracked walk
of `plugins/` (`ls-files --others`: ~0.8 s median, seconds under load; now
~0.13–0.17 s). `scripts/bench-structure-tree.ts` measures cold and
per-edit costs (2026-11-06, medians: whole rebuild per change 1,073 ms → cold
804 ms once, then 0 ms per save, ~48 ms per file created or deleted, ~46 ms
per plugin folder); `e2e/structure-tree-live.ts` checks the deployed value
(an ordinary file is a 304; a plugin added, edited, removed reaches the tab).

The repo-root `.gitignore` is outside the watch: an edit to it that moves
membership under `plugins/` is seen at the next cold build, as before.

## Boot warm-up (`server/internal/warmup.ts`)

Both tree caches are in-memory and die with the process, so on main (which
restarts on every deploy) the first Studio/plugin-view request of each process
would wait for both. A `host`-scoped `defineWarmup` reads structure + facets in
the throttled post-boot drain instead (the faceted one by starting its
worker). Worktree backends keep the lazy cold path on purpose: their Studio
surfaces are rarely opened.

## One structure tree per check pass (`core/internal/structure-tree-once.ts`)

A check pass runs ~100 checks on one JS thread, and six of them used to call
`buildPluginTree(root)` themselves — six full walks
back to back, all of it time the other checks waited on. Check code now reads
`buildStructureTreeOnce(pluginsRoot)`: built once per root for the life of the
process and handed to every caller as the same value. The facet-carrying twins
are codegen's `buildBarrelFreeTree` / `buildEnrichedTree`.

- **Frozen, because shared.** Nodes, their records and arrays are frozen, and the
  `byDir` / `byPath` mutators throw — one check re-sorting `roots` would otherwise
  change what every later check reads, depending on scheduling.
- **Never for a long-lived server.** The memo never invalidates; a backend reads
  `getStructureTreeCached` from the `server` barrel, which rebuilds on a watcher.
- **Enforced** by this plugin's `no-uncached-tree-in-checks` lint rule: a file
  under a plugin's `check/` folder, or the runner's `checks/core/`, may not import
  `buildPluginTree` (or `faceted`'s `buildFacetedPluginTree`) as a value. It sees paths, not call graphs — a helper a check
  calls from elsewhere (`tooling/boundaries/core/check.ts`) is not covered and
  was moved by hand.

## Facet extraction yields by time (`faceted/core/internal/faceted-tree.ts`)

The extract loop and the relate loop share their thread with
everything else in the process. Extract yields a macrotask after ~10 ms of work
(`createTimeSlicer`), checked after every facet of every node, not after a fixed
node count — one node's facets can cost far more than another's. Relate still
runs each facet's `relate` whole and yields between facets.

## Barrel metadata (`core/internal/barrel-meta.ts`)

`collectPluginFields` reads each runtime barrel's `description` / `loadBearing` /
`collapsed` from the **original source**, never from transpiler output. Bun's
transpiler re-quotes string literals (a `"` inside a double-quoted string is
re-emitted single-quoted), so recovering a value by re-parsing stripped output
silently dropped any description containing a quote. `parsePluginBarrel` isolates
the barrel's own `export default { … }` body (`defaultExportObjectBody`) and reads
only its top-level keys (`{ depth0: true }`) so a nested contribution's
`description:` / `loadBearing:` can never leak in.

It **throws** — failing `./equin build` and `./equin check` before a
lossy doc can be written — when a barrel has no default-exported object literal, or
when `description` is present but not a static string literal. An unparseable
description must be impossible to commit; never make the parser tolerant of a
dynamic value.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Watcher-kept plugin-tree accessors: the structure tree, kept up to date in-process by what changed (a plugin added or removed, a key file edited — O(changes), with its own change signal), and the faceted tree, kept up to date by what changed through the FacetedTreeSource host service (a worker holding the faceted index, never extracted in the backend), with its own change signal.
- Server:
  - Contributes: `host-service:plugin-tree.faceted-source` "plugin-tree.faceted-source"
  - Uses:
    - `infra/file-watcher.defineFileWatcher`
    - `infra/file-watcher.FileChangeEvent`
    - `infra/file-watcher.FileWatcher`
    - `infra/host/host-read-pool.withHeavyReadSlot`
    - `infra/paths.PLUGINS_DIR`
    - `infra/warmup.defineWarmup`
  - Exports (types):
    - `FacetedTreeSession`
    - `FacetedTreeSourceImpl`
  - Exports (values):
    - `FacetedSessionEnded`
    - `FacetedTreeSource`
    - `getFacetsTreeCached`
    - `getStructureTreeCached`
    - `onPluginFacetsChanged`
    - `onPluginStructureChanged`
    - `pluginFacetsGeneration`
    - `pluginStructureGeneration`
  - Register:
    - `defineWarmup('plugin-tree.trees')`
    - `defineFileWatcher('plugin-tree.plugins-dir')`
- Core:
  - Uses:
    - `framework/plugin-id.asPluginId`
    - `framework/plugin-id.PLUGIN_MANIFEST_KEY`
    - `framework/plugin-id.PluginId`
    - `infra/host-fs/user-path.AppPath`
    - `infra/host-fs/user-path.appPathParent`
    - `infra/host-fs/user-path.joinAppPath`
    - `packages/list-bound.wholeRecord`
    - `plugin-meta/parse-utils.defaultExportObjectBody`
    - `plugin-meta/parse-utils.parseBoolField`
    - `plugin-meta/parse-utils.parseStringField`
  - Exports (types):
    - `BuildPluginTreeOptions`
    - `PluginNode`
    - `PluginNodeDelta`
    - `PluginNodeJson`
    - `PluginTree`
    - `PluginTreeData`
    - `PluginTreeDelta`
    - `PluginTreeJson`
    - `Runtime`
    - `StructureIndex`
    - `StructureIndexIo`
  - Exports (values):
    - `buildPluginTree`
    - `buildStructureTreeOnce`
    - `createStructureIndex`
    - `pluginTreeDelta`
    - `pluginTreeFromDelta`
    - `pluginTreeToJson`
    - `resolvePluginSpecifier`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/deploy-secrets/approvals`
    - `framework/cli/release`
    - `framework/tooling/boundaries`
    - `framework/tooling/checks`
    - `framework/tooling/codegen`
    - `plugin-meta/composition`
    - `plugin-meta/plugin-tree/faceted`
    - `plugin-meta/plugin-view`
    - `plugin-meta/relocate`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `core/internal/plugin-tree.ts`, `server/internal/tree-change-signal.ts` (debt)
- Machine:
  - Register: `defineDaemon('plugin-tree.faceted-index')`
- Sub-plugins:
  - **`faceted`** — The faceted plugin tree, build tooling: buildFacetedPluginTree (the structure tree plus every facet extracted — plugin records from a snapshot — enriched and related), and the faceted index a…

<!-- AUTOGENERATED:END -->
