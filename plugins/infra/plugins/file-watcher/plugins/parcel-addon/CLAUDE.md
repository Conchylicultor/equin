# parcel-addon

`@parcel/watcher` 2.6.0's kqueue backend (macOS — what the file-watcher engine
runs a `writesWhileOpen` follow on) never closes a descriptor it stops
tracking: a watched file deleted or renamed, the entries of a watched directory
that goes, or a path two nested watches both hold (`unsubscribe` closes per
path, not per descriptor) — each leaks one for the life of the process. This
plugin ships the fixed build.

- **The fix** is `patches/@parcel%2Fwatcher@2.6.0.patch` (bun
  `patchedDependencies`), mostly in `src/kqueue/KqueueBackend.cc`:
  - every removal path queues the descriptor — each tree's own (nested watches
    hold separate trees), and those of a removed directory's entries — and
    closes them **after** the batch is handled. Closing mid-batch would let a
    `watchDir` of a file created in the same batch get the number back while a
    later event still names the old file.
  - a removed directory's entries go with it (`forgetDescendants`): reported
    removed to each watcher that did not ignore them, closed, and erased from
    the tree, so a directory recreated under the same name is watched afresh;
  - a removal drops only its own tree's subscriptions of a path
    (`forgetSubscriptions(path, tree)`, the one way a removal leaves the
    table). Subscriptions are keyed by path and a path is held by every tree
    that watches it; upstream erased the key, so a folder an outer watch saw
    go (renamed away, or diffed out) took the subscriptions of a watch rooted
    at or below it too: that watch's descriptors were left with nothing
    pointing at them — never closed by its `unsubscribe` — and its own
    delete, when it came, found no subscription to report to;
  - an event speaks for the subscriptions of the descriptor it fired on
    (`findSubscriptions(path, fd)`), never every subscription of the path:
    each tree opens its own descriptor of an entry and hears the change on
    it. Upstream took the whole path — after a folder was renamed away and
    the path re-created, the inner watch's stale descriptor going removed
    the outer watch's live folder (and a write to one folder diffed its
    listing into the tree watching the other); the delete branch also
    applied the firing entry's kind to every tree, so a tree holding the
    path as a folder had its entries freed with no descriptor closed;
  - a delete or rename is handled before a directory diff (a directory whose
    last entry went and which was removed reports both in one event);
  - the delete branch stops reading the `DirEntry` it just freed;
  - `unsubscribe` closes a descriptor unless another subscription holds that
    same one (upstream counted the path's subscriptions) and clears it off the
    cached tree's entry;
  - `compareDir` closes its `dup` on both early returns.

  - `start()` handles each batch under the backend's mutex, which `subscribe` /
    `unsubscribe` hold: upstream read subscriptions an `unsubscribe` was
    erasing (a use-after-free — main's three Bun segfaults of 2026-11-06..08,
    in `compareDir` → `Watcher::isIgnored`) and grew a tree a `subscribe` was
    iterating; watchers are notified after it is released;
  - `subscribe` reads a tree of its own through its own ignore. Upstream shared
    the one cached per directory path, read through the FIRST subscription's
    ignore and grown by every directory diff, so a later subscription of the
    directory met entries it ignores and failed with a stale errno (`error
    watching <dir>: Undefined error: 0` / `File exists`) or missed its files —
    the supervised runs dir's follow, re-opened per live-run change, died this
    way under bursts of run starts (2026-11-06..08, ~20 dead jobs a day);
  - a failed `subscribe` rolls back what it watched (upstream left it in the
    backend: descriptors held and the tree kept alive — every later open of
    the directory then failed), and reports its real errno; an entry gone
    between the listing and its open is dropped, not a failure;
  - `src/unix/fts.cc`'s `readTree` skips an entry below the root that went
    between the listing and its stat (another process pruning it), or that
    the watcher ignores — upstream failed the open with `No such file or
    directory`;
  - an entry this account may not list or open (EACCES / EPERM — macOS
    privacy protection: `~/.Trash` without Full Disk Access) stays in the
    tree with no descriptor, in `readTree`, `subscribe` and the directory
    diff: heard coming and going by its folder's diff, never written.
    Upstream failed the whole subscription, so no kqueue watch of `~` (the
    engine's `children` depth) could open;
  - only an entry kqueue's vnode filter can watch is opened, decided by its
    kind before any `open(2)` (`watchableKind`): a regular file or a folder,
    a symlink followed to one. A socket (its open fails EOPNOTSUPP — "error
    watching ~/.equin/sockets: Operation not supported on socket" failed the
    whole subscription), a FIFO (its open waits for a writer), a device, and
    a symlink resolving to nothing (dangling, looping) stay in the tree with
    no descriptor, like an unopenable one. `watchDir` answers `Watched` /
    `Unwatched` / `Failed` instead of a bool read with `errno`, so the
    subscribe and the directory diff cannot tell them apart differently —
    and a socket created in a watched folder no longer cuts that diff short;
  - a folder diff (`compareDir`) has no answer to ignore — upstream returned
    `false` partway and `start()` dropped it, so the rest of the diff (other
    creates, every delete) went unreported with no error until the folder
    changed again. Now each outcome is handled where it happens:
    - an entry gone between the listing and its stat or open (ENOENT /
      ENOTDIR — `WatchResult::Gone`) is a race, not a failure: skipped (its
      create and removal cancel out; a tree that held it hears it removed),
      and the diff goes on;
    - the folder itself gone mid-diff (`fdopendir` / `readdir` ENOENT) ends
      the diff quietly: the folder's own descriptor reports its delete,
      which takes its entries with it;
    - anything else — an entry that cannot be stat'ed or watched (EMFILE,
      …), `dup` / `fdopendir` / `readdir` failing — is reported to each
      watcher it leaves behind as an error delivered with the batch
      (`EventList::error`, the channel FSEvents reports dropped events on:
      the engine's `onLost`), the created entry still reported, and the diff
      goes on for the rest; an entry it could not watch stays out of the
      tree, so the next diff of the folder tries it again;
  - each batch is handled in two passes — every delete / rename first, then
    the writes and directory diffs. An atomic rewrite (write a sibling,
    rename it over the file) reports the folder's `NOTE_WRITE` and the old
    file's `NOTE_DELETE` in one batch in either order; diffing first found
    the path still in the tree, then the delete dropped it, so the new file
    was never watched and every later rewrite of it went unheard (measured:
    rounds 2–5 of five rename-overs reported nothing). Now each rewrite
    reports the path (a `delete` and a `create` may land in successive
    batches);
  - a watcher has a **depth** (`opts.depth`, `Watcher::mMaxDepth`: 1 is the
    dir's own entries, absent no limit), part of its identity like its
    ignore. `isIgnored` drops what is deeper; `readTree` never descends into
    a folder at the depth (`FTS_SKIP` after adding it as an entry), and
    `compareDir` never lists one (`seesBelow`). An ignore regex could say
    the same paths but not that a folder needs no listing: fts read every
    entry folder and stat'ed all it held, then dropped it, under the
    backend's lock — 37 s for the children watch of a folder of 44 entries
    holding 690k below them, while every other subscribe and unsubscribe of
    the process (each on a Bun worker-pool thread) waited; and a write in an
    entry folder stat'ed its listing into a tree that wanted none of it. The
    engine's kqueue children watch passes `depth: 1`;
  - `childPrefix` (`DirTree.hh`): the prefix below a path is `path + "/"`
    except for `/` itself (upstream built `//`, so a watch of `/` ignored
    nothing and its diff named entries `//bin`).
- **`src/macos/FSEventsBackend.cc`** (the FSEvents backend, upstream code
  otherwise):
  - `unsubscribe` stops its stream ON the run loop thread (a performed
    block, waited for), where every stream callback runs. A callback that sees
    its root deleted stops the stream itself, then clears `watcher->state`;
    that stop is an fseventsd RPC (seconds while it is stuck), and the batch
    naming the root is already delivered — so the engine's unsubscribe (it
    closes a watch whose root went at once) stopped and released the same
    stream a second time, from a pool thread, and wrote `watcher->state` from
    two threads: heap corruption, later a bus error in malloc
    (`FSEventsBackend::startStream`; 2026-11-09, twice, both while fseventsd
    was stuck). Reproduced with that stop delayed 300 ms
    (`scripts/stress-root-gone.ts`, malloc checks on: 2 crashes in 3 runs,
    0 in 2 undelayed); with the fix, 0 in 4 delayed runs;
  - the run loop holds a source that never fires, so its thread lives as long
    as the backend: `CFRunLoopRun` returns once the loop has no source, so
    upstream's thread exited when the last stream was unscheduled while the
    backend lived on — a stream scheduled later never delivered (and a
    performed block never ran);
  - `startStream` completes the state (tree, stream) before
    `FSEventStreamStart`: upstream set it after, so a first callback could
    read a null tree.
- **`src/Event.hh`** (every backend's event list): a path whose events net
  to created **and** deleted is dropped only if it is gone. One there now
  was replaced — git rewrites a file as unlink + create — and is reported as
  an `update`. Upstream dropped it whatever was on disk, and FSEvents'
  history replay (`getEventsSince`, the file-watcher journal) coalesces a
  rewrite that way: of 161 files a `git checkout` of this repo rewrote, 64–83
  were never named, and a reader catching up from a snapshot (the faceted
  index's checkpoint, the corpus index's boot catch-up) kept their old
  content (2026-11-14). Tested by `shared/journal.test.ts` in file-watcher
  (2,000 files, half rewritten by a checkout: upstream leaves 247 unnamed).
- **On darwin `index.js` loads `build/Release/watcher.node` and nothing
  else** (same patch). A missing file throws, naming the fix: it used to fall
  back to the prebuilt `@parcel/watcher-darwin-<arch>` package — upstream's
  unpatched code — without a word, whenever an install had dropped the link
  (it re-creates the package) and no build had put it back. On 2026-11-09 an `./equin test` of the file-watcher engine ran
  in a checkout an install had just unlinked: upstream's `start()` diffed a
  directory into `mFdToEntry` with no lock while a `subscribe` on a pool thread
  emplaced into it, the table's node list closed into a cycle, and the backend
  thread spun in its rehash for 31 h (sampled: `compareDir` → `watchDir` →
  `__hash_table::__rehash`; the 3-argument `compareDir` and the loaded
  `watcher-darwin-arm64/watcher.node` both upstream's), the JS thread waiting
  in `~KqueueBackend`. The patched build, checked against invariants over
  `mFdToEntry` / `mSubscriptions` / the trees after every batch, subscribe and
  unsubscribe, held them through the whole engine suite. Other platforms load
  the prebuild, as upstream does.
- **`parcel-watcher-addon`** (`deps/`, a `build` kind of `infra/deps`) compiles
  the patched source — twelve parallel `c++` compiles and a `-bundle` link,
  binding.gyp's darwin sources and defines — against `node-addon-api` (parcel's
  own dependency) and `node-api-headers` (this plugin's). Symbols hidden
  (`-fvisibility=hidden -fvisibility-inlines-hidden`, as node-gyp builds): it
  exports only its Node-API entry points. One process can hold it and the
  prebuild at once (a test run over the engine and this plugin, in a checkout
  never linked), and with default visibility dyld bound one image's async work
  to the other's weak `PromiseRunner::onExecute`. A subscribe that failed there
  aborted the process (SIGABRT ← `__cxa_rethrow` ← `SubscribeRunner::execute`,
  five test processes on 2026-11-09) instead of rejecting. Identity: the patch,
  the declaration, this `package.json`, `$CXX --version`. ~20 s of CPU, once
  per machine per identity. No host admission: it is awaited inside `build`,
  which holds its grant. It refuses unpatched source (a `node_modules` from
  before the patch) rather than ship upstream's leak under its name.
- **Every install links it** (`provision/`, run by the root `postinstall` on
  every `bun install`: `./equin install` in a new worktree, the CLI
  bootstrap's `ensureDeps`, a hand-typed one). An install that re-creates the
  package (a patch or version change, a fresh checkout) drops
  `build/Release/`, so the addon must come back in the same step — it exists
  wherever the package does, and a missing one is a real bug. The provision
  runs `scripts/link-addon.ts` in a child: linking ensures the deps-engine
  dependency (a `cli` concern), which a provision may not import, and the bare
  script takes no install lock (no deadlock on the one `ensureDeps` holds).
  The same script, run with `./equin run`, is the recovery the `index.js`
  error names.

  Not a per-command call: the first fix (0e701ee320) linked it from
  `./equin test` / `./equin run`, a list that missed every other process
  loading the watcher — `./equin await`, and a hand-run `./equin build`
  itself, whose parent follows its child's transcript with the watcher
  (`runAttached`) before the child relinks. From 16:29 to the follow-up on
  2026-11-10, every checkout that reinstalled (the patch change made each one
  reinstall) could not build at all.
- **`linkParcelWatcherAddon`** (`cli/`): what the script runs, and what
  `./equin build` runs again right after its install (stage 1), as this
  plugin's `dependencies` build step (`build-step/`) — refreshing an
  addon whose identity moved without the package being re-created (this
  plugin's declaration or `package.json`, `$CXX`). It ensures the dependency and copies it
  (clone + rename, atomic) into the checkout's
  `@parcel/watcher/build/Release/`. Every build does it: an install that
  re-creates the package drops the copy. A copy, not a symlink, so the deps
  sweep removing an old identity cannot leave a checkout loading nothing. A
  failed compile fails the build.

- **Release bundles** (`bundle: { optional }`, `targets`: darwin, either
  arch — clang's `-arch` from the target, one macOS SDK; `-mmacosx-version-min=11.0`,
  upstream's floor, else the build host's SDK version is stamped and an older
  Mac refuses to load it): `./equin release`
  seals it for a darwin target like any `bundle` dependency, and vendors the
  sealed file as the bundle's `parcel-watcher/watcher.node` (what the launcher
  points `EQUIN_PARCEL_WATCHER_NODE` at). A linux target leaves it out, recorded
  in `deps.sealed.json` with why, and vendors upstream's prebuild. A failed
  compile fails a darwin release; a declaration that lost `bundle` fails every
  one, rather than ship the leaking prebuild silently.

Not covered: Linux runs
inotify, which this does not touch. When upstream ships a fix: bump, then drop the
patch, this plugin and its call in `build` (Backlog page entry).

Test: `deps/internal/parcel-addon.test.ts` loads the built addon directly and
counts `/dev/fd` — 40 followed files gone, a watched directory renamed away
and one deleted, a path two nested watches hold — and checks the events a
removed directory and one recreated in its place report. A folder renamed away from an
outer watch leaves the watches rooted below it whole (the patch before: their
unsubscribe left 9 descriptors open), and once the path is re-created the
inner watch's stale root going leaves the outer watch's new folder alone
(scoped by path, not descriptor: the outer lost it). Upstream fails the
three descriptor cases
(after the 40 followed files go it still holds 41–64 descriptors over the
baseline, varying run to run; patched: exactly 1, the directory's). In a child,
it loads the addon beside the prebuild in both orders: a failed subscribe
rejects (the default-visibility build aborted). A folder diff that cannot
watch a created entry (EMFILE, in a child) reports every create and the loss
(upstream: the creates after it, and no error); entries vanishing mid-diff
report none.
Measurements: [`research/2026-11-06-infra-parcel-kqueue-fd-leak.md`](../../../../../../research/2026-11-06-infra-parcel-kqueue-fd-leak.md).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: @parcel/watcher's native addon built from the repo's patched source (its kqueue backend closes the descriptor of a watched file that is deleted or renamed): the parcel-watcher-addon build dependency, and the step ./equin build runs to copy it into the checkout's @parcel/watcher when the installed bytes differ.
- Cli:
  - Uses: `infra/jobs/supervised-job.cliExecContext`
  - Exports (values): `linkParcelWatcherAddon`
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps.DepTarget`
    - `infra/deps/build.build`
  - Exports (values):
    - `parcelWatcherAddon`
    - `parcelWatcherPackageDir`
- Cross-plugin:
  - Imported by: `framework/cli/release`

<!-- AUTOGENERATED:END -->
