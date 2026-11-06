# No synchronous fs on a backend's JS thread

Part of the responsiveness audit (task-1793965642-94fdhj). Task: task-1793967473-uhsqfx.

## Problem

A synchronous fs call holds a backend's one JS thread until the disk answers.
On a busy disk that is seconds, and every request, live read, job and timer of
the process waits behind it — so each stall also shows up as a cluster of
"slow" DB ops of the same duration (they were all waiting on the thread).

Main, 7 days to 2026-11-06 (`reports`, kind `event-loop-stall`): 21 reports /
76 occurrences; 16 of the 21 reports (≈40 occurrences) were a sync fs call,
3–13.6 s each:

| stalled in | reports × count | longest |
|---|---|---|
| `renameSync ← writeAtomic` (shell/document-head publish) | 1 × 8 | 4.5 s |
| `openSync` / `readSync ← readTail` (log-files persist, via readBootEvents) | 3 × 14 | 7.0 s |
| `resolveSync ← resolvePlaywright` (deps/playwright-browser) | 1 × 3 | 4.4 s |
| `statSync ← fileStamp` (config_v2 file-store) | 1 × 1 | 13.6 s |
| `renameSync ← cloneNamedBinary` (process-name) | 2 × 2 | 4.3 s |
| `openSync ← openOwnedFd` (owned-fd, core) | 1 × 1 | 5.1 s |
| `readFileSync` / `realpathSync ← checkout-deploys` (paths, core) | 2 × 2 | 3.3 s |
| timed-fs `readFileSync` / `readdirSync` / `statSync` / `realpathSync` (caller hidden behind the wrapper frame) | 7 × 10 | 4.9 s |

Plus `runtime-sdk.agent-processes`: every pid-file change anywhere re-read all
~113 namespace dirs (readdir + a read per pid file, twice per agent)
synchronously, in every backend — 2+ s of self time per recount.

`user-path/no-sync-fs` only refused a sync call on a path the user chose (the
macOS permission prompt), so all of these passed.

## Fix (rung 3: a lint, plus the migration)

- `blocking-fs/no-sync-fs` (`plugins/infra/plugins/host-fs/plugins/blocking-fs`,
  type-aware): no `node:fs` `*Sync` (timed-fs twins included — they carry
  node's declaration), `Bun.resolveSync`, or sync glob scan in a plugin's
  `server/`, `machine/`, `central/` or `deps/` folder. Legitimate homes are
  declared `sanctioned` in the owning plugin's `exempt/index.ts` (own process,
  sync exit path, pre-listen boot); a call behind a sync API that needs a
  redesign is `debt` naming task-1793970457-7rrcc4.
- timed-fs gains `exists(path)`, `existsSync`'s async twin (throws on anything
  but ENOENT/ENOTDIR).
- Inventory: 503 call sites in 124 files before → 0 unexempted after; 9
  exempted files remain (`./equin exempt list --rule blocking-fs/no-sync-fs`):
  5 sanctioned (boot-events' pre-import boot mark, paging-probe's child entry,
  the release launcher's asset seed, the op CLI's worktree-op marker,
  signal-origin's test fixture child) and 4 debt (duress latch's sync
  `isUnderDuress()` gate, login-services' sync label binding, the daemon's
  pid-file getters, reports' crash append also used by surviving callers).
- Notable migrations: config_v2's store async end to end (per-document lock;
  `getConfig` stays a sync cache read), secrets central, deps / codesign,
  launcher boot + login services, process-name clones, host-semaphore, jobs
  exit-latch + supervised-job tails, sentinel status files, runtime-sdk's
  event reader / agent process, the model catalog (loaded in `onReadyBlocking`,
  re-read on change).
- `agent-processes`: per-namespace reads held while watched; a pid-file event
  re-reads only its namespace (O(changed namespaces)); liveness (signal 0, no
  disk) is checked at count time; a lost watch or an unwatched read re-reads all.
- log-files: one async read API (`readTail`, `readChannelEntries`,
  `readChannelJson`); the sync twins are gone.
- playwright-browser: an async `node_modules` walk with `realpath` replaces
  `Bun.resolveSync` (Bun documents `Bun.resolve` as the same synchronous work);
  `playwright-core`'s `exports` map names the registry bundle. Verified equal
  to `Bun.resolveSync` on the real tree.

## Not covered (follow-ups)

- `core/` / `shared/` helpers called from a backend (`owned-fd`,
  `paths/checkout-deploys`, `file-sink`'s sync `readTail`): `core/` also serves
  the CLI and checks, so the folder cannot say which thread runs it.
- `spawnSync` / `execSync` on a backend (`agent-process.ts`'s `ps` / `pgrep`).
- The check thread: `check-thread-safety/no-blocking-check-work` already owns
  it; build speed is task-1793964742-k0g8vg's.
