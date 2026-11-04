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
| `incident` | root only: path of a 5 s `fs_usage -w -f filesys` capture taken on a stall (cooldown `INCIDENT_COOLDOWN_S`, 600 s) — who is doing the lookups |

The probe corpus is private (`~/.equin/logs/monitors/fs-latency-corpus/`,
10 × 500 empty files + 12 × 50 × 16 KB canaries, ~10 MB), visited
round-robin so each probe file is touched only every ~10 ticks. It never
touches a checkout, so it does not warm what it measures.

## Install

The plist runs the script through `~/.equin/logs/monitors/fs-latency-src`, a
symlink to this folder in the main checkout, so the plist never spells the
checkout's path (run from the main checkout's root):

```sh
mkdir -p ~/.equin/logs/monitors
ln -sfn "$PWD/sidequests/monitors/fs-latency" ~/.equin/logs/monitors/fs-latency-src
```

User agent (probes + kernel counters; no attribution):

```sh
cp sidequests/monitors/fs-latency/com.epot.fs-latency-monitor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.epot.fs-latency-monitor.plist
```

To get the `fs_usage` attribution on stalls, run the same plist as a root
daemon instead (`MONITOR_HOME` keeps the paths under the user's home):

```sh
sudo cp sidequests/monitors/fs-latency/com.epot.fs-latency-monitor.plist /Library/LaunchDaemons/
sudo launchctl load /Library/LaunchDaemons/com.epot.fs-latency-monitor.plist
```

## Read it

```sh
/usr/bin/python3 -I sidequests/monitors/fs-latency/report.py --hours 24
tail -1 ~/.equin/logs/monitors/fs-latency.jsonl
```

Per hour: cold lstat / readdir per tier, slowest op, stall count, vnode
churn, disk ops and device ms/op, and the cache lifetime. The exit criterion
"no file-metadata stall over 1 s across a day" is `stalls 0` over 24 h.

## Who is churning, without root

```sh
/usr/bin/python3 -I sidequests/monitors/fs-latency/census.py --seconds 300 [--out /tmp/census.json]
```

On demand, not a launchd job. Once a second it reads every process's
unix-syscall count and disk bytes read (both readable for the user's own
processes with no privilege) beside `vfs.vnstats.num_newvnode_calls`, then
ranks process kinds by syscalls / disk MB with their correlation to new
vnodes/s, and names the heaviest readers in the worst seconds. A proxy (neither
counter is a vnode count; processes under ~1 s and root daemons are missed);
`fs_usage` in the root mode above is the exact answer.

## Uninstall

```sh
launchctl unload ~/Library/LaunchAgents/com.epot.fs-latency-monitor.plist
rm ~/Library/LaunchAgents/com.epot.fs-latency-monitor.plist
rm -rf ~/.equin/logs/monitors/fs-latency-corpus ~/.equin/logs/monitors/fs-latency.state.json ~/.equin/logs/monitors/fs-latency-src
```

## Cost

Per tick: ~80 lstats, two 500-entry readdirs, 600 small opens + mmaps for
residency, one 50-file re-read, a `sysctl`, an `ioreg` and a `ps`. Well under
a second when the disk is healthy. Logging adds ~1 KB per tick (≈3 MB a day).
