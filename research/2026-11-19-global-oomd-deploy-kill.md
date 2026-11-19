# A deploy systemd-oomd kills is told to the user

2026-11-19. Task: on Ubuntu desktop a deploy killed by systemd-oomd stayed
`killed` (developers only), so the user never heard their update did not
deploy. Follows `2026-11-19-global-8gb-deploy-check-pass-memory.md`, which made
a kernel OOM kill end `out-of-memory` (exit 71: a user bell and an "Update not
deployed" health row) by reading `/proc/vmstat`'s `oom_kill`.

## What oomd does (measured, Ubuntu 24.04 / systemd 255, Tart VM, 8 GB, no swap)

- systemd-oomd is not the kernel's OOM killer: it SIGKILLs every process of
  the leaf cgroup reclaiming the most, once `user@<uid>.service`'s memory
  pressure stays above its limit (Ubuntu: 50 % for 20 s). `oom_kill` never
  moves; the waiting parent sees a plain SIGKILL.
- **Leaf = the gateway's whole service.** Everything a deploy runs (the
  convergence run, the build, its checks) lived in `dev.equin.gateway.service`
  with the gateway, Postgres and every backend. A synthetic unit shaped like it
  (`OOMPolicy=continue`, a child allocating) was killed whole: "systemd-oomd
  killed 9 process(es) in this unit", `Result=signal`.
- **A child in its own `systemd-run --user --scope` is its own leaf**: oomd
  killed the scope (6 processes) and the parent unit kept running.
- **The trace it leaves.** The user manager writes a structured record to the
  user's journal: `MESSAGE_ID=d989611b15e44c9dbf31e3c81256e4ed`
  (`SD_MESSAGE_UNIT_OOMD_KILL`), `USER_UNIT=<unit>`, `N_PROCESSES`, readable
  with `journalctl --user` (the VM's user was not in `adm`). Written whatever
  the unit's `OOMPolicy`; followed by the unit's "Consumed …" record.
- **Not usable:** the scope's `Result=oom-kill` is set only with
  `OOMPolicy=stop`, which also stops the scope on any KERNEL OOM kill inside
  it — one type-check worker killed would SIGTERM the build, which would then
  record itself `killed` instead of judging the lost step. The cgroup's
  `memory.events` count kernel kills only. oomd's own "Killed …" line is in the
  SYSTEM journal (needs `adm`). The cgroup xattr `user.oomd_ooms` disappears
  with the cgroup.
- `systemd-run --user` needs `XDG_RUNTIME_DIR` ("Failed to connect to bus: No
  medium found" without it); the runtime tree's declared environment does not
  carry it, so it is derived (`/run/user/<uid>`) and handed to `systemd-run`
  only.

## What changed

- `packages/systemd-scope` (new): `userScopeHost` (Linux with
  `/run/user/<uid>/systemd/private`), `inOwnScope` (`systemd-run --user
  --scope --quiet --collect -p OOMPolicy=continue`, which execs the command —
  same pid, stdio, signals) and `readScopeOomdKill` (re-reads the unit's
  journal records every 250 ms, bounded at 10 s, until an oomd kill or the
  unit's stop is recorded; total — `unknown` on anything else).
- Main's convergence run starts its build in `<build id>.scope`. A build it
  sees SIGKILLed is closed `out-of-memory` when the journal names its scope
  (`deadBuildExitCode` takes both pieces of evidence: the kernel counter and
  the scope record), and the run's log says which.

## Proof (fresh 8 GB Ubuntu desktop VM, `ubuntu-desktop-minimal`, then deleted)

Install of main 428f402a95 (`install.sh --terminal`, 4 m 21 s); the fix
landed as a commit on the VM's main (deployed, cold, 13 min). Evidence:
`~/equin-vm-runs/oomd/` (deploy log, journal lines, screenshots).

| advance | conditions | outcome |
| --- | --- | --- |
| empty commit | normal | build in `build-…sajr9b.scope` (convergence run stays in the gateway's service), deployed in 28 s, scope collected |
| `skgzh0` | oomd forced (`ManagedOOMMemoryPressureLimit=1%`, 5 s), cold check pass, another app holding 1.8 GB | oomd killed `build-…skgzh0.scope` (4 processes) after 5 m 40 s; `oom_kill` unchanged (1 → 1); the run logged "systemd-oomd killed its scope (4 processes): out of memory", closed it 71; user bell "equin couldn't update"; health row "Update not deployed"; the gateway kept serving |
| retry | the other app gone | deployed, 11.5 min |

oomd was forced to a 1 % / 5 s trigger: the real 50 % / 20 s is rarely crossed
by a deploy alone (a synthetic hog peaked at ~2.6 %). Same kill path, lower
trigger.

## Seen on the way (task-1795024098-zdoe2o's subject)

Starting a 4.2 GB "other app" (before any deploy) made oomd kill
`dev.equin.gateway.service` — 63 processes: gateway, Postgres, every backend —
not the hog: with no swap the kernel does not scan anonymous memory, so the
reclaiming leaf was the gateway's page cache. A scope of its own makes the
BUILD a separate leaf; it does not shield the gateway when the gateway is the
leaf reclaiming most. Agent builds, checks and tests, and agents themselves,
still run in the gateway's service.

## macOS

No counterpart a process can read cheaply: jetsam's kills are in the unified
log only (`log show --predicate 'eventMessage CONTAINS "memorystatus"'`, seconds
per query, its record format private). A macOS build killed for memory stays
`killed`. Not built.
