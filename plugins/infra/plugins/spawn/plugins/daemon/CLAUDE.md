# daemon

Every long-lived process or worker thread a backend keeps running on its own is
**declared once** with `defineDaemon` and started as instances of that
declaration. The primitive owns the spawn, the supervision and the in-memory
record the Background activity catalog lists (its `background-arm` child).
Plan: `research/2026-10-01-infra-long-lived-processes-in-background-catalog.md`.

## Which primitive

| The work | Use |
|---|---|
| A command that runs and ends (git, ps, tar) | `spawnCaptured` / `spawnExpectOk` (`infra/spawn/core`) |
| Out-of-process work that must survive a backend restart | `defineSupervisedJob` (`infra/jobs/supervised-job`) |
| Something that runs for the backend's lifetime, or until stopped | **`defineDaemon`** |
| An in-process tick | `defineTimer` |

## Declaration vs instance

```ts
// module scope — the policy, the same for every instance
export const probeDaemon = defineDaemon({
  name: "paging-probe.probe",                    // unique per process
  description: "Measures event-loop lag …",       // required; what Background activity shows
  startedBy: "boot",                              // or "on-demand" → the entry's trigger
  where: "main",                                  // every-worktree | main | host-singleton
  restart: { kind: "backoff", healthy: "survival" }, // or { kind: "never" }
});
// server/index.ts: register: [probeDaemon]

const p = probeDaemon.spawnProcess({ instance: "lean", argv, onStderrLine });
await p.stop();
```

Four ways to start an instance — the arm decides how liveness is known:

- **`spawnProcess({ argv, env?, cwd?, onStderrLine? })`** — a child process.
  `argv` may be a function, read at each spawn. stdout is ignored; stderr is
  piped line by line only when `onStderrLine` is given. Liveness: the exit event.
- **`spawnWorker({ url, argv?, env?, onSpawn?, onMessage, onError?, stop? })`** —
  a Bun Worker. `onMessage(data, ctx)` gets `ctx.ready()` for a
  `healthy: "ready"` daemon; `stop(worker)` is the graceful half of a stop
  (the primitive terminates afterwards); the instance's `postMessage` reaches
  the current incarnation. Liveness: the `close` event.
- **`launchDetached({ argv, env?, onOutputLine?, pidFile })`** — a bootstrap
  that starts something detached and exits (a release preview), or the
  long-lived process itself (an sdk agent). Liveness: the pid file, watched
  (below); the bootstrap's exit reads it once more. A failed bootstrap with no
  pid file is `exited` with its reason.
- **`attach({ pidFile })`** — a process this backend did not start but runs on
  (the gateway). Liveness: the pid file, watched; a new pid is a restart.
  The call returns it `starting`; its first read lands after.

`launchDetached` and `attach` exist only on a `restart: { kind: "never" }`
declaration (tsc): nothing here can respawn what it is not the parent of.

## Rules

- `register()` before any start, or the start throws (it would run unlisted).
  A start outside `where` throws; a second live instance of a key throws.
- **One supervision loop** (`server/internal/supervise.ts`): respawn after 1 s,
  doubling to 30 s; a death within 2 s of spawn is rapid, and 5 in a row give
  up (`gave-up`, a loud line through `onLog`, the run `failed`). `healthy`
  resets the counters: `ready` on `ctx.ready()`, `survival` once a spawn
  outlives the rapid window. `onState` sees every transition
  (`starting`, `running`, `respawning`, `gave-up`, `exited`, `stopped`) — the
  sentinel maps them onto its status file.
- Each incarnation is a run: `running` while alive, `succeeded` when stopped on
  purpose, `failed` when it exited on its own (a daemon has no successful way
  to end by itself).
- `stop()` cancels a pending respawn, runs the graceful step, SIGTERMs (SIGKILL
  after 5 s) or terminates, and drops the instance. For `launchDetached` /
  `attach` it only drops the record — the owner tears the stack down.
- **Restart-skip.** A backend that adopts new code without restarting keeps
  its supervised instances on the code they were spawned with, so their code
  is judged (`liveSupervisedIncarnations`) and a change refuses the skip. An
  `on-demand` daemon whose instance holds only a cache of its own code's work
  declares `onCodeAdopted: "stop"`: it is not judged, it is stopped on
  adoption (`stopOnCodeAdopted`), and its owner starts it again on next use
  (the faceted-tree worker, `plugin-meta/plugin-tree`).
- **Pid-file liveness is watched, and a get reads memory**
  (`server/internal/pid-file-watch.ts`). The pid file's folder gets a
  children-scope watch through the shared dir hub (`acquireDirWatch`); each
  change of the file is read async (`readPidFile`, one read at a time,
  changes landing mid-read folded into one more) and pushed into the follow
  logic, so `running` / `exited` / a restart fire on the change.
  `instance.pid` / `.state`, `listDaemons` and `daemonRecentRuns` judge the
  HELD read with a `kill(0)` — never the disk — so a process killed leaving
  its file behind (no file event, nothing polls) is seen at the next get.
  Before the first read the instance stays `starting`, never a stand-in
  "absent".
- **Arm, then read.** The watch is live when `acquireDirWatch` resolves
  (`infra/file-watcher`), so the first read, made after it, sees every write
  the watch does not hear. The folder is never created here: while it is
  missing, or after it went or its watch lost events (its watch dropped),
  there is no watch and the read says `absent`. So a get that finds nothing
  alive (`starting`, or an attached instance `exited`) asks for a fresh
  async read, which opens the watch again — a folder that came later is
  caught by the next look, never by a timer. A failure to open it other than a missing folder is reported
  (`reportServerError`) and retried on the next read, which still runs.
- **A bootstrap's exit is judged by a read that started after it.** Each
  read is numbered when it starts; until one numbered past the bootstrap's
  exit lands, a launch is still booting — an older read may predate the
  bootstrap's last write. That read decides: a pid, or the bootstrap's own
  failure, or "no pid file". `stop()` (and a detached instance's final exit)
  releases the watch.
- Piped stderr carries bun 1.3.13's exit-during-pull wedge risk
  (`infra/spawn/CLAUDE.md`). Ask for lines only when you publish them.

## Lint

- `spawn-safety/no-raw-bun-spawn` (`infra/spawn/lint`) exempts this directory
  as part of the spawn chokepoint, and its message routes long-lived children
  here.
- `daemon/no-raw-worker` (`lint/`) bans `new Worker(...)` in server, central
  and shared code outside this plugin. CLI commands and checks keep their own
  short-lived worker threads.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: defineDaemon: the one declared long-lived process or thread a backend runs on its own — a named, described declaration (startedBy boot | on-demand, where every-worktree | main | host-singleton, restart never | backoff) whose spawnProcess / spawnWorker supervise a child process or Bun Worker (one respawn loop: doubling backoff, give-up after repeated rapid exits, healthy on survival or a ready signal), and whose launchDetached / attach follow a detached process by its pid file. Records per declaration its instances (pid, since, restarts, last exit) and each incarnation as a run for the Background activity catalog (onDaemonActivity / listDaemons / daemonRecentRuns).
- Server:
  - Uses:
    - `infra/file-watcher.acquireDirWatch`
    - `infra/file-watcher.DirWatchRelease`
  - Exports (types):
    - `AttachOptions`
    - `DaemonArm`
    - `DaemonDecl`
    - `DaemonDeclBase`
    - `DaemonInstance`
    - `DaemonInstanceInfo`
    - `DaemonRestart`
    - `DaemonSnapshot`
    - `DaemonSpec`
    - `DaemonStartedBy`
    - `DaemonState`
    - `DaemonTransition`
    - `DaemonWhere`
    - `DetachedLaunch`
    - `PidFileRead`
    - `ProcessLaunch`
    - `SpawnedCode`
    - `SupervisedIncarnation`
    - `UnsupervisedDeclExtras`
    - `WorkerDaemonInstance`
    - `WorkerLaunch`
    - `WorkerLaunchContext`
  - Exports (values):
    - `backoffPolicy`
    - `daemonRecentRuns`
    - `DEFAULT_BACKOFF`
    - `defineDaemon`
    - `listDaemons`
    - `liveSupervisedIncarnations`
    - `onDaemonActivity`
    - `parsePidFile`
    - `pidAlive`
    - `readPidFile`
    - `stopOnCodeAdopted`
- Cross-plugin:
  - Imported by:
    - `apps/browser/engine`
    - `build/restart-skip`
    - `conversations/runtime-sdk`
    - `debug/paging-probe`
    - `debug/sentinel`
    - `debug/sentinel/machine-usage`
    - `infra/launcher`
    - `infra/mcp/browser`
    - `infra/paths/root-migration`
    - `infra/spawn/daemon/background-arm`
    - `plugin-meta/plugin-tree`
    - `release`
- Exemptions:
  - Exempts itself from:
    - `daemon/no-raw-worker` — `.` (sanctioned)
    - `boundaries/no-platform-api` — `server/internal/registry.ts`, `server/internal/pid-file-watch.ts` (debt)
  - Exempted by: `infra/spawn/daemon` (0 debt)
- Sub-plugins:
  - **`background-arm`** — Long-lived processes in the Background activity catalog: registers the `daemon` background kind — every declaration made with defineDaemon under Long-lived processes, triggered at boot or on demand…

<!-- AUTOGENERATED:END -->
