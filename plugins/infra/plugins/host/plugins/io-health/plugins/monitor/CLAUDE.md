# monitor — the fs-latency monitor, provisioned by equin

The program behind io-health: a standalone binary that launchd runs **every
30 s**, one tick per run, appending one JSON line to
`~/.equin/logs/monitors/fs-latency.jsonl` (`debug`'s `monitorLogsDir`), which
the parent plugin follows. It used to be a hand-installed Python sidequest
(`sidequests/monitors/fs-latency`); it lives here so the line it writes and the
schema the app reads are one contract under tsc, and so a fresh machine gets it
from `./equin start` with no `sudo`.

## Shape

- `bin/fs-latency-monitor.ts` — the program (`native.ts`: darwinbg, mincore,
  `proc_pid_rusage` over bun:ffi; `rotate.ts`: the log's bound). It imports
  **no repo module at run time** — only the type `WrittenTick` from
  `io-health/core`, which tsc holds to the reader's `MonitorTickSchema` (every
  written line parses; every field the reader knows is written). Paths come on
  argv (`--dir`, `--root-label`, `--interval-s`), so no constant is spelled
  twice. `root-daemon.ts`: the root opt-in (below); `run.ts`: every command it
  spawns, in a UTF-8 locale of its own.
- `deps/` — `fs-latency-monitor`, a `build` dependency: `bun build --compile`
  of the program (≈90 MB, the Bun runtime inside), identity = `bin/**/*.ts` +
  the Bun version. The build first bundles the program with a metafile and
  fails if it reads anything outside `bin/` — a file the identity does not hash
  would leave an installed binary stale.
- `login-services/` — `dev.equin.fs-latency-monitor`: a `background`,
  **periodic** (`schedule: { everySeconds: 30 }`, launchd `StartInterval`),
  `interactive` (launchd `ProcessType Interactive`, so the foreground probe is
  a foreground reading) login service, macOS only (`platforms`). It runs from
  the equin app bundle like every login service, and follows main's builds by
  itself once a `start` registered it.
- `core/` — the label; `START_MONITOR_COMMAND`, which the Disk I/O row shows
  when the monitor is not installed.
- `scripts/report.ts` — the hourly summary (archives + live log).

## Install

```sh
./equin start --only dev.equin.fs-latency-monitor   # or a plain ./equin start
```

No `sudo`. Every signal the detector reads — daemon CPU, pids and ages,
device ms/op, probes, canaries, vnode counters — needs no root.

## Root: an opt-in, for attribution

As root the same binary also records the top disk readers per process
(`disk_readers_mb_s`, `disk_read_attributed_mb_s`, `disk_read_born_mb_s`),
fseventsd's open log files (`fseventsd_logs`) and a 5 s `fs_usage` capture on
a stall (`incident`) — diagnosis after the alert, not the alert. Root cannot be
provisioned silently, so it is a step the user takes — one command, from any
directory, run by the binary the login service installed into the equin app
(so the daemon follows main's builds too):

```sh
sudo ~/.equin/state/macos-app/equin.app/Contents/MacOS/fs-latency-monitor install-root \
  --dir ~/.equin/logs/monitors --root-label dev.equin.fs-latency-monitor --interval-s 30
```

It renders the plist to a temporary file beside
`/Library/LaunchDaemons/dev.equin.fs-latency-monitor.plist`, checks it with
`plutil -lint`, renames it into place, bootstraps it and checks launchd holds
it — and removes it again when launchd refuses, so a failed install leaves
nothing behind. Running it again replaces the daemon. Back to the user agent
alone: the same binary's `uninstall-root --dir … --root-label …` (sudo) boots it
out, removes the plist and hands every file back to you.

**One writer per log, and never none.** The user agent stands aside while the
root daemon is *writing* — a root tick within the last four intervals
(`root_tick_at` in the state file) — not while its plist merely exists. When
the plist is installed and the root daemon is not writing, the user agent ticks
in its place and says why in the tick's `root_daemon` (`empty`, `invalid`,
`not-loaded` or `not-writing`, with the plist, the daemon's own log and the
exact reinstall command): io-health raises it as the `root-daemon` finding (the
Disk I/O row, a `host-io-degraded` report). Each root tick hands what it wrote
back to the log directory's owner, so the user agent can always take over.

Why: on 2026-11-04 the documented install was `./equin run … | sudo tee
<plist>`, run outside a checkout. `./equin` was not found, `tee` still wrote
an empty plist, `launchctl bootstrap` failed with error 5 — and the user agent,
deferring to the file's existence, stopped too. Nothing ticked for hours.

## What it captures (per tick)

| key | meaning |
|---|---|
| `fg` / `bg` | cold probes, foreground and darwinbg (self-switched with `setpriority(PRIO_DARWIN_PROCESS)`): `lstat_p50` / `lstat_max` / `lstat_sum` of 40 lstats, `readdir500` (one 500-entry directory), `max_op` (ms) |
| `max_op_ms`, `stall` | slowest single op of the tick; `stall` when > 1000 ms |
| `canary` | `[{age_s, resident}]` per canary group: page residency vs time since it was last read. The age where residency drops is the cache lifetime |
| `vnodes`, `maxvnodes`, `new_vnodes_s`, `recycled_vnodes_s` | vnode table and churn |
| `disk_read_ops_s`, `disk_write_ops_s`, `disk_read_mb_s`, `disk_read_ms_per_op` | IOBlockStorageDriver statistics delta (`ms_per_op` = device time, so device slowness is told apart from throttling) |
| `load1`, `daemon_cpu` | load and %CPU of fseventsd, syspolicyd, XprotectService, mds, mds_stores, corecaptured |
| `daemon_procs` | `{name: {pid, age_s}}` of each watched daemon that is running. A pid that changes tick after tick is a relaunch loop |
| root only | `disk_readers_mb_s`, `disk_read_attributed_mb_s`, `disk_read_born_mb_s`, `fseventsd_logs`, `incident` (above) |
| `root_daemon` | user agent only, while a root daemon's plist is installed but it does not write (above) |

Rates are deltas, so a monitor's first tick has none. The Python monitor also
wrote `corecaptured` (`{pid, age_s}` before `daemon_procs` existed); the reader
still accepts it for the recorded history.

The probe corpus is private (`fs-latency-corpus/`, 10 × 500 empty files + 12 ×
50 × 16 KB canaries, ~10 MB), visited round-robin so each probe file is touched
only every ~10 ticks. It never touches a checkout, so it does not warm what it
measures.

## The log's bound

A tick is ~1–1.7 KB (≈3 MB a day). Past 4 MB the tick that finds it so moves
every line older than **two hours** into
`fs-latency-archive/fs-latency-<first>--<last>.jsonl.gz` (gzip, ~10× smaller)
and replaces the live file with the two-hour tail: the reader restarts at the
tail of a replaced file (512 KB) and the detector drops ticks it has seen, so
its one-hour window is intact. Archives are kept 90 days — **except one that
starts before 2026-11-04T20:05Z**, the incident history every io-health
threshold was chosen from (`CALIBRATION_END_ISO`), which is kept for good.
Replay an archive with `gunzip -c <archive> > "$EQUIN_SCRATCH/x.jsonl"` and the parent's
`replay-monitor-log.ts --log "$EQUIN_SCRATCH/x.jsonl"`.

## Read it

```sh
./equin run plugins/infra/plugins/host/plugins/io-health/plugins/monitor/scripts/report.ts --hours 24
./equin run plugins/infra/plugins/host/plugins/io-health/plugins/monitor/scripts/report.ts --since 2026-11-04T03:29 --until 2026-11-04T16:23
tail -1 ~/.equin/logs/monitors/fs-latency.jsonl
```

Per hour: cold lstat / readdir per tier, slowest op, stall count, vnode churn,
disk read ops/s, MB/s and device ms/op, fseventsd %CPU, and the cache lifetime;
then the window's p50s. The exit criterion "no file-metadata stall over 1 s
across a day" is `stalls 0` over 24 h. `census.py` (who churns, without root)
and `fseventsd-bisect.py` (which client makes fseventsd replay) stay on-demand
tools in `sidequests/monitors/fs-latency`.

## Uninstall

```sh
launchctl bootout "gui/$(id -u)/dev.equin.fs-latency-monitor"
rm ~/Library/LaunchAgents/dev.equin.fs-latency-monitor.plist
rm -rf ~/.equin/logs/monitors/fs-latency-corpus ~/.equin/logs/monitors/fs-latency.state.json
```

## Cost

Per tick: ~80 lstats, two 500-entry readdirs, 600 small opens + mmaps for
residency, one 50-file re-read, a `sysctl`, an `ioreg` and a `ps`; as root also
a second `ps`, one `proc_pid_rusage` per process and an `lsof` of fseventsd.
~0.1 s warm (a compiled Bun binary starts in ~20 ms).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The fs-latency monitor, provisioned by equin: a standalone binary (bun build --compile of bin/) that a user LaunchAgent runs every 30 s, appending one tick per run to the monitors' log io-health reads — typed against io-health's tick schema, its log rotated into kept gzip archives; a root LaunchDaemon of the same binary is an opt-in for attribution.
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps/build.build`
  - Exports (values): `fsLatencyMonitorBinary`
- Cross-plugin:
  - Imported by: `infra/host/io-health`
- Exemptions:
  - Exempts itself from:
    - `timed-fs/no-untimed-fs-read` — `bin/fs-latency-monitor.ts`, `bin/rotate.ts`, `bin/root-daemon.ts` (sanctioned)
    - `owned-fd/no-raw-fd-close` — `bin/fs-latency-monitor.ts`, `bin/native.ts` (sanctioned)
    - `sink-safety/no-adhoc-file-sink` — `bin/fs-latency-monitor.ts` (sanctioned)
- Core:
  - Exports (values):
    - `FS_LATENCY_MONITOR_LABEL`
    - `START_MONITOR_COMMAND`

<!-- AUTOGENERATED:END -->
