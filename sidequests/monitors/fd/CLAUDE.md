# FD monitor — diagnose macOS "too many files open" crashes

A launchd agent that runs a **two-tier poll** every 5s:

- **Cheap probe** (every tick): `sysctl kern.num_files` + `ps -A | wc -l`. Microseconds, no FD cost. Silent unless it trips an early-warning threshold.
- **Heavy tick** (full `lsof` + log block + incident detection): runs every 30s as a baseline heartbeat, *plus* on demand whenever the cheap probe sees elevation (high `kern.num_files`, ps-explosion, or rapid growth between probes).

Output lands in `~/.singularity/logs/monitors/fd-monitor.log` (per-tick blocks) and `~/.singularity/logs/monitors/fd-monitor-incidents/<ts>/` (forensic dumps when any single process holds an unusual number of FDs or `kern.num_files` crosses a fraction of `kern.maxfiles`).

The two-tier design lets us catch in-progress leaks within ~5s while keeping the lsof cost — the only expensive part — pinned to roughly the same rate as before.

## Why

Originally set up because equin was the leading suspect for "too many files open" crashes (long-lived gateway, many spawned bun backends, accumulating worktrees / Postgres DBs / tmux sessions). The monitor captured a real spike on 2026-04-26 and showed the leak was a runaway **Claude CLI** child process (pid held 65,489 FDs in <30s; `lsof` itself failed mid-run; system rebooted seconds later). equin processes were normal throughout. The monitor is being kept active to catch future repeats and gather full forensics.

## What it captures

Each **heavy tick** appends a block like:

```
===== 2026-04-26 11:55:00 =====
kern.num_files: 6894
kern.maxfiles: 245760
kern.maxproc: 4176
kern.maxfilesperproc: 122880
ps_count=412
lsof_total=11980
--- top 20 FD holders (count cmd:pid) ---
   429 gateway:1436
   213 bun:1498
   ...
--- top 10 FD-holding command groups ---
   1820 bun
    873 Code
    ...
--- singularity quick stats ---
gateway_pid=1436
gateway_fds=429
bun_backends=2
tmux_sessions=16
claude_cli_procs=3
postgres_backends=28
worktree_jsons=349
```

When a crash happens, `tail -n 500` of the log reveals which command shot up.

If a heavy tick was triggered by the cheap probe (not the 30s schedule), the block is preceded by an `----- ESCALATED reasons=… num_files_pct=… delta_files=… ps_pct=… -----` annotation so it's clear *why* the block exists outside the regular cadence.

### Probe escalation thresholds

The cheap probe escalates to a heavy tick when any of:

- `num_files` ≥ `PROBE_NUM_FILES_PCT`% of `kern.maxfiles` (default **15%** — heavy is 25%, so this is an earlier warning)
- `ps_count` ≥ `PROBE_PS_PCT`% of `kern.maxproc` (default **70%**)
- Δ`num_files` ≥ `PROBE_DELTA_FILES` since the previous probe (default **3000** — rapid-growth signal; the killer for in-progress leaks)

Throttled to at most one heavy tick per `ELEVATED_MIN_GAP` seconds (default **10s**) so a sustained elevation doesn't run `lsof` every probe. The 30s scheduled heartbeat continues regardless.

### Incident dumps

If any pid holds more than `SUSPECT_PID_FDS` (default **3000**) FDs, or `kern.num_files` crosses `SYSTEM_NUM_FILES_PCT` (default **25%**) of `kern.maxfiles`, this tick *also* writes a forensic dump to:

```
~/.singularity/logs/monitors/fd-monitor-incidents/<YYYYMMDD-HHMMSS>/
├── system.txt           # kernel state, top 50 cmd:pid, top 20 cmd groups, full ps
├── system.lsof.gz       # gzipped system-wide lsof at incident time
├── pid<pid>.txt         # ps line, FD type/kind breakdown, top 30 names per suspect pid
└── pid<pid>.lsof.gz     # gzipped full lsof for that pid
```

The main log gets a `!!!!! INCIDENT <ts>` annotation pointing at the dir, so `grep '!!!!!' fd-monitor.log` is the fast way to find them.

Why dump *during* the tick: the leaker often dies before the next tick (hits `kern.maxfilesperproc` and is killed, or the box crashes). The lsof we already captured this tick is the only evidence of what it had open.

Override thresholds via env vars on the LaunchAgent if needed:

```sh
SUSPECT_PID_FDS=5000 SYSTEM_NUM_FILES_PCT=40 zsh sidequests/monitors/fd/fd-monitor.sh
```

Incident dirs older than 14 days are auto-purged. There's also a hard cap of `MAX_INCIDENT_DIRS` (default 200) — oldest are dropped if the cap is exceeded.

### Self-protection

The script protects itself from amplifying a crisis it's trying to observe:

- **Cheap probes never take the lock.** Only heavy ticks contend for the lockfile, so 11 of every 12 launchd invocations are read-only and exit in milliseconds.
- **Lockfile** (`<incidents>/.lock`, atomic via `mkdir`): if a heavy tick is already running, a contending heavy tick exits silently — except a *scheduled* heavy tick blocked by contention logs a `SKIPPED — heavy tick contended` line (means lsof is taking longer than 30s, worth knowing). Locks older than `LOCK_STALE_AFTER` seconds (default 90) are stolen.
- **lsof sanity gate**: if `lsof` returns fewer than `MIN_LSOF_LINES` lines (default 500 — system idle baseline is ~12k), incident detection is skipped for this tick. Prevents writing forensics off truncated data when `lsof` itself failed.
- **Cooldowns**: a system-wide dump won't fire again within `SYSTEM_COOLDOWN` seconds (default 300); a per-pid dump won't fire again for the same pid within `PID_COOLDOWN` seconds (default 300). Throttled ticks still log `!!!!! INCIDENT … all dumps throttled` so the elevation is visible without flooding disk.

## Files

```
├── fd-monitor.sh                 # the snapshot script
├── com.epot.fd-monitor.plist     # LaunchAgent (runs every 30s)
└── CLAUDE.md
```

## Install

```sh
chmod +x sidequests/monitors/fd/fd-monitor.sh
cp sidequests/monitors/fd/com.epot.fd-monitor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.epot.fd-monitor.plist
```

Verify it's running:

```sh
launchctl list | grep fd-monitor
tail -f ~/.singularity/logs/monitors/fd-monitor.log
```

A new block should appear every 30s.

## Update

After editing the script (no plist change needed — script path is stable):

```sh
# changes pick up on the next tick automatically
tail -f ~/.singularity/logs/monitors/fd-monitor.log
```

After editing the plist:

```sh
launchctl unload ~/Library/LaunchAgents/com.epot.fd-monitor.plist
cp sidequests/monitors/fd/com.epot.fd-monitor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.epot.fd-monitor.plist
```

## Uninstall

```sh
launchctl unload ~/Library/LaunchAgents/com.epot.fd-monitor.plist
rm ~/Library/LaunchAgents/com.epot.fd-monitor.plist
```

The log file at `~/.singularity/logs/monitors/fd-monitor.log` is left in place; delete manually if you want.

## Cost

`lsof -n -P` of the entire system runs in ~0.5–2s and is the heaviest part of each tick. At a 30s baseline cadence it's negligible.

The cheap probe (sysctl + ps_count) is microseconds — running it every 5s is essentially free. The two-tier design means lsof runs at roughly the same rate as before (≈1× per 30s in steady state), only ramping up when an elevation actually fires. If a sustained spike causes too much lsof, raise `ELEVATED_MIN_GAP` (default 10s) — it caps how often elevated heavy ticks can fire.

## After a crash — how to read the log

```sh
# Find the gap in timestamps that brackets the crash
grep '^=====' ~/.singularity/logs/monitors/fd-monitor.log | tail -50

# Pull the last 200 lines before that gap and look for:
#   - lsof_total trending upward fast
#   - kern.num_files approaching kern.maxfiles
#   - ps_count approaching kern.maxproc
#   - top FD holders changing (a runaway pid sticking near the top)
```

Findings to bring back: the top FD-holding command in the final block, any single (cmd:pid) above ~5000 FDs, and whether the kernel limits were actually saturated.
