# io-health

Host file-I/O health inside equin. The signals come from the **fs-latency
monitor** (the `monitor` sub-plugin: a binary a periodic login service runs
every 30 s, installed by `./equin start`), which appends one tick per run to
`~/.equin/logs/monitors/fs-latency.jsonl` (the `debug` umbrella's
`monitorLogsDir`). This plugin consumes that log and puts it on the existing
paths: **reports** (Debug → Reports, the bell, the incident Timeline's
`report` lane) and the health report's **Disk I/O** row.

Why: on 2026-11-03 fseventsd started replaying 17 days of event history every
~4 min for corecaptured's relaunch loop. Disk reads went 860 → 3–6k ops/s,
main builds 1 → 9 min, and nothing in equin noticed — the monitor saw it all,
in a file nobody read.

## Shape

- `core/` — the contract and the logic, pure:
  - `MonitorTickSchema` / `parseTickLine` — the monitor's line format, as
    read (older fields stay optional so the recorded history parses);
    `WrittenTick` — the line as the monitor writes it, held to the schema by
    tsc (`_WrittenTickParses`, `_ReaderFieldsWritten` in `core/internal/tick.ts`):
    a field the reader adds or renames is a type error in the monitor.
  - `createIoHealthDetector` — a trailing one-hour window of ticks, six rules
    re-evaluated per tick (`IO_HEALTH_RULES`), each finding's onset carried
    while it holds. Every threshold and the data it was chosen from is on
    `IO_HEALTH_THRESHOLDS` (`core/internal/detect.ts`).
  - `hostIoHealth` — the `host.io-health` live value (`needsMachine`): the
    monitor missing, or its newest tick + root flag + active findings.
  - `HOST_IO_DEGRADED_KIND` — the report kind; its payload is the finding.
- `machine/` — follows the log: a `writesWhileOpen` file watcher on the log
  file itself (kqueue: every append heard in milliseconds; no timer — the
  monitor's launchd schedule is the clock),
  `readLogTail` (resumes from a byte cursor; restarts at the last 512 KB at
  boot, on a replaced/truncated file or a gap), the state that feeds the
  detector, and on **main only** files each finding as `host-io-degraded`
  when raised and again every hour it holds (the log is host-global: one
  filer). A boot onto a log whose newest tick is over 2.5 min old shows its
  findings but files nothing.
- `web/` — the Disk I/O row and the Reports summary line.
- `scripts/replay-monitor-log.ts` — replays a recorded log through the
  detector, printing every raise and clear (see Verify).
- `plugins/monitor` — the monitor itself: program, build, login service, the
  log's rotation into kept archives, the root opt-in (its `CLAUDE.md`).

## The rules

| rule | fires when (trailing hour) | why this is a defect, not load |
| --- | --- | --- |
| `daemon-cpu` | a watched daemon's median CPU ≥ 50 % (≥ 40 ticks); holds down to 25 % | fseventsd sat at 76–100 % for the whole incident and at 0.3–0.6 % after it, busy fleet included |
| `device-latency` | median device ms/read op ≥ 2.0 over ticks with ≥ 1k read ops/s (≥ 20); holds down to 1.5 | 3–5.8 ms during, ≤ 0.92 after at the same or higher read rates |
| `metadata-stall` | any cold probe op > 1 s — **critical**, at once | the track's exit criterion; none in the recorded history (max 435 ms) |
| `rename-stall` | the slowest of a tier's 20-rename burst > 250 ms on ≥ 3 ticks | renames wait on the volume's rename serialization, held by any bulk directory-tree mutation (`bun install`, `rm -rf node_modules`): ≤ 14 ms quiet, 0.3–1.3 s under one install (2026-11-05, any I/O tier); main's `renameSync` stalls with it. The finding names the processes in uninterruptible wait at the worst tick |
| `relaunch-loop` | ≥ 5 distinct pids of one watched daemon | corecaptured made 13–18 an hour; a healthy daemon keeps one pid |
| `cache-collapse` | canaries read 60–180 s ago mostly evicted although every tick since their read was quiet (< 500 new vnodes/s), ≥ 20 such ticks | the fleet's vnode churn evicts the cache every busy minute (during and after the fix), so only a quiet-machine eviction is news |
| `root-daemon` | the newest tick carries `root_daemon`: the root daemon's plist is installed but it is not the one writing | the opt-in silently does nothing (and, before the user agent stopped deferring to a plist's existence, the whole monitor stopped) |

Deliberately **not** a rule: read ops/s or MB/s against a baseline. They
measure the workload — the fleet read more after the fix than during the
incident — so they ride along as evidence only.

## Not installed / not running

The row is `attention` when the log does not exist ("not installed", with
`./equin start --only dev.equin.fs-latency-monitor`) and when its newest tick
is more than 3 min old ("has written nothing since …"): one timer to that
instant in the browser, rescheduled by every tick. Never green because nothing
was read.

## Verify

```sh
cp ~/.equin/logs/monitors/fs-latency.jsonl "$EQUIN_SCRATCH/fs-latency.jsonl"   # or gunzip -c an archive (monitor/CLAUDE.md)
./equin run plugins/infra/plugins/host/plugins/io-health/scripts/replay-monitor-log.ts \
  --log "$EQUIN_SCRATCH/fs-latency.jsonl" --fixed-at 2026-11-04T16:23
```

On the 2026-11-03 15:07 → 11-04 20:05 history: device-latency and
daemon-cpu:fseventsd raised from 2026-11-03 18:09 (the monitor's second hour),
relaunch-loop:corecaptured at 16:22:44 on 11-04 (the field was logged from
16:00), **nothing raised after 16:23**, the last clearing at 17:13 as the
incident ticks left the window. The gap 11-03 19:30 → 11-04 00:05 clears and
re-raises: the monitor barely ticked then (machine asleep), so no window had
enough ticks.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Host file-I/O health, shown: the health report's Disk I/O row (attention while a finding holds — critical for a metadata stall — or while the fs-latency monitor is not installed or has stopped writing; never green before the read lands) and the one-line Debug → Reports summary of the host-io-degraded kind.
- Web:
  - Contributes:
    - `Reports.KindView` → `HostIoDegradedSummary`
    - `HealthReport.Row` "Disk I/O"
  - Uses:
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `reports.Reports`
    - `shell/health-report.HealthReport`
- Server:
  - Contributes:
    - `report-kind` "host-io-degraded"
    - `resource.declare` "host.io-health"
  - Resources: `host.io-health` (push, notified)
- Machine:
  - Uses: `network/live.serveValue`
  - Register: `defineFileWatcher('io-health.fs-latency-log')`
- Core:
  - Uses: `network/live.liveValue`
  - Exports (types):
    - `DetectorStep`
    - `Evidence`
    - `Finding`
    - `IoHealth`
    - `IoHealthDetector`
    - `IoHealthRule`
    - `LatestTick`
    - `MonitorTick`
    - `ProbeReading`
    - `RootDaemonProblem`
    - `RootDaemonStatus`
    - `WrittenTick`
  - Exports (values):
    - `ACTIVE_FINDINGS_MAX`
    - `createIoHealthDetector`
    - `evaluateWindow`
    - `EVIDENCE_MAX`
    - `findingKey`
    - `FindingSchema`
    - `FS_LATENCY_LOG_NAME`
    - `HOST_IO_DEGRADED_KIND`
    - `HostIoDegradedPayloadSchema`
    - `hostIoHealth`
    - `IO_HEALTH_RULES`
    - `IO_HEALTH_THRESHOLDS`
    - `IoHealthSchema`
    - `LatestTickSchema`
    - `MONITOR_INTERVAL_MS`
    - `MonitorTickSchema`
    - `parseTickLine`
    - `ROOT_DAEMON_PROBLEMS`
    - `RootDaemonStatusSchema`
- Sub-plugins:
  - **`monitor`** — The fs-latency monitor, provisioned by equin: a standalone binary (bun build --compile of bin/) that a user LaunchAgent runs every 30 s, appending one tick per run to the monitors' log io-health…

<!-- AUTOGENERATED:END -->
