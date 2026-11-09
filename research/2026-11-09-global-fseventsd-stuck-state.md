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
