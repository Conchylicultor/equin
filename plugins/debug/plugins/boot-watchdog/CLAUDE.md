# boot-watchdog

Makes a **backend that never becomes ready loud immediately** — the report/bell
half of the wedged-boot signal whose timeline half (an open-ended boot bar)
already exists.

During the 2026-07-17 incident an **11.5-minute never-ready boot of main** sat in
`boot.jsonl`, consumed by nothing: the timeline rendered it as an open bar, but it
reached no report and no bell, so the investigating agent never saw it. This
plugin closes that gap. It is modeled byte-for-byte on `debug/boot-budget` (config
+ `ReportKind` + web `KindView`), differing only where the signal genuinely
differs.

## Why main-only (no `perWorktree`)

The monitor is **structurally** main-only — not a policy choice. A `perWorktree`
scheduled job dequeues only after its own backend has booted successfully (the
job queue runs on the ready backend), so a backend can never observe its OWN
wedged boot. Main reads every worktree's `boot` channel off the shared filesystem
(`readBootEvents` — exactly how the timeline reads them) even while the owning
backend is wedged, so it is the only place this observation can be made. The
`worktree` column on the filed row is therefore always `main`, which is why the
subject lives in the **fingerprint** (`boot-wedge:<worktree>`) and the payload,
never the row's own worktree.

## What a never-ready boot is now

Each tick sweeps the boot channels (`readBootEvents(wt, lookbackMs)`) of the worktrees below for boots
with no `ready` line whose un-ready time has crossed `bootReadyBudgetMs`
(default 120 s), and asks the one witness of whether such a process still runs:
the gateway fleet (`GET /gateway/worktrees`, 2 s timeout — its `state` and
`lastSpawnErr`). A boot the gateway kills at its readiness deadline is a
SIGKILL, which writes no exit line, so the boot channel alone reads exactly
like a live wedge; before 2026-11-05 this watchdog filed such dead boots as
"un-ready 113592s and still live" every minute for 31 h. The verdict is
`classifyNeverReady` (`machine/internal/classify-wedge.ts`, pure + tested):

- A boot that **exited** before ready (`exitedAt`) is skipped: it crashed, and
  the crash is its own report (boot-events files it, error and stack, through
  the report outbox). Measured to the next start it would read as a wedge as
  long as the agent took to rebuild (a 3 s boot assert filed as "un-ready 172s").
- **superseded** — a later attempt replaced it. A closed, past outage: filed
  **once** (a module-level `Set<wt:processStartedAt>`, boot-budget's pattern).
- the latest attempt, on a worktree still in the fleet, by the fleet state:
  - **booting** — `starting` / `restarting`: the gateway is still waiting on
    it, past its budget.
  - **restart-failed** — `running`: a backend serves, so this was a hot
    restart's new process, killed while the old one kept serving — a failed
    deploy, not an outage. Filed once.
  - **failed** — `broken`: the gateway gave up on it (its `lastSpawnErr`
    quoted) and retries it only on a deploy or a browser start (gateway
    "A failed boot is not retried by traffic"). The worktree is **unusable**,
    so this keeps alerting.
  - **killed** — `idle` / `stopping`: killed before ready, but the gateway runs
    nothing for it and no longer holds the failure (it restarted, or the idle
    sweeper ran) — the next request boots it again. Filed once.
  - **booting** and **failed** are true *now*: filed **each tick** (no dedup
    Set), so the row's `count` ≈ minutes unusable and the bell re-arms per the
    15-min cooldown. It stops when a boot becomes ready.
- A worktree gone from the fleet (torn down) is not alerted; an unreadable
  fleet skips the latest attempts this tick rather than guessing.

**Every report names where the boot's time went** — from its own boot journal
(boot-events' `readBootJournals`): the step it was in when it stopped (a load
wave or blocking hook opens a journal line as it starts), when its imports
finished, its longest import waves and blocking hooks, and how long it ran
darwinbg. Rendered once (`core/describe.ts`) for the message, the task text
and the Reports row. Legacy `open` rows (the old "still live" state) still
parse and render.

**Which worktrees a tick reads.** Not every worktree dir: that was ~240–300
synchronous `boot.jsonl` tail reads on main's event loop each minute (4–7 s
stalls under host load) to evaluate the ~10 that can hold a wedge. A tick reads:

- every worktree the gateway runs a backend for (`starting` / `running` /
  `restarting` / `stopping` / `broken`) — where every boot happens, and where
  a superseding boot (so a superseded wedge) is;
- every worktree **marked unsettled** (`boot-events`' marks,
  `~/.equin/cache/boot-unsettled/<wt>`): a backend marks its worktree with its
  `start` line, at process start, and only this sweep clears a mark, after reading that
  worktree's boot as settled (ready or exited) or finding it torn down. So a
  never-ready worktree the gateway lists `idle` — after a gateway restart, a
  stop, a kill — is still read (and filed once, as `killed`). The marks are complete
  once stamped `.indexed`; until then (first tick after deploy, or the dir was
  deleted) one full sweep marks every worktree with an open boot.

If the gateway is unreadable this tick (`readFleet` → null), the tick is
skipped rather than guessed; both wedge kinds stay fileable next tick.

## Load-bearing literals

The config `name` `boot-watchdog`, the job name `debug.boot-watchdog-monitor`, the
report kind `boot-wedge`, and the source `server-boot-watchdog` are explicit
literals — persisted config, report dedup, and the `SERVER_REPORT_SOURCES` union
depend on them; do not rename. This watchdog is what turns a never-ready boot
into a report: the `boot` channel is only its evidence and declares no reader.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Boot-wedge report renderer: a one-line Debug → Reports summary for the boot-wedge kind, plus the boot-watchdog budget/lookback config registration. Boot-watchdog, every host's half: registers the boot-watchdog config (budget, lookback) and the boot-wedge report kind. The monitor that files the reports is the machine/ half's.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "boot-watchdog"
    - `Reports.KindView` → `BootWedgeSummary`
  - Uses:
    - `config_v2.ConfigV2`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `reports.Reports`
- Server:
  - Contributes:
    - `ConfigV2.Register` "boot-watchdog"
    - `report-kind` "boot-wedge"
  - Uses:
    - `config_v2.ConfigV2`
    - `primitives/log-channels/log-files.logsDirFor`
    - `reports.ReportKind`
- Machine:
  - Uses:
    - `debug/boot-events.clearBootUnsettled`
    - `debug/boot-events.markBootUnsettled`
    - `debug/boot-events.readBootUnsettled`
    - `debug/boot-events.stampBootUnsettledIndexed`
  - Register: `defineJob('debug.boot-watchdog-monitor')`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `fields/bool/config.boolField`
    - `fields/int/config.intField`
  - Exports (types):
    - `BootWedgeJournal`
    - `BootWedgePayload`
    - `BootWedgeState`
  - Exports (values):
    - `bootWatchdogConfig`
    - `BootWedgePayloadSchema`
    - `describeBootPhases`
    - `describeBootWedge`
    - `humanMs`
- Cross-plugin:
  - Uses tokens: `ui/tokens/color-palette --muted-foreground`

<!-- AUTOGENERATED:END -->
