# systemd-oomd never takes the serving set with a heavy child

2026-11-19. Follows `2026-11-19-global-oomd-deploy-kill.md`, which put main's
deploy build in a scope of its own and saw, on the way, systemd-oomd kill the
gateway's whole unit (63 processes) while an unrelated 4.2 GB app ran.

## Why the gateway was the one killed

systemd-oomd (Ubuntu desktop: `user@.service` has
`ManagedOOMMemoryPressure=kill`, 50 % / 20 s) kills a whole LEAF cgroup under
`user@<uid>.service`. It ranks the leaves by reclaim rate first (pgscan since
its last look), then memory use; a leaf marked `user.oomd_avoid` goes last
(systemd 255 `oomd-util.c`: `oomd_kill_by_pgscan_rate`,
`compare_pgscan_rate_and_memory_usage`). An app holding anonymous memory on a
host with no swap is never scanned; the gateway's unit holds the page cache of
every database file and checkout that Postgres and the backends read, so under
pressure it is the leaf reclaiming most — whoever caused the pressure.

Everything else the app started also lived in that one leaf: every agent,
build, check, test and supervised job a backend or an agent spawned. A heavy
child added its own memory and reclaim to the leaf oomd picks, and died with
the gateway, Postgres and every backend.

## The structure

- **What serves is marked, nothing else.** Login-service units carry
  `ManagedOOMPreference=avoid` (`login-services/machine/internal/systemd-unit.ts`).
  systemd ≥ 250 honours it for a user unit whose cgroup has the owner of the
  monitored `user@<uid>.service` (`oomd_fetch_cgroup_oom_preference`); the user
  manager writes `user.oomd_avoid=1` on the cgroup.
- **Everything the app starts apart from serving is a leaf of its own**,
  through ONE wrapper, `packages/systemd-scope`'s `inAppScope`
  (`<product>-<kind>-<label>.scope`, `systemd-run --user --scope`, which execs
  the command — same pid, stdio, process group and held fds):
  - `daemon` — `infra/spawn/daemon`'s `launchDetached`: sdk agents, browser
    hosts, release previews;
  - `op` — `infra/jobs/supervised-job`'s `startSupervisedRun`: toolbar builds,
    every job's child, test batches, record verification;
  - `op` — CLI commands declared `heavy: true` (`build`, `push`, `check`,
    `test`, `run`) re-execute themselves into one when they are not in an op
    scope already (an agent's build leaves the agent's scope, so oomd taking the
    build leaves the agent to read the failure); a nested op stays in its
    parent's;
  - `op` — main's deploy build (`converge.ts`).
- The name is the marker: `/proc/self/cgroup`'s leaf says whether a process is
  already in an op scope; a re-exec that does not find itself in one fails
  loudly instead of looping (`EQUIN_OP_SCOPE_REEXEC`, for its own pid only).
- A backend spawns through `unprobedScopeHost`: the child (`/bin/sh`) looks for
  the user manager's socket, so the backend's event loop does no stat and a
  portable `server/` folder reaches no filesystem.

Short-lived children of a backend (`spawnCaptured`: git, ps…) and its attached
daemons and worker threads stay in the gateway's unit, now avoided with it.

## Two bugs found on the way (fixed here)

- **Every `systemctl --user` from main's backend failed** "Failed to connect to
  bus: No medium found": the runtime tree's declared environment does not carry
  `XDG_RUNTIME_DIR`. Main's follow step could therefore never rewrite an
  installed unit on Linux — the `OOMPolicy=continue` of bd82e3510d never
  reached a running gateway either. `systemd.ts` now passes
  `XDG_RUNTIME_DIR=/run/user/<uid>`.
- **A follow attempt was recorded before the service state was read**, so a
  failing read marked that unit definition "attempted" forever. The state is
  read first now.

## Proof (fresh 8 GB Ubuntu 24.04 desktop VM, systemd 255, no swap, then deleted)

`install.sh` of main c20cbd866a, then the change landed as commits on the VM's
main (deployed by its convergence run; a third advance ran the fixed follow).
oomd forced to 1 % / 5 s (`ManagedOOMMemoryPressureLimit=1%`,
`DefaultMemoryPressureDurationSec=5s`). Evidence: `~/equin-vm-runs/oomd2/`.

- After the follow: the installed unit holds `ManagedOOMPreference=avoid`,
  the gateway's cgroup `user.oomd_avoid=1`, same main pid (handed over, no
  restart).
- `./equin run` started INSIDE the gateway's cgroup re-executed itself, same
  pid, into `equin-op-run-<pid>-….scope`; its child ran there.
- A detached launch (the daemon wrapper's argv, an environment with no PATH,
  fd 3 held) ran in `equin-daemon-….scope`, same pid, fd 3 readable.
- Supervised runs (spare refill, fullscreen budget, idle test batches, record
  verification) and main's deploy build each started in their own
  `equin-op-….scope`.

The incident's shape (`replay3.sh`): a 5 GB "other app" (anonymous), then three
readers churning a 2.5 GB file INSIDE the gateway's cgroup (as Postgres and the
backends do):

| gateway unit | oomd killed | gateway |
| --- | --- | --- |
| preference `none` (as before this change) | `dev.equin.gateway.service`, 57 processes, 20 s into the churn (its pgscan rate 1.6 M per interval, top) | restarted 10 s later, every backend cold |
| `avoid`, run 1 | two idle test batches (each its own op scope), then the other app | same pid, serving |
| `avoid`, run 2 | the other app | same pid, serving |

## Left open

- **oomd can pick the user manager itself.** In one avoided run oomd's top
  leaf was `user@1000.service/init.scope` (the `systemd --user` process): it
  killed it, and systemd then SIGKILLed the whole `user@1000.service` —
  gateway, Postgres, backends, the desktop's own services. `init.scope` cannot
  be marked from user space (`set-property init.scope ManagedOOMPreference=…`
  is accepted, no xattr appears). Not caused by this change and not fixable by
  a user unit; it needs a system-level answer (task filed).
- **A user-manager `daemon-reload` makes systemd-oomd stop monitoring the
  session** until the system manager reloads (seen repeatedly, systemd 255):
  every unit write by the follow step does one. It makes oomd LESS likely to
  act, not more.
- The re-exec costs one more CLI start (~0.5 s) per top-level heavy command
  on a Linux host with a user manager; nothing on macOS.
- macOS: no counterpart (jetsam kills processes, not groups); nothing changes.
