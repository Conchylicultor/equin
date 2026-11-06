# login-services

Per-user OS services that start by themselves — at login, or at boot for a
`background` service on a lingering Linux user — and are relaunched when they
die. The gateway is one (`infra/launcher`'s `GATEWAY_SERVICE`); any plugin can
declare another without `./equin start` / `stop` naming it.

## Declaring one

In the plugin's own `login-services/index.ts` (a LEAF folder: collected by
codegen into `core/login-services.generated.ts`, imported by nothing; its row
may import `core`, `data-dirs`, `deps` and `machine`):

```ts
import { defineLoginService } from "@plugins/infra/plugins/launcher/plugins/login-services/machine";
import { helperBinary } from "../deps";            // the dep the service runs
import { helperLogs } from "../data-dirs";

export default [
  defineLoginService({
    id: "dev.equin.example",        // the launchd Label / systemd unit name
    owner: "example",
    description: "Example tray helper",
    session: "graphical",           // or "background"
    dep: helperBinary,
    executable: {                   // the program, as a component of the equin app
      name: "example-helper",       // its file in equin.app/Contents/MacOS (macOS)
      build: (ready) => ({ file: builtFile(ready), identity: componentIdentity(helperBinary.id, ready.identity) }),
    },
    spec: (ready, executable) => ({ // Ready: a job that never ensured its binary does not compile
      argv: [executable, "tray"],   // executable: the only spelling of argv[0]
      cwd: ready.dir,
      env: { HOME: …, PATH: … },     // the whole environment — nothing is inherited
      stdioLog: helperLogs.file("helper-stdio.log"),
    }),
  }),
];
```

- **`refersTo`** names other login services the job mentions by label
  (menu-bar: `refersTo: { gateway: GATEWAY_SERVICE }`, for its Start
  button). `spec`'s third argument holds each one's BOUND label under the
  same key (`labels.gateway`), resolved by the reconcile before `spec` runs
  (`referredLabels`) — `spec` is synchronous data in, data out, and never
  looks a binding up itself. A relabel changes those labels, so it renders a
  changed job and reloads the service.
- `start` (after the gateway): ensures `dep` from the MAIN checkout (building
  it in the foreground if needed), then reconciles the service under `start`
  (or `force` with `--force`).
- **Main's backend follows main** — at boot (`machine` `onReady`) and on every
  advance of `refs/heads/main` (`machine/internal/follow-reaction.ts`, a
  git-watcher ref reaction) → `machine/internal/follow-main.ts`:
  for every declared service whose definition exists (a `start` registered it —
  the opt-in), `readyNow(dep)`: built → reconcile under `follow`; failed →
  throw (loud; the old service keeps running); absent / installing →
  `onDepInstallSettled` then `requestDep`, reconciled when the build settles.
  Boot alone is not enough: main's build keeps its backend when the server
  code is unchanged ("Backend kept"), so a push changing only a service's own
  sources (the menu-bar helper's `rust/`) boots nothing (2026-11-06: the tray
  and app shims stayed on the old helper). Whether the dependency's identity
  changed decides — an unchanged one is a no-op reconcile — and boot is the
  fallback for an advance the backend was down for. Never awaited (a reload
  must not hold boot or the watcher); one reconcile per service at a time (a
  keyed mutex). A worktree's backend does nothing.
- `start --only <ids>` (comma-separated declared ids, or the gateway's
  `<gateway-label>`) touches only those; with `--force` it is the
  per-service restart. An unknown id fails before anything runs.
- `stop`: unloads every declared service, before the gateway. `stop --disable`
  also removes each definition (and so opts it out of following main).
- A host with no service manager starts none of them, and says so.

(`<gateway-label>` is the gateway's launchd label / systemd unit name, `dev.equin.gateway` (`GATEWAY_SERVICE` in `infra/launcher/core`); an install from before the rename keeps `LEGACY_IDS.launchdLabel` until `./equin data-dir migrate` relabels it — the service stays bound to whichever label is installed (`installedAs`).)

## Binding to the installed label

`LoginServiceManager.service(id)` is **async**: it binds `id` to the label
actually installed (`bindInstalledLabel`, `machine/internal/installed-label.ts`
— the first `installedAs` label whose definition file exists, else its own) and
returns the `LoginService` for it; read the label a command acts on from
`service.id.label`. The binding stats a file, and this code runs on main's
backend (`followMain`, the gateway-drift row), so it is an async `exists` —
never a sync stat on a backend's JS thread (`blocking-fs/no-sync-fs`). It is
bound afresh on every call, never cached: a relabel this process makes
(`data-dir migrate` removing the old definition, then `start` writing the new
one) is seen by the next `service(id)`, while a `LoginService` already held
keeps the label it was bound to. An id without `installedAs` (every declared
service — `loginServiceId` never sets it) binds to itself without touching the
disk. `loginService(id)` is the same through this host's manager (null without
one).

## One reconcile, three policies

`reconcileLoginService(manager, decl, ready, policy, app)` (`machine/internal/reconcile.ts`)
is the one per-service body, answering `{ service, outcome }`: bind the
service and every service it `refersTo` under `manager`, hold the dependency (`loginServiceHolder` — off
macOS the job names the binary by path long after main moves on), install its
executable into the equin app (macOS, below), write the job, unload +
`awaitProcessGone` when loaded, truncate the stdio log, load.

| policy | not registered | registered, not loaded | loaded, job same | loaded, job changed |
|---|---|---|---|---|
| `start` | load | load | leave | reload |
| `force` | load | load | reload | reload |
| `follow` | untouched (nothing held or written) | definition rewritten, never loaded | leave | reload |

"Changed" is `LoginService.write`'s answer: off macOS the job's argv names the
binary under `cache/deps/<id>/<identity>/`, on macOS its environment names the
build in the app bundle (`EQUIN_APP_COMPONENT`), so a new dependency identity
renders a different definition — that service's only. `LoginService.isCurrent(job)` asks the same without
writing (the gateway's staleness notice in `start`).
`LoginService.installedJob()` reads the written definition's argv and cwd back
(`parseLaunchAgentPlist` / `parseSystemdUserUnit`, the renderers' pure inverses,
round-trip tested) for a reader that cannot rebuild the whole job — its
environment is the starter's: the gateway's drift row (`launcher/gateway-drift`).

`awaitProcessGone` / `terminateProcess` live here (`machine/internal/process.ts`),
moved from the launcher's `server` barrel: this machine half could not import
that barrel without a launcher ↔ login-services cycle.

## The equin app (macOS)

Every login service — the gateway too (`launcher`'s `GATEWAY_APP_COMPONENT`,
installed by `start`) — runs from ONE app bundle,
`~/.equin/state/macos-app/equin.app` (`machine/internal/macos-app.ts`):
bundle id `dev.equin`, display name `equin`, `LSUIElement`, the icon the main
component brings, signed as a whole with the machine's identity
(`infra/codesign`'s `signBundle`) and registered with LaunchServices. So every
permission prompt says "equin", System Settings shows one row per pane with a
switch per folder (a denied one included), and one app's decision resets on its
own: `tccutil reset SystemPolicyDownloadsFolder dev.equin`. A bare executable
gets none of that — an anonymous row, no switch for a denied folder, and only
the reset of every app. The gateway's backends are charged to it (macOS's
responsible process); agents disclaim (`packages/spawn-disclaim`).

- **One component per service**, declared `executable: { name, main?, build }`.
  `main` (the menu-bar helper) is `CFBundleExecutable`, what notifications and
  `Bundle.main` see; while it is not installed another component stands in.
- **Installing** (`installServiceExecutable`, under a machine-wide flock):
  a no-op when `Info.plist`'s `EquinComponents` record already holds that build
  and the bundle is signed by this machine's identity; otherwise the bundle is
  copied to a staging directory, the executable (and icon) replaced, the plist
  rewritten, the copy signed and verified, then swapped in whole. A running
  component keeps its own executable until its reload.
- **The swapped-out bundle is kept** (`equin.app.old-*`) while a running
  process was started from it, and deleted by the first install that finds
  nothing running from it (`sweepOldBundles`: one `lsof -d txt`, on every
  install, a no-op one included — main's boot installs, so a gateway restart
  frees its copy). Deleting it under the gateway broke every backend's
  Downloads read: tccd identifies a process by the file it runs, and with the
  file gone it logs `proc_pidpath_audittoken() failed from PID[…]: No such
  file or directory` and refuses the grant — minutes later, once its cache
  expires (2026-10-31).
- **A stable path**, not the per-build deps cache: components rebuild on their
  own, and a menu-bar rebuild must not restart the gateway. Never under `/tmp`:
  LaunchServices disables a bundle there (no Settings row, `tccutil` fails).
- **Measured on macOS 26** (research/2026-10-25-global-gateway-app-bundle-v2.md):
  launchd running any executable inside the bundle — main or not, each with its
  own LaunchAgent — is charged to the bundle; a grant survives the bundle moving
  and being re-signed; a running process and its new children keep their grants
  after the re-signed bundle is swapped in under them — while the file it runs
  still exists (the spike measured 30–40 s, inside tccd's cache; see above).
- **Main's boot** has no `ExecContext`, so it waits for `rcodesign` through
  `deps` (`requestDep` + `readyNow`) like the service's own build, and signs
  with the installed tool (`RcodesignTool`).
- Linux has no bundle: a service runs its build where it is
  (`unbundledExecutable`).

## Sessions

| | launchd (macOS) | systemd user unit (Linux) |
|---|---|---|
| `background` | LaunchAgent in `gui/<uid>`, at login | `WantedBy=default.target`, at boot; `load` refuses without lingering |
| `graphical` | + `LimitLoadToSessionType=Aqua` | `PartOf=` / `After=` / `WantedBy=graphical-session.target`, at login; no lingering |

The rest of the policy is shared and fixed in the pure renderers
(`machine/internal/launchd-plist.ts`, `systemd-unit.ts`): relaunch on a
non-zero exit only, 10 s throttle, 20 s stop budget, `KillMode=process`. A
`background` spec renders byte-identical to the gateway's plist / unit from
before this was generic — the renderer tests pin it.

## Periodic services and platforms

- `schedule: { everySeconds }` — a periodic job, not a kept-alive one: launchd
  `StartInterval` + `RunAtLoad`, no `KeepAlive` / `ThrottleInterval` (each run
  exits on its own; launchd never overlaps two). It is part of the service's
  `LoginServiceId`, like `session`: `load` resolves once launchd holds it
  (`pid` null between runs), and `start` treats "held" as running. systemd has
  no renderer for it yet (a `.timer` unit) and refuses. The fs-latency monitor
  (`infra/host/io-health/monitor`) is the first.
- `interactive: true` (the job) — launchd `ProcessType Interactive`, no
  manager resource limits, for a job that measures the machine.
- `platforms` (the declaration) — the OSes it exists on; elsewhere the
  registry does not list it, so `start`, `stop` and main's boot never see it.

## Why a leaf folder

No existing collected dir carries it: `deps/`'s default export is strictly
`Dep[]` (and `infra/deps` cannot know a launcher concept — launcher depends on
it), and `cli/` holds commands. A declaration is found by discovery and
imported by nobody, which is the definition of a leaf (like `check/`), so the
folder needs only its boundary row, not a barrel's doc and shipping policy.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Per-user login services, generalized from the gateway's: a LoginService over a LoginServiceSpec (label, argv, cwd, env, stdio log, session background | graphical), rendered as a launchd LaunchAgent on macOS (graphical → LimitLoadToSessionType=Aqua) or a systemd user unit on Linux (graphical → graphical-session.target, no lingering); defineLoginService and the collected login-services/ registry, so ./equin start / stop bring every declared service up and down without naming one. On main's boot and on every advance of main (a git-watcher ref reaction — main's build may keep its backend), every declared service a start registered follows main: reloaded when main's build of its dependency changed its job (rewritten only, when stopped), the dependency requested through deps first when it is not built yet. On macOS every service (the gateway too) runs from ONE app bundle, equin.app (bundle id dev.equin, signed with the machine's identity, at a stable path under state/macos-app): installServiceExecutable copies a component's build in and swaps the re-signed bundle in whole, so every permission prompt, System Settings row and tccutil reset names one app, equin.
- Core:
  - Uses:
    - `framework/tooling/collected-dir.defineCollectedDir`
    - `infra/launcher/env-names.envEntries`
  - Exports (types):
    - `AppComponent`
    - `ComponentBuild`
    - `LoginServiceId`
    - `LoginServiceJob`
    - `LoginServiceSchedule`
    - `LoginServiceSession`
    - `LoginServiceSpec`
    - `ServiceExecutable`
  - Exports (values):
    - `componentIdentity`
    - `executableEnv`
    - `unbundledExecutable`
- Cross-plugin:
  - Imported by:
    - `framework/cli/start`
    - `framework/cli/stop`
    - `infra/launcher`
    - `infra/launcher/gateway-drift`
    - `infra/paths/root-migration`
- Exemptions:
  - Exempts itself from: `user-path/no-unproven-claim` — `machine/internal/launchd.ts`, `machine/internal/systemd.ts` (sanctioned)
- Machine:
  - Exports (types):
    - `DefineLoginServiceSpec`
    - `InstalledComponent`
    - `InstalledJob`
    - `LoginService`
    - `LoginServiceDeclaration`
    - `LoginServiceManager`
    - `LoginServiceRun`
    - `LoginServiceState`
    - `MacosAppHost`
    - `ReconcileOutcome`
    - `ReconcilePolicy`
  - Exports (values):
    - `APP_BUNDLE_ID`
    - `appExecutablePath`
    - `awaitProcessGone`
    - `bundleOfExecutable`
    - `declaredLoginServices`
    - `defineLoginService`
    - `installedAppComponents`
    - `installServiceExecutable`
    - `loginService`
    - `loginServiceHolder`
    - `loginServiceId`
    - `loginServiceJob`
    - `loginServiceManager`
    - `machineMacosAppHost`
    - `plannedServiceExecutable`
    - `reconcileLoginService`
    - `terminateProcess`
  - Register: `defineRefReaction('login-services.follow-main (refs/heads/main)')`

<!-- AUTOGENERATED:END -->
