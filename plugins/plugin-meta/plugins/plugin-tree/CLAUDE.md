# plugin-tree

## Both trees are data in a backend (`server/internal/structure-tree-cache.ts`)

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

The session ends — and the next read opens a new one (from the last checkpoint, below) — when the worker
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
the tree is not rebuilt on a change — a `StructureIndex` holds those inputs
(the member files under `plugins/`, sorted; a support count per plugin
position; each plugin's read fields) and is handed each batch:

- a watcher `update` of a file that is already a member: membership cannot have
  moved, so nothing is asked — a key file is re-read, any other file costs
  nothing at all;
- a create / delete (a file or a folder): re-asked of the file set for those
  paths only, support counts moved, and the key files of the plugins touched
  re-read. A `.gitignore` edit re-asks its folder.

The tree is re-linked (`assemblePluginTree`, in memory) only when a plugin
actually changed.

**Held by the worker, not the backend.** The faceted index builds this index
first, over its live snapshot, its fields from the key-file fold records
(`fieldsOf`: no key file parsed that an earlier process folded). The worker
posts it whole as soon as it is built — a `structure` frame
(`pluginStructureDelta`), before any facet record is keyed or read — and again
within each refresh that moved it, ahead of that refresh's facet work.
`getStructureTreeCached` reads it from the session (`FacetedTreeSession.structure`),
and `onPluginStructureChanged` fires on those frames only — the
`plugin-view.tree` live value listens to that, not to every edit, and has no
throttle. The faceted tree has its own signal (`onPluginFacetsChanged`).

The backend used to build the same index a second time, in process: the
whole repo listed with git and ~3.8k key files read and parsed on its event
loop (0.3–0.5 s alone on main's checkout; 0.65–2.5 s wall on main's boots,
where it ran inside the restart's resubscribe burst and was, once the worker
resumed from its checkpoint, the warm-up's tail — 2026-11-14). The two trees
are equal (same nodes, same order).

**The structure never fails with the facets.** It is built as soon as the
snapshot is there, not after the facet modules load; a facet module that does
not load or an extraction that throws leaves the index holding the structure
(kept up to date by every refresh) with its facets FAILED — a faceted read
rejects with `FacetsUnavailable`, reported as a server error — and the next
change ends the session by design (`facets-retry`): a fresh worker imports the
facet modules anew (an import that threw throws again in the same process)
and catches up from the checkpoint. Only the snapshot or the structure
failing, or the worker dying, ends it on an error. A session that ends by
design bumps the trees it had told a reader about (`onEnded`'s `held`); one
that ends on an error is reported and bumps nothing, so `plugin-view.tree` —
which re-reads on every structure bump — cannot loop re-opening a worker that
keeps failing (the next read or change opens a new one).
One cost: the structure shares the worker's one queue, so a key-file edit
made during a slow facets refresh reaches the structure after that refresh
(within its own refresh it is posted before the facet work).

The `read` form of `StructureIndexIo` (each key file's text, parsed in place)
remains for a reader without a record store (`scripts/bench-structure-tree.ts`).
`e2e/structure-tree-live.ts` checks the deployed value (an ordinary file is a
304; a plugin added, edited, removed reaches the tab).

## Boot warm-up (`server/internal/warmup.ts`)

Both trees die with the process, so on main (which restarts on every deploy)
the first Studio/plugin-view request of each process would wait for them. A
`host`-scoped `defineWarmup` reads both in the throttled post-boot drain
instead, which opens the worker session (inside a heavy-read slot held until
its first build is done, whichever tree was asked first). Worktree backends
keep the lazy path on purpose: their Studio surfaces are rarely opened.

What the worker's cold build costs, and why (2026-11-14, main's checkout,
host load 10–20, steps timed one after another): git snapshot ~0.3 s; the
facet modules ~0.37 s → ~15 ms, since `token-usage` loads TypeScript and
Tailwind on its first scan instead of at import (a build whose records all
hit — every boot after an ordinary push — scans nothing); structure + facet
keying ~0.48 → ~0.33 s, since the worker's `StructureIndex` takes its fields
through `fieldsOf` from the key-file fold records (`structure-records`'
`recordedPluginFields`) instead of reading and parsing all ~3.8k key files;
then node keys ~80 ms, record reads ~185 ms, parse ~50 ms and relate ~0.2 s.
Snapshot and facet loading run together, then structure and keying.

## The index starts from the last one's checkpoint (`bin/faceted-tree-worker.ts`)

The worker lives and dies with the backend, which restarts on every deploy,
and its cold build asked git to list and hash the whole checkout (~24k files:
0.2–0.45 s on a calm host, 0.6–4 s under load — the biggest step of the
build) although almost nothing changed since the last one. So each build
leaves a checkpoint, `~/.equin/worktrees/<ns>/faceted-index.json`
(`worktreeArtifacts.facetedIndexCheckpoint`, temp + rename): the index's file
set (`FacetedCheckpoint`: every member and its blob id) and a file-system
journal cursor (`infra/file-watcher`'s `journalCursor`) taken BEFORE the build
read anything. The next worker replays the journal since that cursor
(`journalChangesSince`, O(changes)) and starts from the saved set, asking git
only about the paths it names (`LiveRepoSnapshot.refresh`, the same code as a
watcher batch). A path changed after the cursor is named again next time, so
the set saved may be any state after its cursor: a re-check, never a miss.

- **What is kept, and why only that.** The members are a fact about the
  checkout; the rule that listed them is code, so they carry the code identity
  of `REPO_MEMBERSHIP_URL` (tooling's `repo-files.ts`, through
  `plugin-records`' `codeIdentity`), and a set listed by another rule starts
  cold. Everything else is rebuilt from it with this process's code: the
  structure (key-file fold records), the record keys and reads, relate. Those
  are cheap once the code identities are computed, which every process does
  once, and relate needs every plugin's data anyway.
- **Cold, the answer that is always right**, whenever the journal cannot
  vouch (not FSEvents, cursor over 7 days old, the root replaced, dropped
  events — its own fail-closed rules), there is no checkpoint, it is not JSON
  or in a format this code cannot read, it is another checkout's, git's
  `.git/info/exclude` changed, the root itself is named, more than 2,000
  paths changed (a checkout or rebase: one listing is cheaper), or the set was
  last listed whole over a day ago (`listedAt`, carried from checkpoint to
  checkpoint). That last bound is for what the journal cannot see and a
  listing does: git's index alone (`git rm --cached`, `add -f`), a linked
  worktree's exclude file (in the shared git dir, outside the checkout), a
  binary file re-hashed as text by a refresh — at most a day wrong, one cold
  listing among main's ~50 restarts. `.git` and `node_modules` paths are
  skipped, and so is every path git ignores and does not track
  (`dropIgnoredPaths`, `git check-ignore`): a build's output, and the agents'
  checkouts under main's ignored `.claude/worktrees/`. A checkpoint that
  cannot be written is reported (`reportServerError`); the session goes on. Each
  build logs how it started to the `plugin-tree` log channel (`faceted index built in … ms,
  resumed …` / `cold (…)`) and the `ready` frame carries it (`FacetedStart`).
- **Measured** (`scripts/bench-faceted-index.ts`, 2026-11-14, this worktree,
  host load 12–16; in-worker build): from the checkpoint with no change
  0.83–0.98 s, against 1.38–1.77 s cold; the snapshot step 0.18–0.46 s
  (cursor, read and replay 30–240 ms) against 1.0–4.1 s. The bench proves a
  resumed tree equals a fresh build after edits made while no worker ran,
  and — in a throwaway `git clone --shared` — after a branch switch (~490
  paths) and a rebase; a cursor past the journal's age and a journal reset
  start cold, saying why. The branch switch and the rebase first DIFFERED:
  upstream parcel's history replay left out about half the files git
  rewrote (unlink + create), fixed in the patched addon (file-watcher's
  `parcel-addon`).
- **What a resume costs on main** (2026-11-14, load ~1.6, main's checkout):
  the replay is FSEvents scanning the machine's history since the cursor —
  ~0.39 s for 276 paths 12 minutes later, almost all agents' checkouts and
  `.git` — so on a calm host a resumed snapshot (0.76–0.9 s) is no faster
  than main's cold listing (0.34–0.56 s); it pays off under load, where the
  listing grows to seconds. Each build's steps are in its `plugin-tree` log
  line (`steps`, ms from its start).

What is still whole-tree per process: each record producer's code identity
(the module graph over its closure, ~0.2 s, shared by the key-file fold and
the facets), the record reads (~0.1–0.2 s) and relate (~0.15–0.3 s), and the
whole tree handed to the backend (it holds nothing before).

## One structure tree per check pass (`structure-records`)

A check pass runs ~100 checks on one JS thread, and six of them used to call
`buildPluginTree(root)` themselves — six full walks
back to back, all of it time the other checks waited on. Check code now reads
`buildStructureTreeOnce(pluginsRoot, repo)` from the `structure-records`
sub-plugin: built once per root for the life of the process and handed to
every caller as the same value. The facet-carrying twins are codegen's
`buildBarrelFreeTree` / `buildEnrichedTree`, whose structure comes from the
same record-backed build (`buildRecordedPluginTree`): each key file's facts are
a plugin record, so a pass parses only the key files an edit touched. See
`plugins/structure-records/CLAUDE.md`.

- **Frozen, because shared.** Nodes, their records and arrays are frozen, and the
  `byDir` / `byPath` mutators throw — one check re-sorting `roots` would otherwise
  change what every later check reads, depending on scheduling.
- **Never for a long-lived server.** The memo never invalidates; a backend reads
  `getStructureTreeCached` from the `server` barrel, which rebuilds on a watcher.
- **Enforced** by this plugin's `no-uncached-tree-in-checks` lint rule: a file
  under a plugin's `check/` folder, or the runner's `checks/core/`, may not import
  `buildPluginTree`, `buildRecordedPluginTree` (or `faceted`'s
  `buildFacetedPluginTree`) as a value. It sees paths, not call graphs — a helper a check
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

- Description: Watcher-kept plugin-tree accessors: the structure tree and the faceted tree, both held by the FacetedTreeSource host service (a worker holding the faceted index, which builds the structure first and hands it out ahead of the facets — neither is built in the backend), kept up to date by what changed (O(changes)), each with its own change signal.
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
    - `FacetedSessionHandlers`
    - `FacetedTreeSession`
    - `FacetedTreeSourceImpl`
  - Exports (values):
    - `FacetedSessionEnded`
    - `FacetedTreeSource`
    - `FacetsUnavailable`
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
    - `FacetedStart`
    - `KeyFileFacts`
    - `PluginFields`
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
    - `assemblePluginTree`
    - `buildPluginTree`
    - `createStructureIndex`
    - `findAllPluginDirs`
    - `keyFileOwner`
    - `parseKeyFile`
    - `PLUGIN_KEY_FILES`
    - `pluginFieldsFrom`
    - `pluginStructureDelta`
    - `pluginTreeDelta`
    - `pluginTreeFromDelta`
    - `pluginTreeToJson`
    - `resolvePluginSpecifier`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/deploy-secrets/approvals`
    - `framework/cli/release`
    - `framework/tooling/codegen`
    - `plugin-meta/composition`
    - `plugin-meta/plugin-tree/faceted`
    - `plugin-meta/plugin-tree/structure-records`
    - `plugin-meta/plugin-view`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `core/internal/plugin-tree.ts`, `server/internal/tree-change-signal.ts` (debt)
- Machine:
  - Register: `defineDaemon('plugin-tree.faceted-index')`
- Sub-plugins:
  - **`faceted`** — The faceted plugin tree, build tooling: buildFacetedPluginTree (the structure tree plus every facet extracted — plugin records from a snapshot — enriched and related), and the faceted index a…
  - **`structure-records`** — The structure tree as build tooling reads it: buildRecordedPluginTree (each plugin key file's facts a fold record, so a pass re-parses only the barrels and package.json files an edit touched) and…

<!-- AUTOGENERATED:END -->
