# Paying down the blocking-fs/sync-named debt

Part of the responsiveness audit (task-1793965642-94fdhj). Task: task-1793991095-ppkf09.
Follows research/2026-11-08-global-no-sync-fs-debt-paydown.md (the `no-sync-fs`
half), which left this rule's 20 `debt` exemptions untouched.

## Before → after

20 debt exemptions (11 plugins) → 11 (4 plugins, 3 of them single-cause). Measured by
`./equin exempt list --rule blocking-fs/sync-named --debt`; the survey behind
it was the lint's own output with every debt entry removed: 60 blocking
functions without the `*Sync` name.

What mattered most for cost, not for the count: **`DataDir.ensure()`** ran a
`statSync` + `mkdirSync` on EVERY call, from ~40 backend call sites (every
attachment write, every outbox / sentinel / catalog watch start, every
thumbnail, every rewind backup, every deps state read …). It is the only item
here whose blocking work repeated in steady state; the data-root and
`movedFrom` reads are once per process (memoized).

## DataDir.ensure() is asynchronous

- `ensure(): Promise<AppPath>` — `fs/promises` `mkdir -p` first (one syscall
  on an existing dir), and only when it fails with `EEXIST` / `ENOTDIR` a
  `stat` to explain a FILE squatting on the name (the same "is NOT a
  directory" error as before). The method is `async`, so a split copy or any
  other resolution error is a rejection, never a synchronous throw from a
  Promise-returning call.
- `ensureSync(): AppPath` — the old body, for a process that may block (CLI,
  check, `bin/` entry before it serves, a fatal-exit writer). Named `*Sync`,
  so `blocking-fs/no-sync-fs` refuses it on a backend like any other.
- Callers: backends `await` it (~40 sites, a few functions turned async: the
  rewind handler, the cargo updater's smoke list, `defaultStore` / `uvEnv` /
  `crateTargetDir` in `infra/deps`); CLI / check / bin call `ensureSync`.
  Structural interfaces copying the shape (`GateDir`, `PassSetDir`) take
  `ensureSync` — both are tool-only.
- **Why per call, not once per process (considered and rejected).** Measured
  on the host (quiet disk, `fs/promises`): `mkdir -p` of an existing dir
  **~14 µs** per call, off the JS thread — against **~260 µs** for the
  write + rename it precedes (≈5 % of the write path), and against the old
  `mkdirSync` at ~4 µs ON the thread, the call that stalls for seconds when the
  disk is loaded. Memoizing "exists" per process (at boot or on first use)
  would make later calls free, but a directory removed underneath a running
  process (`cache/` is "rebuilt on demand, `rm -rf` costs nothing"; `locks/`
  is reclaimable; a person cleaning up) would then fail the next write with
  ENOENT. Recreating "when something reports it missing" means every one of the
  ~40 write sites catching ENOENT and retrying — or the DataDir owning the
  writes themselves (a `write(file, bytes)` that mkdirs and retries on
  ENOENT). That is the structural version and the right next step if the 14 µs
  ever shows up in a profile; it is not today's cost (no ensure appears in the
  stall reports — those named the sync calls, which are now gone).
- The gateway's launch flags no longer mkdir: `gatewayLaunchFlags` is pure
  (`.path`), and `gatewayLaunchSpec` — which only the launcher's own process
  runs — ensures the dirs (`ensureSync`, inside `boot.ts`'s sanctioned
  launcher-only exemption). The health report's drift row derives the flags in
  main's backend and used to create three directories on every read.

## The rest, by kind

- **Async end to end** — `ticket-line` (`join`, `leave(): Promise<void>`
  memoized so a second call is the first, `isEmpty(): Promise<boolean>`;
  callers host-semaphore and the CLI admission valve await it);
  `paths` `checkoutRef` / `actAsCheckoutNamespace` (main-spec owner read,
  comparable path and the owner stamp, whose sync forms had no other caller,
  are now async); run-ledger `readBuildTerminal`; browser-recordings
  `pruneRuns` (`openOwnedFd`); the mise updater's soundness read and lock
  write, and `mise()` through a new `miseBin()` twin.
- **Take the data, not the reader** — config_v2's `CommittedFiles` is a lookup
  over files already read (`read` / `appIds`). The lazy disk-backed
  `committedFilesIn` became `readCommittedFilesSync(dir, fs)`, which reads the
  whole committed `config/` once (735 files, 2.9 MB) for the tool processes
  that resolve every document in one pass (codegen's propagation, the
  plugin-move ledger); the desktop's repo layer already read one document's
  files async into a map. Same for `config_v2/disk-read`: one pure resolve over
  the four documents, read async (`readEffectiveConfigFromDisk`, the backend's
  serve-composition reset) or sync (`readEffectiveConfigFromDiskSync`, the
  build's target resolver). The writable sync `fileConfigProxy` moved to
  codegen, its only user (tool-only, sanctioned with the rest of codegen core).
- **Dead** — signal-origin's `readSignalOriginLines` had no caller; removed,
  and the fixture-testable policy is async like its one reader.

## Left (11 debt entries, task-1793991095-ppkf09 → follow-ups)

- **paths `dataRoot()` / `worktreesDir()`** (`data-dir.ts`, `paths.ts`): the
  home layout (2 lstat + ≤ 2 realpath) is read once per process and memoized;
  `movedFrom` inspection likewise once settled. Not a recurring cost. Making
  the name honest needs the root decided before any read in EVERY realm (CLI,
  tests, scripts, workers, hooks), or a top-level await in paths core — rejected:
  drizzle-kit `require()`s schema files (`schema-files-loadable`) and paths core
  sits in many import cycles (a TLA suspends a module mid-evaluation: TDZ).
- **guards** (6 files): backends load guards core only for two constants
  (`TOOL_USE_ID_RE`, `BYPASS_TOKENS`), but the barrel pulls the whole guard
  registry. Cut the reach (constants in a leaf; bypass tokens as declared data
  checked against the registry) and the files become `sanctioned`, held there
  by `blocking-fs:sync-named-reach`.
- **source-digest `walkClosure`**: `Bun.resolveSync` per import while
  digesting a closure on a backend. Needs an async resolver (async `realpath`
  walk of `node_modules`, tsconfig `@plugins/*` paths) or the walk off the
  thread.
- **faceted `readOutside`**: a synchronous member of the plugin-records keying
  input, read deep in the module graph; going async ripples through
  plugin-records' keying.
