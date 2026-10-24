# Supervised runs: publish transcript output live, not at exit

## Context

A detached supervised run (build, release, backup, deploy, any `defineSupervisedJob` `run` body)
writes its output to `runs/<kind>-<runId>.log` as it goes. But nothing reaches the kind's log
channel until the run ends. Then every line arrives at once, all with the same timestamp. So no
long run shows live progress.

This was observed on 2026-09-16 with `events-test.detached-sleep`. The transcript grew every 5 s,
while `logs/events-test-detached-sleep.jsonl` stayed empty until the end and then got all 62 lines
at once.

## Root cause (confirmed by experiment)

The tail itself works. What is missing is anything telling it to read.

- The supervisor (`supervised-job/server/internal/run/supervisor.ts`) calls `tail.pump()` only
  from its one `@parcel/watcher` subscription on the runs directory (`onArtifactEvents`). Nothing
  else ever pumps a live run: the 60 s reconcile tick settles runs but does not pump them.
- On macOS, `@parcel/watcher` uses the **FSEvents** backend by default. FSEvents reports a file's
  content change **when the writing process closes its descriptor**, not on each `write(2)`.
- The detached child gets the transcript as its stdout/stderr descriptor and keeps it open for the
  whole run. So the only events are a `create` at spawn and an `update` when the child exits. That
  exit event triggers the one pump, which publishes everything at once.

Experiments run in this worktree (a `sh` writer keeps one descriptor open and appends a line every
1 s):

| Watcher | What it reported |
|---|---|
| parcel, default backend (FSEvents) | `create` at 26 ms, then nothing until `update` at close (5.4 s) |
| Bun `fs.watch` on the file and on the directory | same: one event at open, one at close |
| parcel, `backend: "kqueue"` | `create`, then an `update` at ~1.1 s, ~2.3 s and ~3.4 s, one per write |

Linux (inotify `IN_MODIFY`) fires on every write, so this is a macOS-only failure. It is
pre-existing and happens on every run kind.

## Fix

Make "tell me about writes to a file another process still has open" something the file-watcher
primitive can be asked for directly, and have the supervisor ask for it.

### 1. `infra/file-watcher`: an option that says what the caller needs

In `plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts`, add to
`FileWatcherBaseOptions`:

```ts
/**
 * Report every append to a file another process holds open, not only its close.
 * macOS FSEvents (parcel's default there) reports content changes at close(2), so a
 * long-lived writer (a detached child's stdout fd) produces no events until it exits.
 * `true` selects parcel's kqueue backend on darwin (EVFILT_VNODE fires per write);
 * other platforms' default backend (inotify) already does, so it is a no-op there.
 * Cost: kqueue holds one descriptor per file under the watched dirs, so use it only on
 * small directories with a known bound.
 */
writesWhileOpen?: boolean;
```

In the subscribe loop, pass `{ ...parcelOptions, backend: "kqueue" }` when
`writesWhileOpen && process.platform === "darwin"`.

Why an option named for the need, and not a raw `backend` passthrough: the caller states what it
needs, and the primitive picks the platform backend for it. kqueue cannot become the default,
because the repo-wide watchers (git-watcher, corpus-index) would then hold a descriptor for every
file they watch.

**Loud guard for the descriptor cost:** when `writesWhileOpen` resolves to kqueue, count the
entries under each watched dir before subscribing. Throw above a fixed ceiling (e.g. 5 000) with a
message naming the dir. That way the option can never be pointed at a large tree without failing
right away.

### 2. `supervised-job` supervisor: ask for it

In `syncWatcher()` (`supervisor.ts`), pass `writesWhileOpen: true` to `createFileWatcher`.

The runs directory is flat and bounded by `pruneWorktreeRunArtifacts`: 50 runs × 2 files per kind,
per worktree. Main's has 359 entries today. The watcher, and so those descriptors, exists only
while at least one run is live.

The FSEvents debounce and ceiling (100 ms and 1 s) stay as they are. Under continuous output they
now give at most about one pump per second. The exit-marker path is unchanged, since the marker is
created by `rename`, which both backends report.

Also correct the comments that describe the old assumption:
- `tail.ts`: "The cost is the watcher's ~100 ms debounce".
- `supervisor.ts`: the watcher comments in `syncWatcher`. State why kqueue is needed.

### 3. Tests (regression-proof at the level where it broke)

- **file-watcher** (new `create-file-watcher.test.ts`): with `writesWhileOpen: true`, spawn a
  `sh` that holds one descriptor open and appends 3 lines 300 ms apart. Assert that `onChange`
  fires at least twice **before** the writer exits. On darwin this is exactly the experiment above.
- **supervisor** (`supervisor.test.ts`, which already spawns real runs): start a run whose argv
  prints a line and then sleeps about 3 s. Assert the kind's channel received that line while the
  run is still unfinished (no exit marker yet). This test fails on today's code on macOS.

## Critical files

- `plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts`: the new option,
  backend selection, and the size guard.
- `plugins/infra/plugins/jobs/plugins/supervised-job/server/internal/run/supervisor.ts`:
  `syncWatcher` opts in; comments.
- `plugins/infra/plugins/jobs/plugins/supervised-job/server/internal/run/tail.ts`: doc comment
  only.
- Tests next to both files. Run `./equin build` to regenerate the file-watcher CLAUDE.md
  reference block.

## Verification

1. `./equin test plugins/infra/plugins/file-watcher plugins/infra/plugins/jobs/plugins/supervised-job`
2. `./equin build` in the background, then check that `build-status.json` says `ok`.
3. On the worktree deploy, `POST /api/events-test/detached-sleep` with `{"seconds":30}`. Tail
   `~/.singularity/worktrees/<wt>/logs/events-test-detached-sleep.jsonl`. A line should appear
   about every 5 s, each with its own `t`, rather than all 7 at the end.
4. Optional: watch a real `./equin build` triggered from the toolbar and check that its log
   scrolls live.

## Out of scope / follow-up to flag

Any other FSEvents consumer that watches a file appended to through a descriptor that stays open
has the same blind spot. It is worth a quick audit of the 13 `createFileWatcher` callers after
this lands. This plan does not change them.
