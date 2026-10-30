# The ~5.5 h server `sub` spans: a macOS permission prompt froze main's JS thread

Task: task-1793365699-xgweva (from the slow-op audit, task-1793316419-rup28z).

## Context

The 2026-10-29 slow-op audit found server `sub` spans on main with max ≈ 20,059 s.
It was assumed they spanned machine sleep, but Bun's profiler clock
(`performance.now()`) pauses while macOS sleeps. So the question was which
resources leave a span open that long, and why.

## Findings

**Every multi-hour server span on main is one event.** `slow_ops` holds ~40
`sub` operations whose max is 20,057–20,059 s (`config-v2.values`,
`attempt-work`, `edited-files`, `prototypes.list`, …), plus `loader
prototypes.history/statuses`, `bg op-store:boot-pass`, `push
claude-code-status`, `flush`, `deliver:*` and **`boot server-boot` =
20,065,807 ms**. Every one of them ended between 2026-10-11 19:42:51.7Z and
19:42:52.9Z. No other server span ever exceeded 30 min. The `sub` spans are
mostly `read-admit` / `read-coalesce` waits behind loaders that were themselves
stuck.

**It was not sleep.** pgbouncer logged its stats line every minute and
Postgres logged continuously from 16:08 to 21:42 CEST, so the machine was
awake. The process started at 14:08:33Z (`boot.jsonl`) and the spans closed at
19:42:52Z: exactly 20,058 s, matching the profiler's durations. (Separately
re-checked: Bun 1.4.4 does pause the clock across a clamshell sleep. On 10-29,
traces' `wallTime − atMs` jumps from 16:45 to 21:39 for one process.)

**Main's JS thread was frozen for 5.5 h, from 1 s after boot.**

- After `Worker connected…` at 16:08:34, main's stdout (gateway `singularity.log`)
  is silent until 21:42:51.
- No health samples were written during that time.
- The previous main process (started 16:06:36) froze the same way. The
  gateway killed it at 16:08:22 ("still not ready 1m30s after escalation").
- When the thread resumed, the 60 s query-deadline timer fired with
  `no reply in 20057100ms (bound 60000ms)`. A 60 s timer that fires after
  20,057 s means no JS ran in between.
- Two worktree backends froze and resumed in the same 20 ms, so the blocker was
  shared and outside the process.

Side effect: a Postgres backend serving one of the frozen processes was blocked
writing to a client that no longer read. It never absorbed a
`ProcSignalBarrier`, so ~16 test-DB `DROP DATABASE … WITH (FORCE)` calls waited
the whole 5.5 h (46,781 "still waiting for backend with PID …" lines).

**The blocker: a sync filesystem call into `~/Downloads`, a folder macOS's
privacy controls (TCC) gate.**

- main's Sonata `midi-folders` config watches `~/Downloads` (configured
  Sep 19).
- At boot, the watcher's first mount called
  `watchedDirsSync() → realpathSync(p)` (`folders/server/internal/reconcile.ts:38`
  at that commit).
- While macOS's "allow access to Downloads" consent prompt is pending, that
  syscall blocks until someone answers. A sync call therefore freezes the whole
  event loop.
- One answer (21:42, the user back at the machine) released all three backends
  at once.
- The same line shows up later as a 7.3 s `event-loop-stall` report on 10-25
  (`realpathSync ← reconcile.ts:38`), a prompt answered quickly. The 10-25 EPERM
  crash (`research/2026-10-25-apps-sonata-unreadable-midi-folder.md`) is the same
  folder after a *Don't allow*.

**Today's code still has the hazard.** `probeFolder` (`folder-status.ts`) is
`realpathSync` + `opendirSync`. It runs from the watcher's mount, every
reconcile, the live value's first read and Check again. Any change to the app
identity macOS attributes access to (a re-signed gateway, the `dev.equin`
app, …) brings the prompt back and freezes every backend.

**So the spans are not a measurement bug.** They measured a real, awake-time
freeze. The profiler and slow-op judging need no change.

## Fix: a folder probe never runs on the JS thread, and "macOS hasn't answered yet" is a state

`folders/server/internal/folder-status.ts`:

- `probeFolder` becomes async: `fs/promises` `realpath`, then `opendir` + `close`.
  A pending prompt now parks a thread-pool thread, not the event loop.
- Probes are deduplicated per path (`packages/inflight`'s `createInflight`). A
  folder whose prompt is pending holds one probe, however many re-checks arrive.
- `refreshFolderStatuses()` (now async) starts every folder's probe and waits at
  most `PROBE_ANSWER_MS` (1 s) for them. A folder still unanswered then is
  published as the new **`checking`** state, so it is not readable, not watched
  and not walked. That keeps a pending prompt from also wedging the corpus walk
  inside the heavy-read gate. When the answer lands, it is published.
  `onFolderStatusChange` already remounts the watcher and reconciles when the
  readable set changes, so the folder imports at once.
- Callers await the bounded refresh: the watcher's `reconfigure`, `reconcile`,
  and the recheck endpoint. No caller (span, warm-up, request) can stay open on
  the prompt.
- `folderStatuses()` (the live value's loader) serves the last statuses. Before
  the first probe it awaits that bounded first refresh.

`shared/status.ts`: `FolderStatusSchema` gains
`{ state: "checking", path, dir }`, documented as "the OS has not answered
yet; on macOS, a permission dialog may be waiting for you".

Web (`folder-copy.ts`, notice, settings): the exhaustive switches force a branch.
`checking` gets an hourglass glyph and the copy "macOS is asking whether equin
may open this folder — answer the dialog (it may be behind other windows)".
Check again stays available.

Tests: `folder-status.test.ts` moves to the async probe. It adds a test that a
probe still unanswered after the bound reads as `checking`, then flips to its
answer when it lands, using an injected probe.

## Follow-ups (filed, not done here)

- **A freeze that starts before the health sampler runs is never reported.** No
  `event-loop-stall` was filed for 5.5 h, and the boot-wedge watchdog saw a
  "ready" backend. A process can't report its own freeze. An outside observer
  (the gateway, or central) should notice a backend that stops answering, or
  stops emitting health samples.
- **The class is wider than this folder.** A sync `fs` call on a *user-chosen*
  path (`dirPathField` values, file-explorer roots) can freeze a backend the
  same way. A lint rule that flags `*Sync` fs calls whose path comes from a user
  config field would close the class.

## Verification

- `./equin test plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/folders`
- `./equin check`, `./equin build`
- In my build: Sonata library loads, folder statuses render (`ok` / `denied` for
  Downloads per this machine's grant), Check again answers.
