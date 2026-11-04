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
| `load1`, `daemon_cpu` | load and %CPU of fseventsd, syspolicyd, XprotectService, mds, mds_stores |
| `disk_readers_mb_s` | root only: the top 8 processes by disk bytes read since the last tick (`proc_pid_rusage`, root daemons included), MB/s by process name |
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
tail -1 ~/.equin/logs/monitors/fs-latency.jsonl
```

Per hour: cold lstat / readdir per tier, slowest op, stall count, vnode
churn, disk ops and device ms/op, and the cache lifetime. The exit criterion
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
