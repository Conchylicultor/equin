# fseventsd pinned at one core since 2026-11-08 15:23Z, at any load

Task: task-1794189374 (responsiveness audit, supervisor task-1793965642-94fdhj).
Follows research/2026-11-09-global-watch-delivery-lag.md (every FSEvents watch
3–14 s late) and research/2026-11-08-global-fseventsd-event-volume.md.

No root: no `sample`, `lsof`, `vmmap` or `footprint` on fseventsd (pid 71649,
started ~2026-10-21). `/tmp/fseventsd-sample.txt` (decision D12) does not exist
yet. What follows is read from the user-level unified log, `ps`/`top`, the root
monitor's own past ticks and `fs_usage` captures, and experiments with my own
FSEvents clients.

## Layers

| layer | evidence | verdict |
|---|---|---|
| input volume | `fs_usage` (root monitor's 5 s captures): fseventsd reads 1–2.1 MB/s from `/dev/fsevents` healthy (11-05, 11-06), 2.8 MB/s at 11-08 16:39Z, **0.35 MB/s** at 11-09 01:02Z | not more input |
| its syscalls | lstat/s (path resolution per event): **14–21k/s healthy**, 2.2k/s 11-08 16:39Z, 2.5k/s 19:16Z, **1.3k/s 11-09 01:02Z** | 10–15× less work done, at full CPU |
| where the CPU goes | one thread at ~95 % (`ps -M`), user time, few syscalls | compute inside the daemon |
| its memory | `ps` RSS **8.5 GB**, `top` MEM **16 GB** (8.4 GB compressed), growing ~190 KB/s RSS. Healthy: 13 MB (after the 2026-10 restart, research/2026-10-11-global-endpoint-reads-onto-live.md) | accumulated state: ~0.7 GB/h × the ~11.5 h since onset |
| a client not draining | every long-lived FSEvents client that predates the onset (10 Claude CLI agents, their supervisors, Claude.app, Warp): `sample` shows each stream's run-loop thread idle in `mach_msg` receive, i.e. draining. No stopped (T) or zombie process | no |
| client leak | 500 streams opened then the process SIGKILLed: fseventsd's mach ports return to baseline (~900) within 10 s; RSS shows no step | no |
| stream count | unified log `fsevent_add_client` (non-bundle processes only): 28.5k registrations from 4,372 pids, 11-08 12:00 → 11-09 03:00 CET; 1–2.7k/h around the onset, 8.8k/h at 17Z–18Z (after 9b06a6dcc5, one stream per children watch). Live ports ~900–1,400 | registrations are reaped; rate rose after the onset, not before it |
| history replay | root monitor's `fseventsd_logs` held no old log 15:30–17:40Z while pinned. Replays did run later: photolibraryd's CacheDelete from marker 0x7658CF65 at 19:03Z (411 s, then 381 s), corecaptured from 0xDE32… at 23:54Z (95 s) | adds load at times; not the steady pin |

### The onset is the event id crossing 2^32

FSEvents event ids are one system-wide 64-bit counter. The root monitor's
`fseventsd_logs` holds the names (hex event ids) of the current log file at
times:

| tick (UTC) | log file | |
|---|---|---|
| 13:07:36 | `00000000fc6ac508` | |
| 15:28:58 | `00000001001735b3` | first name above 2^32 |
| 16:50:18 | `00000001010d6b8e` | 3.4k ids/s since the last |
| 17:27:54 | `0000000101ed5f56` | |
| 11-09 02:12:38 | `FSEventsGetCurrentEventId` = 0x108c2bad2 | 147M past 2^32 |

Back from 15:28:58 at 3.4–5k ids/s, the counter crossed 0x100000000 at
**15:21–15:24Z**. fseventsd's CPU: 4.8 % at 15:21:22Z, 59.6 % at 15:23:23Z, and
≥ 50 % in 1,123 of 1,126 ticks since. Before it, the same load (14k new
vnodes/s, load 30–65) drove it to 100 % in spikes that cleared within minutes.

That the two coincide is measured; that the crossing *causes* it is not —
there is no public report of such a bug (a single Apple forum post describes
fseventsd memory growth stalling at "a repeatable boundary" in event-table
cleanup). It fits everything above: a structure that is pruned by event id and
stops being pruned after the wrap would grow from that moment (RSS), and make
each event cost more as it grows (throughput falling from 2.2k to 1.3k
lstat/s over 9 h at a lower input rate) — a stuck state independent of load.

## What a restart will tell (D12)

- If the state is what was accumulated since the crossing, `killall fseventsd`
  clears it, and RSS starts again from ~13 MB. Since ids stay above 2^32, it
  will grow back at the same rate and the pin will return within hours.
- If the pin and growth do not return, the crossing was the trigger of a
  one-off state, and the restart is the fix.

The monitor now records what tells them apart: `daemon_procs.<daemon>.rss_mb`
and `fsevents_event_id` on every tick, beside `daemon_cpu` (and the
`watch-delivery:fs-events` slow op / ledger metric for the delivery side).

## Can equin prevent it

Not the cause. The id counter only increases; nothing equin does takes it back
below 2^32. What equin controls:

1. **Its own latency-sensitive watches off FSEvents.** Transcripts already
   follow their named files over kqueue (0–2 ms, measured beside the 3–14 s
   FSEvents delivery). Every remaining user-facing FSEvents watch is reported
   (`watch-delivery:fs-events`) — moving the rest that watch known files is the
   lever that makes equin indifferent to fseventsd's state.
2. **Its event volume.** equin generates most of the machine's file events
   (spare checkouts ~45k each, type-check store rewrites, installs, DB forks;
   2026-11-08 doc). Volume is what makes a slow per-event cost visible as
   latency, and what advances the id (~160M/day averaged 11-04 → 11-09; 3.3–3.7k ids/s, ~300M/day, on 11-08).
3. **Its streams.** Registrations rose from ~2k/h to ~9k/h after 9b06a6dcc5;
   they are reaped, so they do not explain the state, but they are work per
   event per stream.

## What landed

- The fs-latency monitor writes each watched daemon's resident size
  (`daemon_procs.<name>.rss_mb`, from the `ps` it already ran) and the system's
  current FSEvents event id (`fsevents_event_id`, `FSEventsGetCurrentEventId`
  over bun:ffi, no root) on every tick.
- The `daemon-cpu` report's what-to-do names the CacheDelete replay check and
  the RSS / event-id reading.

## D12 result (2026-11-09 04:23Z restart): case (b), a one-off

### The sample (pid 71649, 16.3 GB footprint, 10 s at 1 ms)

The notify thread (busy in all 7,926 samples) and the disk logger (46 % busy)
run one function, fseventsd+0x41a4. Disassembled
(`otool -tV`, fseventsd 1413.100.6), it is the **path-string intern table**
(`PathStringZone`):

- CRC32 of the path → one of **4,096 buckets** (`0x1000`, allocated once at
  startup at +0x10750; the mask is never rewritten — the table never resizes);
- a linear chain walk with `strncmp`, under one global mutex;
- a miss mallocs a refcounted node (count at +0x10, string at +0x14); the
  release (+0x438c) frees at refcount 0.

51 % of the notify thread is `strncmp` in that walk, 23 % waiting on its
mutex. So the 8.5 GB was interned paths never released — something kept a
reference — and each lookup cost ~N/4,096 string compares: why throughput fell
as RSS grew. What held the references needs symbols; the strings
`historyPruning`, `purge_history_policy` and `last_history_id` fit an
id-keyed pruning that stopped, unproven. No `string_table_count` state line
was in the unified log.

### After the restart (pid 80166), 04:23Z → 06:18Z

| | before (pid 71649) | after |
|---|---|---|
| `daemon_procs.fseventsd.rss_mb` | 6.2–9.3 GB | 11–15 MB, flat |
| `daemon_cpu.fseventsd` | ~100 % | 0–9 %, mostly < 2 % |
| `fsevents_event_id` | 0x10AD3… | 0x10ADB… → 0x10C336D0A (+22.6M, 3.4k ids/s) |
| ledger `watch-delivery` p50 | 0.5–3.7 s | 114 ms |

The id rate (3.4–3.6k/s, load up to 50) is the rate at which it grew
0.7 GB/h on 11-08. At that rate it would be ~1.3 GB now; it is 13 MB. The
ids above 2^32 do not re-trigger it: the crossing (or something at it) started
a leak in a process that lived through it, and the restart is the fix. The
installed monitor already wrote `rss_mb` and `fsevents_event_id`.

### The watch-delivery tail was partly made up

p90 sat past the ledger's 140 s top bucket before and after the restart, so it
was not fseventsd. The kqueue follows (`watch-delivery:kqueue`: `daemon.pid-files`
up to 13.7 h, `runtime-sdk.events`, `transcript-watcher.followed-files`) timed
the `update` a follow makes up for each file after every (re)open, reading the
file's age as lag. Fixed: `followFiles` takes `take` (heard, timed) and `look`
(made up, untimed); the engine's inotify new-folder walk goes through `look`
too. FSEvents samples of tens of minutes (`file-watcher.dirs`,
`corpus-index.stats.cost.usage`) remain and are not explained here.
