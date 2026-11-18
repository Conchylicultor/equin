# converge

Main's deploy, decided and run from **outside main's backend**.

The gateway starts `./equin build --allow-main --converge` from the slot main
is served from (`infra/git/main-slots`' `current/<main namespace>`; main's
checkout before any slot exists) on every advance of `refs/heads/main`, on its own boot, when a run exits with an
edge pending, and when a backend asks (`POST /gateway/deploy/converge`) — see
`gateway/CLAUDE.md` § "Main's deploy". The gateway holds no policy; this plugin
is the policy, run by the commit being deployed:

- `cli/` — `decideConvergence`: is this checkout's own app, or (main only) a
  composition it serves, behind a commit it has not attempted? The pure
  `wantsBuild` (`deployment/core`) and `compositionWantsRebuild`
  (`cli/internal/composition-trigger.ts`) bound to durable state only: git,
  the served dist (`deployment/cli`'s `readServedDeployment`), the `build_runs`
  ledger (`run-ledger/cli`'s `lastClosedRun`) and the config files on disk. The
  loop that acts on it is the build command's own (`framework/cli/build`,
  `cli/internal/converge.ts`).
  `convergenceBuild` turns a decision into the pass's ONE build: every app
  due at the decided HEAD (main's own first, then the compositions) as one
  invocation and one `build_runs` row; a target the run already built at
  that HEAD is never built again by the same run (a lost ledger write
  throws). On main it runs in a slot: `runInBuildSlot`
  (`infra/git/main-slots`) checks the decided commit (the target:
  `refs/heads/main`) out into a free slot no push writes into, hands it to
  `<slot>/equin build`, and that build points each target's
  `current/<namespace>` link at the slot once that target is healthy.
- `core/` / `server/` / `web/` — the `main-deploy-failed` report kind the
  gateway files when a run itself fails (could not decide, could not start) —
  never for a failed BUILD, which is the build's own row and bell. Its payload
  is a cross-language contract pinned by
  `gateway/testdata/main-deploy-failed-entry.json`.

## A first deploy runs with no validation gate

The convergence run passes no validation flag. The build decides for itself
(`firstMainDeploy`, `framework/cli/build`'s `cli/run.ts`): a build in main's
checkout whose targets have no served dist naming a commit (a fresh install)
runs neither the full check pass nor the `--skip-checks` set (always-run
checks + the repo type-check). Validation is a gate that keeps a served app in
place; with none served it can only turn "an app" into "no app", and main's
tree passed the full pass where it was authored. On the 2026-11-17 fresh-Mac
installs the full pass held the machine's only build slot for ~20 minutes on
the person's critical path; on 2026-11-18, with it skipped, the repo
type-check alone was still 7–9 of the interface step's ~8–10 minutes. Every
later build runs the full pass. Derived in the build rather than passed as a
flag: the build is at the commit being deployed, the convergence run at the
commit served, and a flag is a promise nothing holds its caller to.
The install's build step reuses this run rather than building again
(`installer` § One build of main per install).

## Then the gateway

After the build loop, on main's checkout, the run calls `followMainGateway`
(`infra/launcher/gateway-drift`, `cli/`; wired in `framework/cli/build`'s
`converge.ts`): the machine's gateway is rebuilt and restarted when main's
launch differs from it, rolled back when the new one does not come up, and
tried once per launch. It runs whatever the builds' verdict (the gateway's
source does not depend on the app building). Once it restarted the gateway the
run's exit status reaches no one — the gateway that would read it is gone — so
its own failures file a `gateway-restart-failed` report, not a
`main-deploy-failed` one; an error thrown before any restart still exits
non-zero and is filed by the gateway as before.

## Why it is not in main's backend

Every edge of the old loop — the `git.refAdvanced` trigger, the debounce job,
the boot / terminal / config reconciles — and its runner lived in main's
backend. So "main can serve" was a precondition of "main gets redeployed": on
2026-11-08 the fix 2baf0e2a3b sat on main for eleven minutes while main had no
backend, until a person reloaded the gateway. Now nothing on the deploy path
needs main's backend, and a commit that cannot boot is healed by the next push.

## The server carrier is not read, on purpose

The decision reads the deployment as anything outside a backend can: HEAD and
the served dist. The `server` carrier is the running backend's own module-eval
pin, held in memory by a process that may not exist — which is the case this
plugin is for. The dist is a faithful stand-in for "last deployed": a deploy
whose backend does not come up rolls its dist back. What it cannot see (a mixed
boot, a crash on the same code later) is nothing a rebuild of the same commit
fixes, and `wantsBuild`'s termination refuses that rebuild anyway.

## Termination, and which builds are retried

`wantsBuild` refuses a target whose build gave a VERDICT, ok or failed, and the
run closes the row of the build it started before deciding again. A HEAD whose
build failed is decided, not retried: the next push (or a manual Build — the
build popover or Debug → Builds on main, or `./equin build --allow-main` in
main's checkout) is the next attempt. So a string of commits that each fail to
boot keeps main down until the first one that boots — a push heals it, never a
person. A failed build of main is a `build-failed` report and a bell
(`build/failure-report`), and the run's log says it: `deploy of <head> failed
(<run>): still serves <older>`.

A build with NO verdict — killed by a signal (the OOM killer, a shutdown),
interrupted, superseded — judged nothing, so it does not consume the target:
the NEXT convergence run retries it (never the same run: what ended it is
likely still true that second), up to `MAX_NO_VERDICT_ATTEMPTS` (3) attempts in
a row. The run that spends the last one says so and exits non-zero, so the
gateway files `main-deploy-failed` once; until a push or a manual Build, each
later trigger says so in its log only (the quarter-hourly composition tick
would otherwise file it ~96 times a day).

Two limits of the retry: a killed composition build that got as far as
stamping its `composition.json` marker reads as converged (the marker is its
carrier), so it is not retried; and a host OOM kill usually takes a build's
child (vite, tsc), not the build itself — the build then reports a failed step
and exits 1, a `failed` verdict that is not retried. On 2026-11-18 the build
itself took the signal (exit 143). Before 2026-11-18 such a build consumed the target, and
on a fresh Linux VM an OOM-killed build left main on its previous deploy while
the log said "converged".

A pass that builds nothing says why (`describeNothingToBuild`): "converged"
only when the served dist names HEAD. A pass that would repeat the build it
just ran, other than such a retry, means the ledger lost the attempt, and the
run throws (a `main-deploy-failed` report) instead of looping.

**Not main only.** `--converge` converges the checkout it runs in; only the
composition half is main's. The gateway runs it for main alone, and in any
other checkout it means "build only if behind", which is what the end-to-end
proof used: a throwaway clone standing in for main
(`research/2026-11-08-global-main-deploy-outside-main.md`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Main-deploy-failed report renderer: a one-line Debug → Reports summary for the main-deploy-failed kind (how main's convergence run ended, what started it). The main-deploy-failed report kind — filed by the gateway through the report outbox when main's convergence run (`./equin build --allow-main --converge`) fails to decide or start a build, drained by main once it is up: how it ended, what started it, and its last lines.
- Web:
  - Contributes: `Reports.KindView` → `MainDeployFailedSummary`
  - Uses:
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `reports.Reports`
- Server:
  - Contributes: `report-kind` "main-deploy-failed"
  - Uses: `reports.ReportKind`
- Core:
  - Uses:
    - `debug/backend-crash.CrashLineSchema`
    - `debug/backend-crash.CrashTailSchema`
  - Exports (types): `MainDeployFailedPayload`
  - Exports (values):
    - `describeMainDeployFailed`
    - `MainDeployFailedPayloadSchema`
- Cli:
  - Uses: `build/deployment.readServedDeployment`
  - Exports (types):
    - `ConvergenceBuild`
    - `ConvergenceDecision`
  - Exports (values):
    - `convergenceBuild`
    - `decideConvergence`
    - `describeNothingToBuild`
- Cross-plugin:
  - Imported by: `framework/cli/build`

<!-- AUTOGENERATED:END -->
