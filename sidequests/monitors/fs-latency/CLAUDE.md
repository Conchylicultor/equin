# fs-latency monitor — how slow is a file-metadata operation, and why

A launchd job (`StartInterval` 30 s, one tick per run, no in-process timer)
appending one JSON line per tick to `~/.equin/logs/monitors/fs-latency.jsonl`.

## Why

File-metadata ops (readdir, stat, lookups) can stall for tens of seconds at
idle CPU, and nothing inside the app survives to record it. Two mechanisms
make up the stall, and this monitor separates them:

- **darwinbg throttle.** A darwinbg process's disk I/O is delayed
  `debug.lowpri_throttle_tier3_io_period_ssd_msecs` (25 ms) whenever other
  I/O hit the device in the last 500 ms. Agent sessions and everything they
  spawn run darwinbg (`packages/spawn-priority`), so every cold I/O there
  costs ~30 ms. Compare the `fg` and `bg` probes.
- **Cache lifetime.** A recycled vnode drops its cached pages, so once the
  vnode table (`kern.maxvnodes`) is full and churning, the file cache is
  bounded by vnode count, not by free RAM. Watch `canary`, `new_vnodes_s`,
  and disk read ops/s tracking new vnodes/s.

Findings and benchmarks live on the investigation's track page, not here.

## What it captures (per tick)

| key | meaning |
|---|---|
| `fg` / `bg` | cold probes, foreground and darwinbg (self-switched with `setpriority(PRIO_DARWIN_PROCESS)`): `lstat_p50` / `lstat_max` / `lstat_sum` of 40 lstats, `readdir500` (one 500-entry directory), `max_op` (ms) |
| `max_op_ms`, `stall` | slowest single op of the tick; `stall` when > `STALL_MS` (1000) |
| `canary` | `[{age_s, resident}]` per canary group: page residency vs time since it was last read. The age where residency drops is the cache lifetime |
| `vnodes`, `maxvnodes`, `new_vnodes_s`, `recycled_vnodes_s` | vnode table and churn |
| `disk_read_ops_s`, `disk_write_ops_s`, `disk_read_mb_s`, `disk_read_ms_per_op` | IOBlockStorageDriver statistics delta (`ms_per_op` = device time, so device slowness is told apart from throttling) |
| `load1`, `daemon_cpu` | load and %CPU of fseventsd, syspolicyd, XprotectService, mds, mds_stores, corecaptured |
| `corecaptured` | `{pid, age_s}` of corecaptured, or null. No root needed. A pid that changes every ~5 min (age never past ~300 s) is its relaunch loop, the client behind the fseventsd history replay (below) |
| `disk_readers_mb_s` | root only: the top 8 processes by disk bytes read since the last tick (`proc_pid_rusage`, root daemons included), MB/s by process name |
| `disk_read_attributed_mb_s`, `disk_read_born_mb_s` | root only: the same reads summed over EVERY live process, and the part of it from processes born since the last tick (counted from 0, so short-lived git and hook runs are not dropped). `disk_read_mb_s` minus `disk_read_attributed_mb_s` is what no live process explains: processes that started and exited between two ticks, and the kernel |
| `fseventsd_logs` | root only: the `.fseventsd` log files fseventsd holds open (hex event ids). The newest is the one being written; one far behind it, advancing tick after tick, is a history replay for a client that subscribed from an old event id |
| `incident` | root only: path of a 5 s `fs_usage -w -f filesys` capture taken on a stall (cooldown `INCIDENT_COOLDOWN_S`, 600 s) — who is doing the lookups |

The probe corpus is private (`~/.equin/logs/monitors/fs-latency-corpus/`,
10 × 500 empty files + 12 × 50 × 16 KB canaries, ~10 MB), visited
round-robin so each probe file is touched only every ~10 ticks. It never
touches a checkout, so it does not warm what it measures.

## Install

Every command below works from any directory once `MAIN` is set to the main
checkout. From inside any checkout or worktree of the repo (any subdirectory),
it is the first entry of `git worktree list`; from elsewhere, set it to the
main checkout's absolute path by hand.

```sh
MAIN="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
SRC="$MAIN/sidequests/monitors/fs-latency"
PLIST=com.epot.fs-latency-monitor.plist
```

The plist runs the script through `~/.equin/logs/monitors/fs-latency-src`, a
symlink to this folder in the main checkout, so the plist never spells the
checkout's path:

```sh
mkdir -p ~/.equin/logs/monitors
ln -sfn "$SRC" ~/.equin/logs/monitors/fs-latency-src
```

User agent (probes + kernel counters; no attribution):

```sh
cp "$SRC/$PLIST" ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/$PLIST
```

Root daemon (adds the `fs_usage` capture on stalls, `disk_readers_mb_s` and
`fseventsd_logs`). Stop the user agent first, so the two never write the same
log; `MONITOR_HOME` in the plist keeps the paths under the user's home. launchd
refuses a daemon plist not owned by root:wheel:

```sh
launchctl bootout "gui/$(id -u)/com.epot.fs-latency-monitor" 2>/dev/null
sudo cp "$SRC/$PLIST" /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/$PLIST
sudo chmod 644 /Library/LaunchDaemons/$PLIST
sudo launchctl bootstrap system /Library/LaunchDaemons/$PLIST
```

Back from root to the user agent: the root daemon leaves root-owned files
(`fs-latency.state.json`, `fs-latency-incidents/`) that the user agent cannot
write, so hand them back first:

```sh
sudo launchctl bootout system/com.epot.fs-latency-monitor
sudo rm /Library/LaunchDaemons/$PLIST
sudo chown -R "$(id -un)" ~/.equin/logs/monitors
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/$PLIST
```

## Read it

```sh
/usr/bin/python3 -I ~/.equin/logs/monitors/fs-latency-src/report.py --hours 24
/usr/bin/python3 -I ~/.equin/logs/monitors/fs-latency-src/report.py --since 2026-11-04T03:29 --until 2026-11-04T16:23
tail -1 ~/.equin/logs/monitors/fs-latency.jsonl
```

Per hour: cold lstat / readdir per tier, slowest op, stall count, vnode
churn, disk read ops/s, MB/s and device ms/op, fseventsd %CPU, and the cache
lifetime; then the window's p50s. `--since` / `--until` (UTC ISO prefixes)
pick a before/after window. The exit criterion
"no file-metadata stall over 1 s across a day" is `stalls 0` over 24 h.

## Who is churning, without root

```sh
/usr/bin/python3 -I ~/.equin/logs/monitors/fs-latency-src/census.py --seconds 300 [--out /tmp/census.json]
```

On demand, not a launchd job. Once a second it reads every process's
unix-syscall count and disk bytes read (both readable for the user's own
processes with no privilege) beside `vfs.vnstats.num_newvnode_calls`, then
ranks process kinds by syscalls / disk MB with their correlation to new
vnodes/s, and names the heaviest readers in the worst seconds. A proxy (neither
counter is a vnode count; processes under ~1 s and root daemons are missed);
`fs_usage` in the root mode above is the exact answer.

## Which client makes fseventsd replay its history (root, on demand)

```sh
sudo /usr/bin/python3 -I ~/.equin/logs/monitors/fs-latency-src/fseventsd-bisect.py [--fseventsd]
```

The `fseventsd_logs` field shows fseventsd cycling through old log files, a
history replay for some client. `fseventsd-bisect.py` names the client. It
watches one cycle (6 min) with fseventsd's debug logging on, recording a
`log stream` and dating the replayed range from the log files' mtimes. Then it
restarts each suspect in turn (`SUSPECTS`, launchd respawns them all) and
watches another cycle. The first restart after which no replay is seen gives the
verdict. `--fseventsd` adds a restart of fseventsd itself as the last step,
which proves the mechanism but names no client. Writes
`captures/fseventsd-bisect-<stamp>.json` and `captures/fseventsd-debug-<stamp>.log`.
Takes 6 min per step, at most 24 min.

Its 2026-11-04 run named no client (every suspect restart left the replay
running); the unified log did. **The client is `corecaptured`** (CoreCapture,
Apple's Wi-Fi/Bluetooth diagnostics daemon). On every launch its CacheDelete
client calls `_CacheDeleteEnumerateRemovedFiles` for `/Library/Logs/CoreCapture`
and `/Library/Logs/CrashReporter/CoreCapture`, which opens an FSEvents stream
from its saved purge marker (`com.apple.corecaptured.purge.purge_markers`) and
reads the whole history from there. Neither directory exists, so no event ever
matches and the marker is saved back unchanged after `historyDone`; it exits,
and launchd relaunches it at once (`because xpc event`). See it without root:

```sh
/usr/bin/log show --last 15m --predicate 'process == "corecaptured" AND (eventMessage CONTAINS "Time taken" OR eventMessage CONTAINS "consuming stream" OR eventMessage CONTAINS "setPurgeMarker")'
```

`consumeStream Time taken` is one replay (seconds); `consuming stream … from
ID:` is the marker it replays from.

**Fixed 2026-11-04 16:23 UTC** by restoring the two stock directories (root):
`sudo mkdir -p /Library/Logs/CoreCapture /Library/Logs/CrashReporter/CoreCapture`.
The replay running at the time saved a new marker on finishing (1839631885 →
3727846510), the next launch replayed for 0.11 s instead of 294 s, and
corecaptured then exited idle and stayed down (`launchctl print
system/com.apple.corecaptured`: `runs` stopped growing at 549). If the loop comes
back (`corecaptured` age cycling under ~300 s, fseventsd near 100 % CPU at idle),
check first that the directories still exist.

## Uninstall

```sh
launchctl bootout "gui/$(id -u)/com.epot.fs-latency-monitor"
rm ~/Library/LaunchAgents/com.epot.fs-latency-monitor.plist
# or, for the root daemon:
sudo launchctl bootout system/com.epot.fs-latency-monitor
sudo rm /Library/LaunchDaemons/com.epot.fs-latency-monitor.plist
sudo chown -R "$(id -un)" ~/.equin/logs/monitors
rm -rf ~/.equin/logs/monitors/fs-latency-corpus ~/.equin/logs/monitors/fs-latency.state.json ~/.equin/logs/monitors/fs-latency-src
```

## Cost

Per tick: ~80 lstats, two 500-entry readdirs, 600 small opens + mmaps for
residency, one 50-file re-read, a `sysctl`, an `ioreg` and a `ps`; as root also a
second `ps`, one `proc_pid_rusage` per process and an `lsof` of fseventsd. Well under
a second when the disk is healthy. Logging adds ~1 KB per tick (≈3 MB a day).
