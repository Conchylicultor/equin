# Main's deploy must not run inside main (design note, D22 — held)

Status: **option A approved and implemented** (2026-11-10). D12 (frozen
per-commit copy, task-1793896151-00k5ry) stays parked; the convergence run is
its seam. See "As built" at the end.

## Incident

2026-11-08 18:05–18:32 CET: main crash-looped on a boot error; the fix
2baf0e2a3b landed at 18:18 while a build of 9b06a6dcc5 (one commit earlier)
was running. That build ended 18:21:03, main had no backend 18:21–18:32, so
its terminal-edge reconcile never ran and nothing built the fix. Recovery was a
person reloading the gateway (the onReady reconcile started dcc70defd9 at 18:32:43).

## What triggers and runs main's build today

Every edge AND the runner live in main's own backend (`plugins/build/machine`):

| Edge | Where | Needs main's backend up |
|---|---|---|
| `refs/heads/main` advance | git-watcher (@parcel/watcher, in-process) emits durable `git.refAdvanced` (main only) → `Trigger` → `build.run` job → `reconcileDeployment` | yes (watcher, emitter and job worker are all in the backend) |
| build reached terminal | supervised job `onEnded` (`run-state.ts`) | yes (workflow resumes in a live backend) |
| backend boot | `onReady` → `reconcileDeployment` | yes, by definition |
| compositions config change | `watchConfig` in `onReady` | yes |
| 15-min cron | `build.composition-tick` job | yes |
| debounce + decision | `build.run.debounced` → `decideBuilds` (pure `wantsBuild` + `compositionWantsRebuild` over Postgres + git + dist pins) | yes |
| runner | `build.run.supervised`: claim `build_runs` row, spawn detached `./equin build --allow-main`, suspend | yes (spawned by the backend's job worker) |

What does NOT need main's backend: the CLI build itself. `./equin build` from
main's checkout already mints/closes its own `build_runs` row
(`run-ledger/cli` recorder, `insertRun`), talks to Postgres (gateway-supervised)
and asks the gateway to restart the backend. So "main can serve" is a
precondition only of *starting* a build, not of running one.

## What would have to move

1. **The trigger** — out of the backend into a process that is up whenever
   anything is. Candidate: the gateway (launchd-supervised Go; already watches
   files with an fsnotify + periodic reconcile backstop in `registry.go`,
   already spawns children with a declared env in `env.go`/`supervisor.go`,
   already files reports through the outbox). It would watch main's
   `refs/heads/main` (loose ref + `packed-refs`) and fire on: ref advance
   (trailing debounce), its own boot, and its deploy child's exit. Policy-free:
   on an edge, if no deploy child is running, spawn one convergence run.
2. **The decision + runner** — into a CLI entry run from main's checkout, e.g.
   `./equin build --allow-main --converge`: re-derive `decideBuilds` from
   durable state (needs `decideBuilds`/`lastClosedAttempt`/`readDeployment`
   callable without the server runtime — today they import `db` from
   `database/server` and `getConfig`/`isMain` singletons, so they need a
   CLI-side binding), exit 0 when nothing is wanted, else run the build in-process
   with its own ledger row. The committed code decides, not the gateway.
3. **Delete** the `refAdvanced → build.run` Trigger, `build.run.debounced`, the
   backend-side `onEnded → reconcileDeployment` and boot reconcile. Config watch,
   composition tick and the Build/Serve buttons become optional "ask the
   gateway to run a convergence pass" edges (a gateway HTTP/control endpoint),
   so there is exactly one runner. (`build.run.supervised` for worktree
   Build/Serve buttons can stay — it is not main's recovery path.)

Termination is unchanged: `wantsBuild` refuses a target already attempted (ok
or failed), so the gateway's "child exited" edge re-runs `--converge`, which
finds HEAD attempted and exits 0. A commit that fails to boot stays failed;
the next push is the next attempt — main heals by a push, never by a person.

## Options

- **A. Gateway trigger + CLI `--converge` runner** (above; the decision in the
  task). Tiny Go (ref watch + debounce + single-child spawn), all policy in TS.
  Cost: the gateway changes only on `./equin start --force`, so the Go part
  must be small and stable; the env the build needs (PATH, HOME, data root) is
  the gateway's declared child env, which already exists.
- **B. A separate launchd "deployer" process** (TS, main's code at a fixed
  snapshot). Independent of the gateway, but one more supervised service that
  itself runs main's code — if main's code is broken it can fail the same way,
  unless it runs from a frozen snapshot (→ D12).
- **C. Keep it in the backend, add an outside watchdog** (gateway notices
  "main has no healthy backend and HEAD ≠ deployed" and runs a build). Smaller
  change, but two runners, and the normal path still depends on main serving.
- **D. Central runs it.** Central is gateway-supervised and survives a main
  backend crash, but runs main's code from the same mutable checkout and its own
  boot can break the same way; moves the dependency, doesn't remove it.

Recommendation: **A**, sequenced with D12.

## Relation to D12 (frozen per-commit snapshot)

D12 wants main's backend/central/children to run from an immutable
per-commit snapshot that the deploy materializes and swaps to. That makes the
*deployer* the natural owner of "materialize snapshot at SHA → build there →
swap", which is exactly the runner of option A. So:

- Doing A first gives D12 its seam: the `--converge` runner, started by the
  gateway from the checkout, becomes "materialize snapshot, build in it, tell
  the gateway to swap". The gateway trigger doesn't change.
- Doing D12 first inside the backend would build the swap into the very loop
  A deletes.
- With D12, a `--converge` run reads the *new* commit's code from its snapshot,
  so "the commit being deployed decides with its own code" holds without
  reading a tree that `push` is fast-forwarding (today the runner would read
  main's live checkout — the torn-read risk D12 names; the tree-lock bounds it
  meanwhile).

## Diagnosability while main is down

The equin MCP tools (`query_db`, reports, timeline), the UI and the bell are all
served by main's backend, so an agent diagnosing a down main loses them at the
same moment. Under A the gateway-filed reports (outbox) and `build_runs` rows
written by the CLI survive; logs remain on disk
(`~/.equin/worktrees/main/logs/*.jsonl`, `runs/build-<id>.log`). Worth a
follow-up: the gateway report when a convergence run fails, so the failure is
filed without main.

## Done-when (if approved)

With main's backend unable to boot (a commit that throws at boot), pushing a fix
builds and deploys it with no gateway reload or manual build — exercised end to
end; `plugins/build/CLAUDE.md` and `gateway/CLAUDE.md` updated.

## As built (2026-11-10)

- **Gateway** (`gateway/main_deploy.go`, `-main-checkout`, passed only by
  `./equin start`'s dev launch): fsnotify on `.git/refs/heads` + `.git`, any
  event re-reads `refs/heads/main` and a changed value is an edge (kqueue
  coalesces two quick renames into one batch — found by the Go test); 30 s
  re-read backstop; 5 s trailing debounce; boot edge; `POST
  /gateway/deploy/converge`; `GET /gateway/deploy`. One run at a time, an edge
  during a run starts one more after it. The run gets its own process group,
  writes `logs/gateway/deploy/main.log` directly (outlives a gateway restart,
  `EQUIN_BUILD_DETACHED=1`). A failed run → `main-deploy-failed` report.
- **Runner**: `./equin build --allow-main --converge`
  (`framework/cli/build`'s `cli/internal/converge.ts`): wait out the checkout's
  build lock → `decideConvergence` (`build/converge`) → claim the `build_runs`
  row → run the build attached, under that id → close the row → decide again.
- **Decision** reads durable state only: `readServedDeployment` (HEAD + the
  served dist; no server carrier — it lives in a backend's memory),
  `lastClosedRun` (new hand-SQL ledger read), config off disk. Compositions on
  main's checkout only; `--converge` in any other checkout converges that
  checkout's own app, which is what made a safe end-to-end proof possible.
- **Deleted**: the `refAdvanced → build.run` trigger, `build.run.debounced`,
  `reconcileDeployment`, `wants-build.ts`, the boot/terminal reconciles.
  Optional backend edges POST the gateway: the compositions config watch, the
  composition tick, a button build ending. The bell for gateway-run builds:
  `onAutoBuildTerminal` on the run-terminal marker and at boot (last 24 h).

### End-to-end proof, on a throwaway setup

Real main is never touched. A standalone `git clone` of the branch (its own
`main`, its own namespace `cvge2e-b99608` on the real gateway, DB forked) plays
main; a second gateway from this branch's binary (port 9107, isolated registry,
sockets, logs and outbox, no managed services) is its trigger with
`-main-checkout <clone>`.

1. Gateway boot edge → run builds and deploys the clone (A) → "converged".
2. Commit B (a throw in a plugin's `onReady`) → ref edge → built and deployed
   OK: an `onReady` failure is isolated per plugin, not a boot failure.
3. Commit B′ (a throw in the backend's serving entry) → ref edge → build
   "FAILED — backend never ready", frontend rolled back → the run decides
   "converged at B′" (failed = attempted, no retry).
4. Stop the namespace's surviving backend: every start now fails ("backend
   spawn failed: backend exited before ready") — the incident state.
5. Commit C (the fix) at 22:35:36 → no other action → the trigger's ref edge
   started the run 6 s later, it built and deployed C, and
   `/api/health/ready` answered 200 at 22:36:23. Ledger: A ok, B ok, B′ exit 1,
   C ok — all `trigger=auto`.
6. Bells: B′'s "Build failed" was rung by C's backend at boot (told once the
   namespace was back). A and C were rung twice (`count: 2`): the marker edge
   and the boot catch-up raced on "not told yet". Fixed with a per-run
   advisory-locked check-and-ring in one transaction; commit D shipped that fix
   through the same path — deployed with no manual step, its bell `count: 1`,
   and the catch-up rang B's, which B's own broken `onReady` had swallowed.

Teardown: the trigger gateway stopped, the namespace's backend stopped, the
clone deleted (its registry dir and DB left to the checkout-owner reaper).

### Known limits, kept

- A convergence run that fails (it cannot decide or start: Postgres down at
  gateway boot, a wedged git) is a `main-deploy-failed` report and is not
  retried before the next edge (a push, a gateway boot, a backend's request).
- A gateway restarted mid-run does not observe that run's exit: its own boot
  run waits behind it on the build lock and decides after it, but a failure of
  the orphaned run files no report (its builds still ring their bells).
- The decision does not read the `server` carrier (it lives in a backend's
  memory), so a mixed-boot backend is not rebuilt by auto-build — as before,
  `wantsBuild`'s termination refused that anyway; the Build button remains the
  escape hatch.
