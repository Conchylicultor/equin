# timed-fs

The file reads every non-browser process makes, timed, so a stalled disk
names itself instead of reading as the caller's own work. On 2026-11-03 a
12 s `Bun.Glob` scan inside a live read, an 11 s gap in main's boot and a
127 s `readdirSync` in a check were each recorded as the slow operation's
own time, and each needed a manual investigation to blame the filesystem.

- **Same names, same types.** `readFile` / `readdir` / `stat` / `lstat` /
  `access` / `realpath` / `readlink` (the `node:fs/promises` ones), their
  `*Sync` twins and `existsSync` are node's own calls, typed `typeof
  fs.<name>`. Moving an import here changes nothing but the timing, and
  type-aware rules keyed on node's declarations (`user-path/no-sync-fs`)
  still see node's signature.
- **Glob scans.** `scanGlob(pattern, arg)` / `scanGlobSync(pattern, arg)`
  stand for `new Bun.Glob(pattern).scan(arg)`. They sum the time spent
  inside the scan's own steps (not the caller's work between them) and hand
  it on once, when the iteration ends: done, broken out of, or thrown.
- **The wait.** Every call that takes at least `FS_WAIT_FLOOR_MS` (100 ms)
  goes to the `onSlowFsCall` subscribers under a wait layer from the closed
  `FS_WAIT_LAYERS` set: `fs-stat` (metadata: stat, lstat, access, exists,
  realpath, readlink), `fs-readdir`, `fs-read`, `fs-glob`. The subscriber
  runs synchronously as the call returns, still inside the caller's async
  context. A subscriber's own file calls are never dispatched back to it.
  Each call carries `concurrent`, the number of timed async calls in flight
  when it started (itself included). A large value means most of the wait was
  a queue: the call waited behind the process's own reads for one of libuv's
  few fs threads, rather than on one slow disk answer. The first recorded
  check showed this, with 17,089 readFiles of one pass, each about 2 s.
  - `debug/profiling/fs-wait` writes each one to the namespace's `fs-wait`
    log channel. A backend, an exec child and every CLI run (build, check,
    test) all write there.
- **The meter — a call while it runs.** `installFsWaitMeter(meter | null)`
  installs the one meter every call is metered by (each glob step its own
  call, sync calls too): `meter(layer)` runs synchronously as the call
  starts, in its caller's context, and the end it returns as the call
  returns, failed or not. A file call the meter's end itself makes is not
  metered again. runtime-profiler's server install meters each call as a
  `beginDeferredWait(layer, "io", FS_WAIT_FLOOR_MS)`: a call still running
  past the floor is shown as a wait in progress (so a read hung on a dead
  mount reads to the stuck-span watchdog as a wait on `fs-<op>`, not as its
  caller's own work), and one that reached the floor is charged as an `io`
  wait as it ends — the enclosing spans name it, and slow-ops files it as
  `wait fs-<op>`. It runs on every call, so it must cost next to nothing on a
  fast one: measured (`runtime-profiler/scripts/fs-meter-bench.ts`), the
  deferred wait is ~170 ns a call, against ~1.2–1.9 µs for an eager
  `beginWait` under three entries and 15–28 µs for an awaited `stat` (2 µs
  for a `statSync`). A glob is metered per step, like any call, so the
  profiler charges a step that reached the floor — not the sum of a scan's
  short steps (`onSlowFsCall` still gets the summed scan). A `Bun.Glob` async
  scan walks the whole tree in its first step (12,940 hits, 640 of 644 ms in
  step one), so for it the two agree; a scan of many short steps, like many
  short stats, charges nothing, which is the floor's meaning for every call.
- **Awaiting.** `installFsAwait(wrap)` sets how every awaited call (and every
  `scanGlob` step) is awaited. It is the identity until something installs
  one. A backend installs `whileWaiting` (`packages/semaphore`, from
  runtime-profiler's server install), so a live read stalled on the disk
  gives its read-admit slot back while the call is pending and takes it back
  at the head of the queue. `network/live/resource-runtime/scripts/fs-yield-bench.ts` measured it: behind
  six reads stalled 2 s, unrelated reads answered in 33–49 ms instead of
  ~2 s, and a herd of fs-heavy reads showed no thrash.
- **The call guard.** `installFsCallGuard(guard | null)` installs one guard
  every timed call (and glob scan) passes first, synchronously, before it
  touches the disk; a guard that throws refuses the call at the call site
  (an async call throws before any promise exists). barrel-import installs one
  while a barrel's modules evaluate, refusing a load-time read no record key
  names.
- **A leaf.** It imports node builtins only. Every process imports it,
  including the CLI bootstrap, file-sink and the profiler's own dependencies,
  so a `@plugins/*` import here would close a cycle. Subscribers are
  installed from outside.

## The lints

- `timed-fs/no-untimed-fs-read` (syntactic, autofix) reports a timed call
  that does not come from here: a named import from `node:fs` /
  `node:fs/promises`, or a member call on a namespace or default import of
  either (`fs.statSync`, `fsp.readdir`, `fs.promises.readFile`). The fix
  moves the import. When another binding already answers to the bare name,
  it aliases the import as `timed<Name>`. Out of scope: browser folders,
  tests, e2e and generated files.
- `timed-fs/no-untimed-glob-scan` (type-aware) reports `.scan` / `.scanSync`
  on a `Bun.Glob`.

Not covered: the callback forms, writes, `require("fs")`, `Bun.file()`
reads, and a `promises` object passed around as a value. Module resolution
(the boot's imports) is not covered either: server-core's `load` spans and
its boot journal attribute that.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The file reads, listings, stats and glob scans every non-browser process makes, timed: node:fs's read calls under their own names and types (readFile / readdir / stat / lstat / access / realpath / readlink and their *Sync twins, existsSync) plus scanGlob / scanGlobSync over a Bun.Glob, each call metered while it runs (installFsWaitMeter — the backend's profiler shows one past FS_WAIT_FLOOR_MS in progress and charges it) and, once it returns past the floor, handed to onSlowFsCall subscribers, under a named wait layer (fs-read / fs-readdir / fs-stat / fs-glob) — so a disk stall names itself instead of reading as the caller's own work. A leaf (node builtins only), enforced by the timed-fs/no-untimed-fs-read lint.
- Cross-plugin:
  - Imported by: 160 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra` ×46
    - `framework` ×24
    - `apps` ×15
    - `debug` ×14
    - `backup` ×12
    - `conversations` ×12
    - `database` ×5
    - `packages` ×5
    - `plugin-meta` ×5
    - `build` ×4
    - `config_v2` ×3
    - `primitives` ×3
    - `release` ×3
    - `integrations` ×2
    - `reports` ×2
    - `code-explorer`
    - `hints/ask`
    - `stats/cost`
    - `toolchain`
    - `ui/icons/icon-sets`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `core/internal/timed-fs.ts` (sanctioned)
    - `timed-fs/no-untimed-fs-read` — `core/internal/timed-fs.ts` (sanctioned)
  - Exempted by:
    - `framework/tooling/guards` (0 debt)
    - `infra/host/io-health/monitor` (0 debt)
    - `infra/runtime-profiler` (0 debt)
    - `packages/timed-fs` (0 debt)
- Core:
  - Exports (types):
    - `FsWaitLayer`
    - `SlowFsCall`
  - Exports (values):
    - `access`
    - `accessSync`
    - `exists`
    - `existsSync`
    - `FS_WAIT_FLOOR_MS`
    - `FS_WAIT_LAYERS`
    - `installFsAwait`
    - `installFsCallGuard`
    - `installFsWaitMeter`
    - `lstat`
    - `lstatSync`
    - `onSlowFsCall`
    - `readdir`
    - `readdirSync`
    - `readFile`
    - `readFileSync`
    - `readlink`
    - `readlinkSync`
    - `realpath`
    - `realpathSync`
    - `scanGlob`
    - `scanGlobSync`
    - `stat`
    - `statSync`
    - `TIMED_FS_CALLS`

<!-- AUTOGENERATED:END -->
