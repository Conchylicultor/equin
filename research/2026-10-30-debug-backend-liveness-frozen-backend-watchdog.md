# A frozen backend is noticed from outside the process

Task: task-1793371985-w37e6p (follow-up of
`research/2026-10-30-apps-sonata-midi-folder-probe-off-the-js-thread.md`).

## Problem

On 2026-10-11 main's JS thread froze 1 s after the gateway saw it ready, for
5.5 h (a `realpathSync` behind a macOS permission prompt). Two worktree
backends froze the same way. Nothing was reported while it lasted:

- every in-process detector (health sampler → stall-monitor, stuck-spans,
  boot-monitor) runs on the frozen thread;
- boot-watchdog only judges boots that never reach `ready`, and this one had;
- the gateway stops asking a backend anything once it is ready.

A process cannot report its own freeze. Something outside it must notice.

## Who observes: central

| Candidate | Outside every backend? | Deployed by `./equin build`? | Verdict |
| --- | --- | --- | --- |
| gateway (Go) | yes | **no** — a gateway change waits for `./equin start --force` | best long-term owner of lifecycle, but undeployable/unverifiable here |
| main (job or sentinel worker) | not for main itself | yes | misses main, the 10-11 case |
| **central** | yes (pinned singleton, its own process; it did not freeze on 10-11) | yes — restarted on every main build | **chosen** |

Central has no reports table, so:

1. **Detect (central).** A central timer, `debug.backend-liveness-probe`, every
   15 s: read the gateway fleet, and for every `starting` / `running` /
   `restarting` backend except central itself `GET /api/health/ready`
   **straight on its Unix socket** (5 s timeout). Any HTTP answer — 200, 503
   while booting, 403 — proves the JS thread ran, so a freeze *before* ready
   (no answer at all on a bound socket) is caught as well as one after.
   Probing the socket, never through the gateway, means the probe neither
   cold-starts a backend nor counts as activity (so idle sweep still works).
2. **File (central → `reports/outbox` → main).** The existing outbox is how a
   process with no server files a report: central writes `backend-frozen`
   with `fileReportFromProcess`, main's outbox watcher drains it on the file
   change. Reported when the backend crosses 60 s unanswered, again every
   minute while it lasts, and once when it ends (`answered` / `exited` /
   `paused`). Fingerprint `backend-frozen:<worktree>`.

(An earlier draft kept its own episode file and a per-minute main job folding
it; the outbox already is that hand-off, push-driven and durable.)

A worktree freeze is reported live, within ~75 s. **Main's own freeze is
detected live but filed when main's thread runs again** (or by the next main
process): the report table and the bell are main's, and nothing can file into
them while main is frozen. The outbox entry is the durable record in between.

## Not a freeze

- **Machine sleep.** The episode clock is *observed awake time*: each tick adds
  the time since the previous tick only when that interval was normal
  (≤ 3 × cadence) and the tick's own probes did not overrun (a probe spanning a
  suspend). Sleep, or central itself stalling, adds nothing. After wake a
  backend answers at once, so the streak resets.
- **A deliberately paused backend.** A probe miss checks the process state
  (`ps -o stat=` on the gateway's pid sidecar): stopped (`T`, SIGSTOP / a
  debugger stop) is paused, never frozen, and closes an open episode as
  `paused`.
- **A boot not listening yet.** No socket file → not judged.
- **A stopped backend.** The gateway lists it as idle / stopping or its process is gone → no probe; an open episode closes as
  `exited`.

## Reproduction

`POST /api/debug/backend-liveness/freeze { seconds }` blocks the JS thread of a
**worktree** backend (refused on main) with `Atomics.wait`, after answering.
Freeze a worktree backend 4 min → `backend-frozen` row in main's `reports`
while it is still frozen; SIGSTOP the same backend 3 min → no row.

## Out of scope

- Central itself is not watched (main could probe it — a follow-up if wanted).
- Moving the probe into the gateway once a gateway restart can ship with it.
