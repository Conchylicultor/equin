# A delivered message showed "Sending…" ~60 s: watch delivery lag, unmeasured

Task: task-1794186119 (responsiveness audit, supervisor task-1793965642-94fdhj).

## Incident (2026-11-09, UTC)

conv-1793665695-3p52r4 (sdk), turn `turn-a9ffcd04…`: accepted 00:47:18.607,
its line written 00:47:18.619, the reply 00:47:33. The tab's `jsonl-events`
window grew only at 00:48:18 (`live-state.jsonl`: `transcript-stats.usage.before`
665 → 670, ~5 rows at once — nothing in between). Same minute: a navigation
censored at 60 s waiting on `host-fs.stat×15`. No slow-op, report or log.

## Layers

| layer | evidence | verdict |
|---|---|---|
| agent → transcript file | line `timestamp` 12 ms after accept; nothing holds the file open (`lsof`), so each append closes | fine |
| file → main's watch (FSEvents, `transcript-watcher.transcripts`, a `subtree` parcel stream over `~/.claude/projects`) | not recorded anywhere (the gap) | **~55–60 s** |
| watch → notify → frame sent → tab applied | ledger `update-e2e` 00:47 n=226 max 57 ms, 00:48 n=166 max 319 ms; `deliver-server` max 318 ms | fine |
| main's backend | health p99 ~1 ms, no slow ops, no stalls | fine |
| host fs | fs-latency monitor: lstat p50 0.01 ms, max_op < 4 ms | fine |

**What held it: fseventsd.** The fs-latency monitor's `daemon_cpu` has fseventsd
at 99–103 % of a core through the whole incident (load 4.5–11). Hourly medians
over the archive: 0.1–2.5 % until 2026-11-08 ~15Z — even at load 30–65 and
14k new vnodes/s (11-06T17) — then ≥ 50 % in 1,123 of 1,126 samples since
15:23Z, at load 3 and 16 new vnodes/s too. Not event volume: a stuck state
since that moment (pid 71649, 19 days old). Its stacks need root (`sample`
refused). Measured now with a parcel stream like main's, one append a second:

| target | heard | p50 | p90 | max |
|---|---|---|---|---|
| `~/.claude/projects` (FSEvents) | 20/20 | 3.4–10.2 s | 13.2–14.2 s | 14.3 s |
| fresh tmp dir (FSEvents) | 20/20 | 3.6–10.1 s | 13.1–14.1 s | 14.3 s |
| same file, kqueue | 20/20 | 0 ms | 1 ms | 2 ms |

Delivery is not FIFO (research/2026-11-08-global-fseventsd-event-volume.md: a
burst elsewhere delayed unrelated probes 91–99 s), so ~60 s at 00:47 needs no
60 s cadence: nothing periodic caught it up, the event simply arrived then.

`host-fs.stat×15`: its sub-ack waits on the watch start (`start:<key>`), a
children watch — since 9b06a6dcc5 its own FSEvents stream. Opens measure
13–425 ms now; nothing recorded the incident's. Not shown to be the minute.

## Did this session's changes silence the reports?

None did: no span, wait or push was open during the gap, so no judge existed
before or after any of them.

- **(a) c7b65df6b0 / 35512ff4e4** (own-time judging): change how a recorded span
  is judged. The lag happened before the room's span existed; no span ran
  long. The server's post-notice path measured ≤ 319 ms either way.
- **(b) fb6f71b349, `beginDeferredWait`**: in-progress waits — nothing awaited
  (no stat/read stalled: fs-wait log had one unrelated 382 ms readdir).
- **(c) 9b06a6dcc5, 167d94c556, aec983b780, 5e68dd16ca**: `children` depth and
  `writesWhileOpen` follows only. The transcripts watch is a `subtree` FSEvents
  stream since ≥ 2026-10-01 (`watcherBackend` unchanged for it). Not the cause.
  9b06a6dcc5 adds one FSEvents stream per children watch (more fseventsd
  clients), but fseventsd was pinned 2 h before it landed (17:17Z).
- **(d) dc6d2ce4c2, 892abff34e**: notify → apply was ≤ 319 ms for every
  update in those minutes; held follows cache the chain, which did not change
  (one session file).

**Before** (fcb2afa0d9, 2026-10-25, not this session): a 30 s reconcile
re-read every room, which would have capped such a gap at ~30 s — hiding the
lag rather than reporting it.

### The own-time hole (supervisor's question)

Real, by construction. Bars: loader/sub/push/bg 2000 ms own, a single queue
wait 2000 ms, residue offered per entry at the same 2000 ms, then the gate's
60 s window. 0.6 s own + 1.5 s wait: own judged alone (0.6), residue judged
alone (1.5), the window sum (≥ 2 s per 60 s) only from many ops — a 2.1 s op
filed nothing. Main had restarted 53 s before the check, so its live profile
could not show instances. Closed in the recorder (below), test-held.

## What landed

1. **Watch delivery lag, measured** (`infra/file-watcher`): every instance
   samples ctime → arrival (≤ 1 per 5 s; ctime because a moved-in file keeps
   its mtime) as a latency leaf `bg watch-delivery:<backend>` (one report per
   backend, held to the 1 s live-update bar), the ledger metric
   `watch-delivery`, and the catalog's `Heard after` fact.
2. **Write → tab, one clock**: `notify({ changedAt })` (network/live) — a
   transcript snapshot carries its files' newest mtime (not on the seed), so
   `update` / `update-e2e` start at the write and watch lag shows as
   `server-notice`.
3. **Turn → tab**: client signal `turn-echo` (accepted → its line on screen,
   phases `agent-write` / `delivery`), slow-op on the update bar + ledger
   metric `turn-echo`.
4. **The cause, for transcripts**: fixed rooms follow their named files over
   kqueue (`transcript-watcher.followed-files`); FSEvents stays for discovery.
5. **Own-time hole**: a closing entry is judged on own + residue no gate
   report took (`SlowSpan.residueMs`); filed, it consumes it.

## Not done

- fseventsd's stuck state: needs root to sample, or a restart
  (`sudo killall fseventsd` — launchd restarts it). A machine change: the
  user's call.
- Other user-facing FSEvents watches (host-fs folder views, config) still lag
  with it; now each lag is reported (`watch-delivery:fs-events`).
- Session births (`notifySessionTranscriptWrites`) still ride FSEvents.
