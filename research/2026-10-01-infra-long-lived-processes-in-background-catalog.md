# Long-lived processes in the Background activity catalog

## Context

Debug → Background activity (`plugins/infra/plugins/background`, plan
`research/2026-09-30-infra-background-activity-catalog.md`) lists jobs, timers,
warm-ups and, since the last commit, file watchers. It does not list the
long-lived processes and threads the backend keeps running for its whole
lifetime. The original plan deferred them: "long-lived children … stay as-is".

| What | Where | Shape today |
|---|---|---|
| Sentinel sampler | `debug/sentinel/server/internal/worker-host.ts` | A Bun `Worker` thread, host-singleton, started on boot. It respawns with a 1→30 s backoff and gives up after 5 exits within 2 s. A `ready` frame resets the counters. Stop is graceful (`stop` → `stopped` ack → `terminate`). |
| Paging probes (×3 variants) | `debug/paging-probe/server/internal/probe-host.ts` | Raw `Bun.spawn`, main and dev only, off by default. Stderr is piped to a log channel. The respawn loop is copied from the sentinel; surviving past 2 s counts as healthy. |
| Release previews | `release/server/internal/preview-manager.ts` | Raw detached `Bun.spawn` of `<artifact>/launch`, started on demand per run. `launch` exits right after boot, so the long-lived thing is the detached gateway it starts. Liveness comes from the gateway pid file under the preview's data root. No respawn. |
| Go gateway | `infra/launcher/server/internal/boot.ts` | Started by the CLI, the release launcher or launchd, never by the backend. The gateway is the backend's parent stack. Its pid file is at `gatewayPidFile(root)`. |

Nothing ties these together:

- No human description.
- No start time or restart count.
- No liveness that a person can see.
- No shared primitive. `infra/spawn` only knows one-shot spawns. `spawn-safety/no-raw-bun-spawn` handles long-lived children with an entry in its `ignores` list, so a new one shows up unseen. `new Worker(` is not linted at all.
- The respawn policy is copied by hand in two places.

**Outcome:**

- One declaration, `defineDaemon`, carries a required description. It owns spawning, supervision and the in-memory record of each instance.
- A `daemon` background kind lists every declaration, with what runs, since when, how often it restarted, whether it is alive, and what it costs (RSS/CPU).
- Lint routes new long-lived spawns and Workers through `defineDaemon`.

**Out of scope:**

- Supervised-job children. They are already shown as their jobs.
- Agent sessions and terminals (tmux).
- The host-semaphore `flock-wait` helpers. They are lock plumbing, alive only while a slot is held.

## Design

### New plugin `plugins/infra/plugins/spawn/plugins/daemon`

It is nested under `infra/spawn`, the primitive it is built from, because
`infra/CLAUDE.md` forbids a new top-level infra plugin without approval.
`spawn` stays the node-only, CLI-importable chokepoint for one-shot children;
`spawn/daemon` adds the server-side long-lived half. It is a server barrel plus a `background-arm`
sub-plugin, mirroring `infra/file-watcher` and its `plugins/background-arm`. The
daemon barrel must not import the catalog: the sentinel loads early, and the
arm keeps the edge one-directional.

```ts
// server: declare at module scope, mount in `register: [...]`
export const sentinelDaemon = defineDaemon({
  name: "sentinel.sampler",            // unique per process, the catalog entry name
  description: "Samples host load …",  // required, non-empty (throws at define)
  startedBy: "boot" | "on-demand",     // → trigger {kind:"boot"} | {kind:"on-demand"} (existing variants)
  where: "every-worktree" | "main" | "host-singleton", // scope + runsHere derived; start() throws off-scope
  restart:
    | { kind: "never" }
    | { kind: "backoff"; minMs?: 1000; maxMs?: 30_000; rapidExitMs?: 2000;
        maxRapidFailures?: 5; healthy: "survival" | "ready" },
});
```

#### Starting an instance

`start(opts)` returns a `DaemonInstance`. The registry key is
`(name, instance ?? "default")`; a second start of a live key throws. Three
launch arms form one discriminated union:

- **`{ process: { argv, env?, cwd?, stderr?: LogChannel } }`**
  - The primitive calls `Bun.spawn` itself. Because it is nested under `infra/spawn/`, the lint rule's existing path exemption already covers it, so the rule needs no edit.
  - stdout is ignored. Stderr is drained into the channel by one implementation, moved out of `probe-host.pipeStderr`.
  - Liveness comes from `onExit`.
- **`{ worker: { url, argv?, env?, onMessage, stop? } }`**
  - The primitive calls `new Worker`. `onMessage` receives frames; `ctx.ready()` is how a `healthy: "ready"` daemon reports a healthy spawn (the sentinel's `ready` frame calls it).
  - `stop(worker)` is an optional graceful stop: the sentinel's stop-ack handshake. The primitive then calls `terminate()`.
  - Liveness comes from the `close` and `error` events.
- **`{ detached: { argv, env?, output?: LogChannel, pidFile } }`**
  - For a bootstrap command that starts a detached process and exits (release previews).
  - The bootstrap's output is pumped to the channel. Liveness is read from `pidFile` with `isRunning(pid)`, moved from `infra/launcher` into this plugin's core.
  - A missing pid file means "starting".
  - `restart` must be `never`; tsc enforces this by making `detached` accept only a `never`-restart declaration.

The registry also offers `attach({ instance?, pidFile })`. It records a process the backend did not start but whose
lifetime is the backend's concern. There is no spawn and no restart. Liveness
comes from the pid file. The gateway uses it.

`DaemonInstance`:

- `stop(): Promise<void>` runs the graceful path, then SIGTERM or terminate, clears the respawn timer and drops the record.
- `pid`.
- `state`.

#### Supervision

There is one implementation of the backoff, rapid-exit and give-up loop. It
replaces both hand-rolled copies.

- The give-up is loud. It logs to the channel, the run's error says
  "gave up after 5 exits within 2 s", and the entry turns `failed`.
- The sentinel keeps its own status sink (the Machine watcher row). It
  subscribes to the instance's state transitions instead of computing them.

#### Record (in memory, per declaration and instance)

- `startedAt` (the first start)
- `spawnedAt` (the current incarnation)
- pid, or "thread in backend pid N" for a Worker
- `restarts`
- last exit (code, signal, at)
- state: `starting | running | respawning | gave-up | stopped`

Each incarnation is a **run** in the 20-slot ring the catalog already
understands:

- `running` while alive
- `succeeded` when stopped deliberately
- `failed` on an unplanned exit, with the exit code or signal as the error

So `lastRun` and `history` give "alive?" and "restarted how often" without any
new schema. `onDaemonActivity(listener)` notifies on every state transition,
throttled like the file-watcher registry: on each flip, never more than one per
60 s of quiet otherwise.

### Background arm `infra/spawn/plugins/daemon/plugins/background-arm`

```ts
defineBackgroundKind({ kind: "daemon", order: 40, label: "Long-lived processes",
  list: listDaemonEntries, recentRuns: daemonRecentRuns });
// onReady: onDaemonActivity((name) => kind.changed(name))
```

Each declaration maps to one entry:

- group "Long-lived processes"
- trigger `boot` or `on-demand`
- `scope` and `runsHere` from `where`
- `declaredIn` from `registeringPlugin`
- `canRunNow: false`

Facts:

- `Instances`: count. A declaration with no live instances still lists, for example "0 — off (paging-probe.enabled)" when not started.
- `Running`: one row per instance, max 10. Each row reads `<instance> · pid N · since HH:MM · N restarts · <rss> MB · <cpu>%`.
- `Last exit`: code or signal and time.
- `Restart policy`: for example "Backoff 1–30 s, gives up after 5 exits within 2 s", or "Never".
- `Liveness`: for example "Exit event" or "Pid file <path>, checked when this list loads".
- `Runs in`: "This process, in memory — history resets when it restarts". The same line as timers and watchers.

RSS and CPU come from one `spawnCaptured(["ps","-o","pid=,rss=,%cpu=","-p", pids], { timeoutMs: 2000 })` per `list()` call, only when at least one pid exists. A Worker reports the backend's own numbers, labelled as such.

Pid-file liveness is read at `list()` time, so there is no polling. The
catalog loader runs on page subscribe and on every other provider's push. A
preview gateway that dies is therefore seen on the next load, not pushed
instantly. The `Liveness` fact says so. The trade-off is acceptable here, and
this is the only shape that needs no watcher on a process we did not parent.

### Migrations

- **Sentinel** (`worker-host.ts`):
  - Declare the daemon with `where: "host-singleton"`, `restart: backoff` and `healthy: "ready"`.
  - Delete `scheduleRespawn`, the counters and the timer.
  - `startSentinelWorker` becomes `sentinelDaemon.start({ worker: … })`. Frames are dispatched through `onMessage`, and the status sink listens to state transitions.
  - The latch, threshold-push and stop-ack behaviour is unchanged.
- **Paging probe** (`probe-host.ts`):
  - One declaration, with `where: "main"`, `restart: backoff` and `healthy: "survival"`.
  - Three instances, keyed by variant.
  - Delete the respawn loop and `pipeStderr`.
  - When the probe is disabled, the entry still lists with 0 instances.
- **Release previews** (`preview-manager.ts`):
  - One declaration, `startedBy: "on-demand"`.
  - One instance per runId, using the `detached` arm with `pidFile: gatewayPidFile(dataRoot)`.
  - `gatewayAlive` is replaced by the instance's liveness.
  - `stopPreview` calls `teardownSelfContainedApp`, then `instance.stop()` to drop the record.
  - The boot-time orphan reconcile is unchanged.
  - Remove the file from the spawn lint's `ignores`.
- **Gateway**:
  - The launcher's server barrel declares `hostGatewayDaemon` (`startedBy: "boot"`, `where: "every-worktree"`).
  - `onReady` attaches it to `gatewayPidFile(<this process's data root>)`.
  - Description: the Go gateway that routes `*.localhost:9000`, supervises this backend, Postgres and PgBouncer, and is started by `./equin start`, launchd or the release launcher.
  - `spawnGatewayDaemon` stays a raw spawn in `boot.ts`. It runs in the CLI and launcher, not in the backend, so there is no catalog to register into. Its `ignores` reason is rewritten to say that.

### Lint

- `spawn-safety/no-raw-bun-spawn`:
  - The message says: long-lived children → `defineDaemon` (`@plugins/infra/plugins/spawn/plugins/daemon/server`).
  - The "permanent long-lived" ignores group shrinks to streaming one-shots and non-backend launchers. Each entry gets a reason that says why it is *not* a daemon: backup, host-semaphore, supervisor, tmux, `boot.ts`.
- New `daemon/no-raw-worker` in `infra/spawn/plugins/daemon/lint/`:
  - Bans `new Worker(` in `/server/`, `/central/` and `/shared/` outside `infra/spawn/plugins/daemon/`. Tests are skipped.
  - Structure copied from `watcher-safety/no-raw-fs-watch`, with an empty `ignores` list.
  - Includes a `*.test.ts` covering the plain, aliased and `globalThis.Worker` forms.

### Docs

- `infra/spawn/plugins/daemon/CLAUDE.md`, covering when to use it versus `spawn`, `supervised-job` and timers.
- Update the catalog plan's out-of-scope line and `background/CLAUDE.md`'s arm list.
- `infra/spawn/CLAUDE.md`'s exception policy now points to `defineDaemon`.
- Plugin docs are regenerated by the build.

## Critical files

- New: `plugins/infra/plugins/spawn/plugins/daemon/{server/index.ts, server/internal/{define,registry,supervise,launch}.ts, core/ (pid-file liveness), lint/, CLAUDE.md}`
- New: `plugins/infra/plugins/spawn/plugins/daemon/plugins/background-arm/server/{index.ts, internal/provider.ts}`
- Edit:
  - `debug/sentinel/server/internal/{worker-host,sampler}.ts`
  - `debug/paging-probe/server/{index.ts, internal/probe-host.ts}`
  - `release/server/internal/preview-manager.ts`
  - `infra/launcher/server/{index.ts, internal/boot.ts}`
  - `infra/spawn/lint/{index.ts, no-raw-bun-spawn.ts}`
- Reuse:
  - `defineBackgroundKind` (`background/plugins/catalog/server`)
  - `RECENT_RUNS_MAX` and the run and entry schemas (`catalog/core`)
  - `registeringPlugin`, the same way `file-watcher/server/internal/define.ts` uses it
  - `isHostSingleton`, `isMain`, `spawnCaptured`
  - the file-watcher registry's throttle pattern

## Verification

1. Run `./equin test plugins/infra/plugins/spawn/plugins/daemon`. The supervision unit tests use a fake spawn and cover:
   - backoff doubling
   - a rapid-exit give-up
   - `ready` and survival healthy resets
   - stop with no respawn
   - the `detached` pid-file states (missing → starting, dead → failed)
   - the lint rule tests
2. Run `./equin check` (type-check, eslint, boundary rules, plugins-doc-in-sync).
3. Run `./equin build`, then `screenshot.ts --path /debug/background` and a screenshot of the Sentinel entry's detail pane. Expect the "Long-lived processes" group to show:
   - the sentinel (on main; elsewhere as "not in this worktree")
   - the gateway with its pid and uptime
   - paging probe with 0 instances
4. Start a release preview from Studio and confirm a preview instance appears. Stop it and confirm it disappears.
5. On main with `paging-probe.enabled`, `kill -9` a probe pid. Expect the restart count to go up and a `failed` run in Recent runs, followed by a `running` one.
