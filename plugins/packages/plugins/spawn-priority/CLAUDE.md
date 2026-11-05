# spawn-priority

OS scheduling-priority isolation. The host runs one interactive main backend
plus a fleet of background work (agent sessions, DB forks, worktree checkouts,
agent builds, type-check workers) that would otherwise compete at equal CPU/IO
priority and starve interactive latency — concurrency gates bound *how many*
heavy ops run, but a single build legitimately fans across every core, so only
OS priority can make one launch invisible. Both directions live here: demote
the bulk work below default, and raise main's event-loop thread above it.

- `backgroundArgv(argv)` — prefix an argv array for a spawn.
- `backgroundPrefix()` — the same prefix as a shell-command string, for command
  strings executed by a shell we don't spawn (e.g. tmux session commands, which
  the shared tmux server forks — wrapping the tmux *client* would be a no-op).
- `backgroundShellPrefix()` — the same demotion as a Claude Code
  `CLAUDE_CODE_SHELL_PREFIX`: the path of `bin/background-shell`, which runs
  the one command string the CLI hands it darwinbg, in the CLI's shell (null
  where nothing demotes). An SDK agent sets it on its CLI, so the agent and its
  CLI run in the foreground while every command, hook and stdio MCP server the
  CLI spawns runs darwinbg. The script's flags are pinned to `DEMOTE_FLAGS` by
  `core/internal/background.test.ts`.
- `boostInteractiveQos()` — the opposite direction: raise the CALLING thread to
  user-interactive QoS (`pthread_set_qos_class_self_np`), the scheduler tier
  GUI apps' UI threads run at. Called ONCE at boot by the main backend
  (server-core/bin, gated on `isMain()`), NEVER by an agent-worktree backend —
  that would lift the fleet above its own builds and defeat the isolation. No
  root needed: a process may always raise its own thread's QoS, unlike
  negative nice.

- `readDarwinBackground()` — the calling process's OWN darwinbg state
  (`darwinbg` / `foreground` / `unsupported`). Only a self read is trustworthy:
  measured from an agent shell (2026-10-15), `getpriority` on another pid read
  0 for a darwinbg process, and `taskpolicy -B -p <pid>` exited 0 yet left the
  target darwinbg. A process CAN clear its own state
  (`setpriority(PRIO_DARWIN_PROCESS, 0, 0)`), and children spawned after start
  in the foreground — so promotion has to be done by the process itself.
- `withForegroundPriority(fn)` — that self-promotion, scoped: out of darwinbg
  for `fn`, restored after, each write verified by a read (`setpriority(…, 1)`
  returns 0 and changes nothing; only `PRIO_DARWIN_BG` = 0x1000 demotes). Like
  `boostInteractiveQos`, the caller owns the contract: its callers are
  host-admission's `withHostGrant` (a grant's body, either lane) and the Browser app's
  engine host (`apps/browser/engine`, for its whole life — the user watches
  and types into its pages). It lifts the WHOLE
  process for the async body, so everything else the process runs meanwhile
  is lifted too.
- `leaveDarwinBackground()` — the permanent self-promotion: out of darwinbg
  for the rest of the process's life, answering the state read back. Its
  callers are a serving backend (server-core `bin/index.ts`): once ready, and
  earlier on the gateway's word (`followGatewayBootTier`). The gateway spawns
  a background-started backend under `taskpolicy -b` and means it to serve at
  default priority, but a `taskpolicy -B -p <pid>` from outside is a silent
  no-op (2026-10-31: every promoted worktree backend still darwinbg, starved
  for 30–95 s behind the foreground grant holders), so the backend does it
  itself and logs `[boot] scheduling tier once ready: …`.
- `followGatewayBootTier(req)` / `BOOT_TIER_HEADER` / `BOOT_TIERS` — the
  gateway's readiness probe carries the tier it wants a booting backend in
  (`X-Equin-Boot-Tier: background | foreground`); the first probe saying
  `foreground` (a browser joined the start, or the boot escalated past its
  base deadline) takes the backend out of darwinbg for good. Called first in
  the backend's socket handler, so it lands while the plugin graph is still
  loading. Before it, a demoted boot crawled to its deadline: 60–100 s of
  imports under load vs 2–9 s in the foreground (2026-11-05: the same
  ~5,850-file read+transpile took 8.7–21 s darwinbg and 0.9–1.5 s foreground
  at load 25–30). The Go constants are pinned to these by the
  `spawn-priority:boot-tier-in-sync` check.
- `spawnInForeground(spawn)` — the same self-promotion around ONE
  **synchronous** spawn call: lift, call `spawn` (`Bun.spawn` forks before it
  returns), restore. darwinbg is inherited at spawn, so the child starts in
  the foreground and stays there, while this process is darwinbg again before
  any other callback runs — no leak to the other checks a check runner is
  running concurrently. A callback returning a promise is rejected (by type,
  and by a throw), since whatever it spawned asynchronously would start
  demoted. Caller contract: a holder of a scarce host-pool slot — the
  invariant is that such a holder does its held work in the foreground, since
  everyone queued on the pool waits out its hold. It is reached through
  host-admission's `holder: "foreground"` pools (their `Slot.spawn`), never
  called ad hoc.
- `spawnAtTier(tier, argv, spawn)` / `SpawnTier` — the one place a tier
  (`background` | `inherit` | `foreground`) becomes an argv prefix
  (`backgroundArgv`) or a lift (`spawnInForeground`); `infra/spawn`'s `tier`
  option goes through it.

Mechanism: darwinbg (`/usr/sbin/taskpolicy -b`), inherited by all children.
Every command an agent's CLI spawns runs under it (`backgroundShellPrefix`, set
by `conversations/runtime-sdk`), so all an agent launches starts darwinbg
whether or not the spawn asks for `tier: "background"` — while the agent
process and its CLI stay in the foreground: they answer the backend's socket
and the user's turns, and demoting them starved that for ~90 s under host load
(2026-11-04, research/2026-11-04-conversations-sdk-agent-priority-split.md).
On Apple Silicon this pins the subtree to the efficiency cores and applies the
background disk-IO throttle tier (which only bites under IO contention).
Measured: `-c utility` gives ZERO CPU protection and must not be used; `-b`
keeps the P-cores free for the interactive backends. Details + experiment data:
`research/2026-07-07-global-background-work-priority-isolation.md`.

Escape hatch / A-B harness: `EQUIN_NO_SPAWN_PRIORITY=1` disables all
demotion. Non-darwin falls back to `nice -n 10` (Linux) or no-op — fail-open,
a spawn never breaks because the host lacks a priority tool.

Do NOT demote a backend server process with this (the gateway decides a
backend's start priority; the backend itself leaves darwinbg once ready, the
one thing the gateway cannot do from outside); this is for individual heavy
spawns from within a backend or the CLI.

Everything but `boostInteractiveQos` lives in `core/` (runtime-neutral Node +
`bun:ffi` — never import from `web/`) so core-isolated runtimes can compose
it: the `infra/spawn` primitive's `tier` option and the CLI check runner reach
it via `@plugins/packages/plugins/spawn-priority/core`. The server barrel
re-exports what server consumers use (same-plugin re-export), and
`boostInteractiveQos` stays server-only.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: OS scheduling-priority isolation: backgroundArgv/backgroundPrefix wrap heavy background work (DB forks, builds, worktree checkouts) in darwinbg (taskpolicy -b) so it yields host CPU/IO to the interactive backends, and backgroundShellPrefix does it for every command an SDK agent's CLI launches; spawnInForeground starts a scarce slot holder's child out of darwinbg; boostInteractiveQos raises the calling thread to user-interactive QoS (main backend's event loop only).
- Core:
  - Uses:
    - `infra/launcher/env-names.readEnv`
    - `packages/timed-fs.existsSync`
  - Exports (types):
    - `DarwinBackground`
    - `SpawnTier`
  - Exports (values):
    - `backgroundArgv`
    - `backgroundPrefix`
    - `backgroundShellPrefix`
    - `BOOT_TIER_HEADER`
    - `BOOT_TIERS`
    - `followGatewayBootTier`
    - `leaveDarwinBackground`
    - `readDarwinBackground`
    - `spawnAtTier`
    - `spawnInForeground`
    - `withForegroundPriority`
- Cross-plugin:
  - Imported by:
    - `infra/host/host-admission`
    - `infra/spawn`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `core/internal/background.ts`, `core/internal/darwin-background.ts`, `server/internal/spawn-priority.ts` (debt)
- Server:
  - Exports (types): `DarwinBackground`
  - Exports (values):
    - `backgroundArgv`
    - `backgroundPrefix`
    - `boostInteractiveQos`
    - `followGatewayBootTier`
    - `leaveDarwinBackground`
    - `readDarwinBackground`
    - `withForegroundPriority`

<!-- AUTOGENERATED:END -->
