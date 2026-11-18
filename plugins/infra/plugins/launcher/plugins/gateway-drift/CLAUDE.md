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
   when unchanged) from the Go source of the slot main serves — the commit
   just deployed, held shared while read (`withServedMainRoot`), never the
   repo root a push may be rewriting; compared again, plus the whole rendered job
   (`isCurrent` — the environment, which this run inherits from the gateway's
   declared one) — current is a no-op.
4. The launch key (a hash of the build and the rendered definition with its
   environment values blanked — `LoginService.definitionShape`: argv, cwd,
   the environment's names and the manager's policy keys such as systemd's
   `OOMPolicy`; not the values, so an inherited value that differs run to run
   cannot mint a key per boot) against
   `last-attempt.json`: a key already attempted is not retried, whatever its
   outcome — a gateway that cannot come up would otherwise be retried by the
   boot of its own rollback, every time.
5. The way back, captured first: the job definition verbatim
   (`LoginService.readDefinition`) and the build held as `machine-gateway`
   (`heldDep`, `infra/deps`). No held build → refuse (report).
6. `adoptGatewayLaunch` (install into the equin app, `database.json`), write
   the job (on systemd a changed unit is `daemon-reload`ed by the write, so a
   policy key reaches the running unit with no restart), then **hand over** (`handOverGateway`, `launcher/server`): the
   gateway's keeper replaces the gateway process with the job's binary, argv,
   environment and cwd over the same sockets and backends — no backend stops
   (`gateway/CLAUDE.md` § The keeper). The running gateway is dialled at the
   address its installed definition's `-listen` names (none: `9000`, the old
   default), never at a constant. Then, outside the rollback's reach, the
   attempt is recorded and `holdGatewayBuild` moves the hold to the new build.
   **A restart instead of a handover** — the listen set changes (`-listen`,
   `-legacy-listen`: the keeper holds the sockets, and a generation refuses
   one it does not hold), or a gateway from before the keeper (`404`) — is
   handed to the **switch helper** (`bin/switch.ts`, `completeGatewaySwitch`):
   this run is main's deploy run, a child the keeper spawned, and unloading the
   service stops the keeper, which signals every child's process group
   (`stopChildren`) — the run would die between the unload and the load, with
   nothing left to load the new job or roll back. The helper is spawned
   detached (its own session), reads `state/gateway-follow/switch-plan.json`,
   takes the follow lock (so it starts once this follow returned), reloads,
   awaits the new gateway on its new port, records the port
   (`launcher/gateway-port`, only now — a rolled-back move leaves none) and the
   attempt — or rolls back, awaited on the old port, and files the failure.
   Its log: `state/gateway-follow/switch.log`. The follow returns `switching`.
7. **The port.** The account's recorded port (`launcher/gateway-port`). An
   install with none whose job still listens on `9000` is moved: the first
   free port of 8700–8709 (`chooseGatewayPort`, nothing written), with
   `-legacy-listen` on `9000` so bookmarks, open tabs and running agents
   follow. The health row says "still on port 9000" until then.
8. Any failure → `restorePrevious`: reinstall the held build, restore the
   definition, and (once the swap had unloaded the old one) reload and await
   it. A failed handover unloaded nothing: the old gateway kept serving. A refusal or a failure files a `gateway-restart-failed` report through
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
| binary | the definition's argv[0] | `builtFile` of main's `gateway-binary` (`readyNow` over the code main serves — its slot, `infra/git/main-slots`' `servedMainRoot`; the repo root before any slot exists); not built yet ⇒ older |
| flags | the definition's argv[1..] | `gatewayLaunchFlags(...)`, `-log-level` taken from the installed argv (a `start` flag) |
| cwd | the definition's `WorkingDirectory` | main's checkout |
| signature | `gatewaySignature(argv[0])` (`launcher/deps`; reads the identity, never mints one) | signed as `GATEWAY_CODESIGN_IDENTIFIER` by this machine's identity |
| running | the serving generation's launch (`GET /gateway/handover`: under a keeper the pidfile names the keeper, whose argv is the one launchd started it with, not the last handover's); with no keeper the pidfile's process command line (`/proc/<pid>/cmdline`, else `ps -ww -o args=`) | the installed argv, space-joined |
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
    - `infra/launcher/gateway-port.loadGatewayPortRecord`
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
  - Exports (values):
    - `compareGatewayLaunch`
    - `dialAddressOf`
    - `flagValue`
    - `listenPortOf`
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
    - `completeGatewaySwitch`
    - `followMainGateway`
    - `holdGatewayBuild`
    - `prepareMainGateway`
    - `withGatewayFollowLock`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by: `framework/cli/start`

<!-- AUTOGENERATED:END -->
