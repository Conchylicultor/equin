# equin's FSEvents streams: where the registrations come from, and one stream per watched root

Task: task-1794190734-vy7zh3 (supervisor task-1793965642-94fdhj). Follows
research/2026-11-09-global-fseventsd-stuck-state.md ("registrations rose from
~2k/h to ~9k/h after 9b06a6dcc5, one stream per children watch").

## Layers

Measured 2026-11-09 02:00–03:40 CET with fseventsd stuck (100 % CPU, 8.3 GB
RSS). Registrations are the unified log's `fsevent_add_client` lines
(non-bundle processes only — every equin process), counted per pid and mapped
to commands by `ps` while they lived.

### 1. The 9k/h hour was a burst of test processes, not a new steady rate

| hour (CET) | registrations | pids | from pids with 31–99 each |
|---|---|---|---|
| 17 | 3,031 | 417 | 870 (16 pids) |
| **18** | **8,755** | 808 | **4,291 (100 pids)** |
| 19 | 3,716 | 742 | 539 (14 pids) |
| 20 | 2,707 | 567 | 277 (8 pids) |
| 02 (11-09) | 1,629 | | |
| 03 (11-09) | 2,504 | 97 | 2,039 from 6 pids at 300–500 each |

The 18h excess is 100 short-lived processes registering ~43 streams each,
all between 18:06 and 18:20 CET — the window in which 9b06a6dcc5 (pushed
18:17 CET) ran its engine tests and side-by-side churn measurements, which
open dozens of streams per run. The 03h excess is the same shape: 4 processes
at exactly 300 or 500 (stream experiments, e.g. the stuck-state doc's "500
streams opened then SIGKILLed"). Outside such bursts the rate is 2.5–3.7k/h,
as before the commit.

### 2. The steady rate is short-lived processes, not the servers

Every hour has ~400 pids registering 3–5 streams each (~1.6–2.1k/h), the
same before and after 9b06a6dcc5 (17h: 234 such pids). A 10-minute
attribution sample (03:40 CET, `log stream` + `ps` while each pid lived):

| process | registrations | pids |
|---|---|---|
| worktree / main servers | 94 | 4 |
| `./equin test` | 84 | 11 (mostly this task's own runs) |
| Claude Code's own binary (agent SDK) | 78 | 16 — not equin code |
| `./equin run` | 24 | 1 (this task's measurement script) |
| `./equin check` / `await` / `supervised-exec` / SDK agent | 26 | 19 |
| **total** | **310 (≈1.9k/h)** | 52 |

Servers (one pid each, whole hour): main 72/h; a worktree whose agent drives
its file explorer 300–720/h (its profile: `start:files.computer.list` ×40,
`start:files.computer.peek`, page loads re-subscribing `runtime-sdk.claude-usage`
/ `claude-accounts` / `agent-processes` ×19); an idle worktree ~0–120/h.

### 3. Did 9b06a6dcc5 raise a server's registrations? No — it halved them

Before it, every children watch of a process was one Bun `fs.watch` on ONE
shared FSEvents stream that Bun restarted (a new registration) on every open
AND every close: 2 registrations per watch lifecycle. Since, a children watch
is its own parcel stream: 1 registration per lifecycle. What did grow is the
number of streams a process holds at once: 1 shared → one per children dir.

### 4. Streams held at steady state (main, 03:22)

From Debug → Background activity (each declaration's open instances):

| declaration | FSEvents instances |
|---|---|
| file-watcher.dirs (hub recursive roots) | 11 |
| file-watcher.dir-entries (hub children) | 14 |
| sonata-midi-folders.folders | 2 |
| 11 single-instance watchers (corpus-index, transcripts, op-log, sentinel, plugins-dir, prototypes, git refs, agent-browser status, fs-latency log, config files, outbox, model catalog) | 12 |
| **total** | **~39 streams** |

kqueue follows (transcripts 43, daemon pid files 27, SDK events 25) are not
FSEvents. Which could share one:

- children dirs under an open recursive stream of ANOTHER declaration:
  `~/__A__/midi/{beethoven,chopin,lessons}` and `~/__A__/midi` itself under
  sonata's `~/__A__/midi`; `locks/sdk-agents/<main namespace>` under the hub root
  `locks/sdk-agents` (opened first, so the hub never moved it); a checkout
  watched as both a root and a children dir;
- the same root under two declarations: `~/.claude/projects` (corpus-index
  and transcripts), `.git/refs` (git-watcher and a hub root) — parcel already
  shares these when their ignore is identical.

### 5. Named-file watches that belong on kqueue (not changed here)

FSEvents watches whose consumer reads KNOWN files: `sentinel.status` (status,
vitals, latch files), `mcp-browser.host-status` and `browser-engine.host-status`
(one status file each), `io-health.fs-latency-log` (one appended log — a
children watch today), `model-provider.catalog` (one file),
`google-maps.browser-config` (one file), and host-fs's `watchEntryOver` (one
entry, through a children watch of its folder). Each is a `writesWhileOpen`
follow candidate (kqueue: 0–2 ms against FSEvents' 3–14 s at load). Filed as
a follow-up rather than moved here: each changes its owner plugin.

### 6. The cost of one stream while fseventsd is stuck

The worktree's `file-watcher.dir-entries:stop` spans: 238 in 16 min, avg 5.2 s,
max 31 s — the `FSEventStreamStop` RPC queued behind fseventsd. Off the JS
thread (parcel's worker), but each is a stream fseventsd matches every
event against until it lands.

## The change: one stream per watched root

`shared/fsevents-pool.ts`: on macOS every FSEvents watch with no `ignore`
— any declaration, either depth — rides the process's pool. A dir at or
below an open (or opening) recursive stream rides it (events filtered in JS);
otherwise it opens a stream of its own dir that later watches below ride.
Joining a started stream is live at once, so 9b06a6dcc5's guarantee holds
(engine test: 10/10 writes made right after arming heard; a write right after
a ride is heard with no stream opened). Riders never move: closing a lower
stream would drop what fseventsd queued for it and not delivered yet. A
rider's dir going is checked per rider (its inode, on an event naming it or a
folder between it and the root); the root going closes the stream at once.

### Before → after

`scripts/measure-stream-pool.ts --set <file>` opens a watch set in one
process; the set measured is main's (§4, in boot order: the 14 singleton
watches, the 5 hub roots still there, then the 10 hub children dirs — 29
that exist), written as `[{ "dir", "depth"?, "ignore"? }]`:

| | streams |
|---|---|
| watches | 29 |
| before: one per distinct dir+depth+ignore | 27 |
| **after** | **22** (20 pooled + 2 with an ignore) |

Per-watch delivery latency (`watch-delivery`: a write → its batch arriving,
30 writes each, 1/s, fseventsd stuck):

| children watch | p50 | p90 | max | missed |
|---|---|---|---|---|
| its own stream | 8.9 s | 15.1 s | 16.9 s | 0/30 |
| riding a covering recursive stream | 7.9 s | 14.0 s | 16.7 s | 0/30 |

The lag is fseventsd's queue, the same for every stream: riding costs none.

Independent review (Sonnet subagent, code only): no correctness bug. Noted
behaviour changes, accepted: a watch riding an already-started stream can
hear a change made shortly before it started (fseventsd's queued events —
a spurious "look", which every consumer treats as one); a native drop is
reported to every rider of the stream; a ride joining a stream whose root
has just been replaced hears its dir gone at once (it re-arms).

## What the pool does not change

- **The steady registration rate** is set by short-lived processes and by
  watches of dirs nothing covers (a file explorer listing arbitrary folders).
  A stream per distinct uncovered dir is already the minimum without a native
  multi-path stream (FSEvents takes several paths per stream, but a stream's
  paths are fixed at creation — adding one is a re-registration).
- **`/` and `~` children watches** (main's file explorer): a stream is
  delivered every event under its path, so these two receive every event of
  the machine (parcel drops the deeper ones before stat'ing). That is the
  largest per-stream cost equin puts on fseventsd; a children watch heard
  without FSEvents (a kqueue `EVFILT_VNODE` on the dir's own descriptor
  hears entries come and go, not an entry's writes) would remove it.
- **The hub's absorb hand-over** (`dir-hub.ts`, `absorbBelow`) still releases
  a lower root's watch once a root above it opens — the drop-what-is-queued
  window the pool avoids. Pre-existing, not touched here.
