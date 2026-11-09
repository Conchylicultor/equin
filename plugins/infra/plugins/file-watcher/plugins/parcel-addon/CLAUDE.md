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
  - each batch is handled in two passes — every delete / rename first, then
    the writes and directory diffs. An atomic rewrite (write a sibling,
    rename it over the file) reports the folder's `NOTE_WRITE` and the old
    file's `NOTE_DELETE` in one batch in either order; diffing first found
    the path still in the tree, then the delete dropped it, so the new file
    was never watched and every later rewrite of it went unheard (measured:
    rounds 2–5 of five rename-overs reported nothing). Now each rewrite
    reports the path (a `delete` and a `create` may land in successive
    batches);
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
- **`index.js` loads `build/Release/watcher.node` first** (same patch), ahead
  of the prebuilt `@parcel/watcher-<platform>` package, which is upstream's
  unpatched code.
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
- **`linkParcelWatcherAddon`** (`cli/`): `./equin build` runs it right after
  its install (stage 1), on darwin. It ensures the dependency and copies it
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

Not covered: a checkout never built loads the upstream prebuild; Linux runs
inotify, which this does not touch. When upstream ships a fix: bump, then drop the
patch, this plugin and its call in `build` (Backlog page entry).

Test: `deps/internal/parcel-addon.test.ts` loads the built addon directly and
counts `/dev/fd` — 40 followed files gone, a watched directory renamed away
and one deleted, a path two nested watches hold — and checks the events a
removed directory and one recreated in its place report. Upstream fails the
three descriptor cases
(after the 40 followed files go it still holds 41–64 descriptors over the
baseline, varying run to run; patched: exactly 1, the directory's). In a child,
it loads the addon beside the prebuild in both orders: a failed subscribe
rejects (the default-visibility build aborted).
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
  - Imported by:
    - `framework/cli/build`
    - `framework/cli/release`

<!-- AUTOGENERATED:END -->
