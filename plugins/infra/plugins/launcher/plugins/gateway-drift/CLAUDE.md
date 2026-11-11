# launcher/gateway-drift

Is the machine's gateway what `./equin start --force` would install now from
main — and when it is not, make it so. Two halves over one comparison
(`compareGatewayLaunch`, `machine/`):

- **Said**: the health report's Gateway row (below). Design:
  [`research/2026-10-24-global-gateway-launch-drift-health.md`](../../../../../../research/2026-10-24-global-gateway-launch-drift-health.md).
- **Done**: `followMainGateway` (`cli/`), which main's convergence run calls
  after its builds — the gateway follows main with no one running `start`
  (decided 2026-11-11). Below, "Following main".

## Following main (`cli/internal/follow.ts`)

`./equin build --allow-main --converge` (`framework/cli/build`,
`cli/internal/converge.ts`) runs it on main's checkout after every build pass:

1. Under a machine-wide flock (`state/gateway-follow/follow.lock`,
   `withGatewayFollowLock`): the run that replaced the gateway, the
   successor's boot-edge run and `./equin start` never act at once.
2. Not applicable unless the installed job's `-main-checkout` is this
   checkout (a throwaway clone's converge never touches the machine's
   gateway) and `compareGatewayLaunch` compares (a login service `start`
   registered, not a release, this data root).
3. `prepareMainGateway` builds main's `gateway-binary` (`ensureDep`; a hash
   when unchanged); compared again, plus the whole rendered job
   (`isCurrent` — the environment, which this run inherits from the gateway's
   declared one) — current is a no-op.
4. The launch key (a hash of the build, argv, cwd and the environment's
   names — not its values, so an inherited value that differs run to run
   cannot mint a key per boot) against
   `last-attempt.json`: a key already attempted is not retried, whatever its
   outcome — a gateway that cannot come up would otherwise be retried by the
   boot of its own rollback, every time.
5. The way back, captured first: the job definition verbatim
   (`LoginService.readDefinition`) and the build held as `machine-gateway`
   (`heldDep`, `infra/deps`). No held build → refuse (report).
6. `adoptGatewayLaunch` (install into the equin app, `database.json`), write
   the job, `reloadService`, `awaitGatewayReady`; then, outside the rollback's
   reach, the attempt is recorded and `holdGatewayBuild` moves the hold to the
   new build.
7. Any failure → `restorePrevious`: reinstall the held build, restore the
   definition, and (once the swap had unloaded the old one) reload and await
   it. A refusal or a failure files a `gateway-restart-failed` report through
   the outbox (`core/internal/restart-failed.ts`, kind in `server/`, summary in
   `web/`) — the converge run's exit status reaches no one once the gateway
   that started it is gone.

`start` shares `prepareMainGateway` / `adoptGatewayLaunch` /
`holdGatewayBuild`, so both install the one launch the row compares against.
The principal-stamp difference is the row's alone (it reads the backend's own
argv); a CLI cannot ask it, and a gateway that predates the stamp is an old
binary the identity comparison already catches.

## What is compared (`machine/internal/check.ts`)

The reference is **main's** launch — `start` always installs main's gateway,
whichever checkout runs it — derived exactly as `start` derives it
(`devGatewayLaunchOptions` + `gatewayLaunchFlags`, `launcher/server`):

| | installed | expected |
|---|---|---|
| binary | the definition's argv[0] | `builtFile` of main's `gateway-binary` (`readyNow`, main's root); not built yet ⇒ older |
| flags | the definition's argv[1..] | `gatewayLaunchFlags(...)`, `-log-level` taken from the installed argv (a `start` flag) |
| cwd | the definition's `WorkingDirectory` | main's checkout |
| signature | `gatewaySignature(argv[0])` (`launcher/deps`; reads the identity, never mints one) | signed as `GATEWAY_CODESIGN_IDENTIFIER` by this machine's identity |
| running | the pidfile's process command line (`/proc/<pid>/cmdline`, else `ps -ww -o args=`) | the installed argv, space-joined |
| principal stamp | whether this backend was launched with `--principal-stamped` (`principalStamp()`, `framework/principal`) | stamped — a gateway older than the principal stamp leaves every route ungated |

The installed definition is read back through `LoginService.installedJob()`
(`login-services`: the pure inverses of the plist / unit renderers).

**The environment is not compared.** The definition's is the STARTER's
(`pickRuntimeEnv` of the shell that ran `start`), which no backend can
rebuild — comparing it would flag every machine. A newly declared runtime name
still shows, through `-child-env`.

Not-applicable (the row is hollow and out of the merge): a release, no service
manager, no definition `start` wrote, or a definition whose `-pid-file` is
another data root's (a preview runs behind its own gateway).

## Freshness

The answer is cached per backend (`machine/internal/state.ts`) and pushed as
the `gateway-drift` value (`needsMachine`), notified when a check's answer
differs from the last. Re-checked:

- on read, when the last answer is older than 10 min;
- on every advance of `refs/heads/main` (`defineRefReaction`, every backend —
  a push does not restart a worktree's backend);
- a gateway restart (main's follow-main, or `start --force`) restarts every
  backend, so the next read checks afresh.

## The row (`web/`)

`HealthReport.Row` `gateway`, order 40, after Connection / Database / Live
reads. One line ("Up to date" / "Out of date"); the differences live in its
`remedy`, `UpdateGatewayButton`: the standard launch popover listing them,
launching a System-category agent briefed to run `./equin start --force`
(`web/internal/update-prompt.ts`). After a push the row is stale until main's
convergence run reaches its follow step; a row that stays stale past that
means the launch was refused or failed (its `gateway-restart-failed` report
says why) or cannot be fixed by a restart (a signing identity). A remedy is drawn only while the row is not
ok, so the row still folds into the quiet card while current.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Gateway drift, shown: the health report's Gateway row — attention while the machine's login-service gateway (installed or running) differs from what ./equin start --force would install now from main, in one line, with an Update remedy launching an agent briefed with each difference (binary, -listen and the other flags, cwd, signature) to run it; folded with Connection, Database and Live reads while current. Main's convergence run brings the gateway onto main by itself (gateway-drift/cli), so the row is stale after a push only until that run's follow step — or until a launch that was refused or failed is fixed; the gateway-restart-failed report summary (Debug → Reports) says which. The gateway-restart-failed report kind — filed through the report outbox by main's convergence run when its follow-main step could not bring the machine's gateway onto main's (the new gateway did not come up, rolled back or not, or it refused because it could not have gone back).
- Web:
  - Contributes:
    - `HealthReport.Row` "Gateway"
    - `Reports.KindView` → `GatewayRestartFailedSummary`
  - Uses:
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/launch.LaunchAgentPopover`
    - `reports.Reports`
    - `shell/health-report.HealthReport`
    - `ui/icons.Icon`
- Server:
  - Contributes:
    - `report-kind` "gateway-restart-failed"
    - `resource.declare` "gateway-drift"
  - Uses: `reports.ReportKind`
  - Resources: `gateway-drift` (push, notified, whole: one phrase per kind of difference (binary, each changed flag, cwd, signature, running vs installed) — a fixed handful)
- Machine:
  - Uses:
    - `infra/launcher/login-services.APP_BUNDLE_ID`
    - `infra/launcher/login-services.bundleOfExecutable`
    - `infra/launcher/login-services.installedAppComponents`
    - `infra/launcher/login-services.InstalledJob`
    - `infra/launcher/login-services.loginService`
    - `infra/launcher/login-services.LoginService`
    - `infra/launcher/login-services.machineMacosAppHost`
    - `infra/launcher/login-services.MacosAppHost`
    - `infra/launcher/login-services.plannedServiceExecutable`
    - `network/live.serveValue`
  - Exports (types): `GatewayLaunchComparison`
  - Exports (values): `compareGatewayLaunch`
  - Register: `defineRefReaction('launcher.gateway-drift (refs/heads/main)')`
- Core:
  - Uses:
    - `network/live.liveValue`
    - `packages/list-bound.wholeList`
  - Exports (types):
    - `GatewayDrift`
    - `GatewayRestartFailedPayload`
  - Exports (values):
    - `describeGatewayRestartFailed`
    - `errorLines`
    - `GATEWAY_REFRESH_COMMAND`
    - `gatewayDrift`
    - `GatewayDriftSchema`
    - `GatewayRestartFailedPayloadSchema`
- Cli:
  - Uses: `infra/jobs/supervised-job.cliExecContext`
  - Exports (types):
    - `GatewayFollowOutcome`
    - `PreparedGateway`
  - Exports (values):
    - `adoptGatewayLaunch`
    - `followMainGateway`
    - `holdGatewayBuild`
    - `prepareMainGateway`
    - `withGatewayFollowLock`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by: `framework/cli/start`

<!-- AUTOGENERATED:END -->
