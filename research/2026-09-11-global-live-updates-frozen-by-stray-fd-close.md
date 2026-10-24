# Live updates frozen on main: a DB socket closed under a query (investigation)

Status: root chain proven; the code doing the stray close is **not found yet**.
Follow-up task: "Find the code that closes file handles twice" (filed 2026-09-11).

## Symptom (as the user saw it)

On `equin.localhost:9000`, Close / Drop & Close on a conversation, dropping a
task, closing a conversation from the sidebar — the click works but the screen never
changes. No error. Refreshing shows the change. Every DB-backed live update was
affected, not one button.

## What happened, in order

| Local time (CEST) | Evidence | Meaning |
|---|---|---|
| 11:53:18 | `boot.jsonl`, `change-feed.jsonl` "LISTEN live_state established" | main backend boots after a push |
| 11:56:54.0 | flight window: `flushNotifies` (id 10703) opens, child `push conversations-gone-stats` (id 10705) acquires a pool connection in 40 µs | a routine live-state flush starts; the push's loader is one `count()` over `conversations_v` |
| **11:56:54.283** | `~/.singularity/postgres/pgbouncer.log`: `C-0xb0a405ff8: singularity/singularity closing because: client unexpected eof (age=5s)` | the backend's end of that pooled socket was closed. No code path asked for it |
| 11:56:58.5 | report on `att-1789077797-6vi7`: `Runtime "tmux" list failed: EBADF: bad file descriptor, close` | a sibling backend hits the same class of fault 4 s later |
| 11:56:54 → now | flight window at 12:21:46: both spans still open, age 1,492 s; `pg_stat_activity` shows **no** active query for db `singularity` | the query never reached, or never came back from, Postgres. `pg` got no `error`/`end` event, so the promise never settles |
| 12:01:22 | `conversations` row `conv-1789119339-6q4h` `status=done`; client-side toast notification row written | the user's Drop & Close succeeded server-side |
| 12:13–12:15 | WS probe on main (subscribe to `conversations-active`, `conversations-gone`, `tasks`, `notifications` for 75 s): only `sub-ack` + pings; `live_state_changelog` shows 11 `conversations` updates + 1 `notifications` insert in that window | main pushes **nothing** for DB changes |
| 12:15 | same probe on a fresh worktree backend + one `POST /api/notifications` → `delta` in < 10 ms | the code path is healthy on a fresh process |

Version counters confirm it: from 11:58 to 12:08 every replay on main reported
`conversations-active`/`conversations-gone` at version 5 and `tasks`/`attempts`
at 4, through a closed conversation and a new task.

## The chain

1. **Something in main's process closed a file descriptor it did not own.** That
   fd number had been reused by a pooled `pg` socket carrying a query.
2. **`pg` never noticed.** A closed-underneath fd produces no `error`/`end` on
   macOS kqueue, and no pool or client sets `query_timeout`
   (`plugins/database/server/internal/client.ts` `pool()`: only `max` and
   `idleTimeoutMillis`). The query promise is pending forever.
3. **One stuck push freezes all pushes.** The stuck query is inside a
   `flushNotifies` cycle. Flushes run one at a time, so every later DB change is
   queued behind it. The DB side stays healthy the whole time: triggers fire,
   `live_state_changelog` fills, the change-feed `LISTEN` connection (pid 36786)
   is idle in `ClientRead` with notify-queue usage 0.
4. **Nothing alerted.** Slow-op reports fire when a span *completes*. A span that
   never completes files nothing. The browser only sees an ordinary quiet socket.
   Refresh "fixes" it because `sub-ack` runs the loader on a fresh HTTP/WS path.

## Why "a file handle closed twice"

A stray `close(n)` has two possible outcomes. The report shows up at the *second*
owner of `n` — the victim — never at the culprit:

- `n` is still free → the later legitimate close of `n` throws **EBADF**. The
  EBADF site is a *victim*.
- `n` was reused (by a socket, pipe, temp file) → that resource dies silently.
  Today's instance: a pgbouncer socket.

Victim sightings so far:

| When | Backend | Victim site |
|---|---|---|
| 2026-09-10 03:19 | main | `spawnCaptured` → `closeSync(outFd)` at `plugins/infra/plugins/spawn/core/internal/spawn-captured.ts:204` (edited-files revalidate via `runGit`). Its own temp-file stdout fd was already closed while the child ran |
| 2026-09-11 11:56:54 | main | pooled `pg` socket (pgbouncer `client unexpected eof`, mid-life, age 5 s) |
| 2026-09-11 11:56:58 | att-1789077797-6vi7 | tmux runtime `listPanes()` (raw `Bun.spawn` with piped stdio) |
| 2026-09-11 12:14:54 | main | another mid-life pgbouncer `client unexpected eof` (age 4 s). Left no stuck span (likely an idle pooled socket) |

To tell these apart from normal restarts: a backend restart produces a *burst* of
`unexpected eof` at the same millisecond (11:36:34, 11:44:57, 11:53:18). The
culprit's signature is a **single, mid-life** `unexpected eof` on a young socket.

## Suspects (ranked, none proven)

1. **Bun closing a numeric stdio fd it was handed.** The 09-10 victim is the
   strongest clue: `spawnCaptured` passes raw temp-file fds as `stdout`/`stderr`,
   and by the time it closed them, one was already closed. If Bun sometimes closes
   a passed fd itself (on exit, on finalization, or under concurrent spawns), then
   `spawnCaptured`'s own `closeSync` is the *second* close. That happens on every
   git call (edited-files, attempt-work, commits graph), constantly, on every
   backend. A single-spawn probe on Bun 1.3.13 did **not** reproduce it: the fds
   stayed open after spawn and after exit. So if it exists, it depends on
   concurrency, signals, or GC.
2. **Raw piped `Bun.spawn` in the tmux runtime.** `tmux-runtime.ts` is exempt
   file-wide from `spawn-safety/no-raw-bun-spawn` for its one streaming
   `load-buffer` call (`plugins/infra/plugins/spawn/lint/index.ts`). So
   `listPanes`, `capture-pane`, `has-session`, `send-keys` all use the piped-stdio
   path the rule exists to ban, on every poll tick. Bun's pipe teardown is the
   component with a known race (bun 1.3.13 exit-during-pull).
3. **Hand-managed fd lifecycles** (open/closeSync pairs that could run twice on an
   error or re-entrant path): `plugins/packages/plugins/host-semaphore/server/internal/host-semaphore.ts`
   (guard, probe, turnstile and slot fds — flock), `plugins/infra/plugins/host/plugins/host-admission/server/internal/pool.ts:42`,
   `plugins/infra/plugins/worktree/server/internal/worktree-op.ts:366`,
   `plugins/primitives/plugins/log-channels/server/internal/persist.ts:114`,
   `plugins/infra/plugins/file-sink/core/internal/read.ts:87`,
   `plugins/infra/plugins/jobs/plugins/supervised-run/server/internal/{tail,supervisor}.ts`.

## How to find it

- **Reproduce the victim, then bisect the culprit.** A stress harness in a
  throwaway process: N concurrent `spawnCaptured` calls (with and without
  `timeoutMs`, killed children, `mergeStderr`) while a sentinel set of fds
  (a few `pg` clients or plain sockets) is checked with `fstatSync` after every
  settle. Any sentinel dying = a stray close. Repeat with only `Bun.spawn` piped
  (tmux-style), then only host-semaphore acquire/release churn.
- **Trace closes in the live process.** On macOS: `sudo dtrace -n
  'syscall::close:entry /pid == $target/ { @[ustack()] = count(); }'` or
  `fs_usage -w -f filesys <pid> | grep close` around a spawn-heavy window, then
  look for a `close(n)` with no matching owner. dtruss needs SIP relaxed; a
  Bun-level fallback is to wrap `fs.closeSync` / `fs.close` in the backend and
  record `(fd, stack)` per call. A second close of the same number with no open in
  between names the culprit.
- **Correlate** each mid-life `client unexpected eof` (pgbouncer log) with the
  spawns that settled in the same ~100 ms (the runtime-profiler flight window
  keeps recently-completed spans with t0/t1).

## Separate hardening (designed separately)

These keep the *next* lost socket from freezing the app, whoever the culprit is.
They are the subject of the companion plan:

- a client-side query deadline on every pool, so a lost query fails, is reported,
  and its connection is destroyed rather than reused;
- a report + health-dot row when that happens (and when a live-state flush has
  been open too long), so it is visible without a human noticing stale screens.

## Recovering a frozen main today

Restart main's backend (any push to main does it). A browser refresh does not
help: the stuck flush lives in the server process.
