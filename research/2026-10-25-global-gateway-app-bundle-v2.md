# One `equin.app` for every equin process on macOS (v2)

Supersedes [v1](2026-10-25-global-gateway-app-bundle.md). v1 put the gateway alone in
`equin Gateway.app`. The user pointed out that "gateway" is an internal detail. The menu-bar helper is
already an app called "equin" (`equin.app`, `dev.equin.menu-bar`), so two apps would both want the
name. v2 uses **one** app, `equin`, for both.

## Context

`tccutil reset <Service> <id>` takes bundle ids only, and System Settings gives a bare executable an
anonymous row with no switch for a denied folder. So the user could not undo one Deny on
`~/Downloads` (the Sonata `EPERM`, `report-1792896395-ol96qb`) without resetting every app. To the
user, equin is one thing, so it should have one name, one icon and one row in Settings for every
permission: Files & Folders (the gateway and its backends), Notifications (the menu-bar helper) and
Login Items (both launch agents).

## Spike results (2026-10-25, macOS 26)

These were run by hand, with a self-signed `equin Spike.app` (`dev.equin.spike`) signed by
`rcodesign` with the machine's local identity and launched as LaunchAgents whose `ProgramArguments[0]`
is an executable inside the bundle.

| Check | Result |
|---|---|
| The prompt names the bundle display name | ✅ "equin Spike" |
| `tccutil reset SystemPolicyDownloadsFolder dev.equin.spike` resets that app alone | ✅ |
| Settings shows one row with the icon and a Downloads switch, also after Deny | ✅ |
| A spawned child is covered by the bundle's grant (`disclaim-exec --print-responsible` = parent) | ✅ |
| The bundle moved to a new path: the grant holds, with no new prompt | ✅ |
| A **second executable** in `Contents/MacOS` (signing id `helper`, its own LaunchAgent) uses the bundle's grant: Deny → immediate `EPERM`, Allow → read OK, with no prompt of its own | ✅ |
| The bundle under `/tmp` | ❌ LaunchServices flags it `in-temp-dir launch-disabled`: no Settings row, `tccutil` -10814. Under `~/.singularity/…` it works. |

So one bundle can carry both executables. Each launch agent execs its own executable, and both are
charged to the bundle's identity.

## Design

### The bundle

- `equin.app`, `CFBundleIdentifier dev.equin.app`, display name `equin`, the spiral icon,
  `LSUIElement`, and the menu-bar's ATS exception for `*.localhost`. The per-app shims are
  `dev.equin.app.<id>`, so their ids sit under this one.
- `CFBundleExecutable` = `equin-desktop`, the menu-bar helper: the bundle's main executable, which
  Tauri's `Bundle.main` and notifications read. `Contents/MacOS/gateway` is a second executable.
  Linux keeps bare binaries and nothing changes there.
- **A stable install path:** `~/.singularity/state/macos-app/equin.app`. It is not content-addressed,
  for three reasons:
  - the two executables come from two deps that rebuild independently;
  - a content-addressed bundle of both would make a menu-bar rebuild restart the gateway, and the
    other way round;
  - LaunchServices and Settings want one stable app, not one per build.
  It is not in `/tmp`, see the spike. `~/Applications` is a later product decision, since opening the
  app from Spotlight would then have to mean something.
- Signed as a whole with the machine identity (`infra/codesign`, identifier `dev.equin.app`). The
  menu-bar stops being ad-hoc signed, so its notification grant survives rebuilds too.
- `Info.plist` records each component's dep identity (`EquinComponents`), the same pattern as the
  shims' `EquinShimHash`, so "is the installed bundle current?" is a plist read.

### Owner: `infra/launcher/plugins/login-services` (extended), plus a shared bundle writer

The bundle is the app identity the login services run under, so login-services owns it. A service
opts in through its declaration:

```ts
defineLoginService({
  id: "dev.equin.menu-bar", dep: menuBarHelper, …,
  macosApp: { executable: "equin-desktop", main: true, info: ATS_LOCALHOST },
  spec: (run) => ({ argv: [run.executable, "tray"], … }),
})
```

- `spec` receives `run.executable`: the path inside the installed bundle on macOS, and `builtFile`
  on Linux.
  - A plugin can no longer name the cache path on macOS: the wrong spelling doesn't exist (rung 1).
  - The menu-bar's `cargoBinary(ready)` becomes `run.executable`.
  - The component's source file inside its dep's output is declared once (`macosApp.from(ready)`).
- Two checks on the opted-in set: exactly one `main` (an assert at collection time), and the
  executable names are unique.
- The gateway (`GATEWAY_SERVICE`, which `start` launches through its own path) opts in the same way,
  via its launch spec (`boot.ts:474` takes `run.executable`). Check whether `GATEWAY_SERVICE` can
  become a plain `defineLoginService`. If that is a larger move, keep its special path and only share
  the bundle step.
- **Reconcile** (`start` / `--force` / follow-main), before any service's job is written:
  1. Ensure every opted-in dep.
  2. If the installed `EquinComponents` differs from the deps' identities, assemble the bundle into
     `equin.app.staging`, sign and verify it, then swap the whole bundle in. Running processes keep
     their old inodes.
  3. Run `lsregister -f` on it.
- A job's **definition carries its own component's identity** in its environment
  (`EQUIN_COMPONENT=<dep identity>`), so `LoginService.write` still answers "changed" exactly when
  that service's own executable changed. A menu-bar rebuild reloads only the menu-bar. Holds:
  `holdDep` remains for Linux (the job names the cache path); on macOS the bundle is a copy, so there
  is nothing to hold.
- **Bundle writing** is a shared primitive (`infra/codesign/plugins/app-bundle`): the Info.plist
  renderer, the iconset table, the stage → `iconutil` → sign → verify → swap sequence. The menu-bar
  shims (`shim-host.ts` `writeMacShim`) move onto it too, so one bundle writer remains.
  `menu-bar/deps` stops assembling `equin.app` and builds only the binary.

### `infra/codesign`

`signBinary` → `signCode(path)` handles a Mach-O **or** a bundle. For a bundle it clones with
`cp -cR`, signs (`rcodesign sign <app>` / `codesign --sign <sha1> <app>`), verifies the requirement
and swaps. `isSignedBy` already verifies a bundle. The identifier must equal `CFBundleIdentifier`;
assert this.

### Gateway drift / health

- `gateway-drift` compares the installed job (argv + `EQUIN_COMPONENT`) with the current spec,
  instead of the cache path in argv[0]. Update `diff.ts`'s `binaryIdentity` and the fixtures.
- The "unsigned" detail of the Gateway health row reads the bundle's signature.

### Migration and rollout

- Grants keyed to the bare gateway and to `dev.equin.menu-bar` are lost once: Downloads and
  notifications prompt again, now as "equin". Remove the old "gateway" rows with **−**.
- Unregister the old content-addressed `equin.app` copies under `cache/deps/menu-bar-helper/*`
  (`lsregister -u`) during the first reconcile, so Settings and `tccutil` see one `dev.equin.app`.
- The user runs `./equin start --force` once. Agents never run it.
- Docs: `infra/codesign/CLAUDE.md`, `login-services/CLAUDE.md` (the bundle, `macosApp`, the reset
  command `tccutil reset <Service> dev.equin.app`), `menu-bar/CLAUDE.md` (the helper no longer ships
  its own bundle), and the research doc of 2026-10-24 §3 "Migration".

## Verification

- `./equin test` on `infra/codesign`, `infra/launcher` (login-services, gateway-drift) and `menu-bar`;
  `./equin check`.
- Unit tests:
  - reconcile with a fake host: the bundle is rewritten only when `EquinComponents` changes;
  - a menu-bar-only change rewrites only the menu-bar job;
  - `run.executable` points at the bundle on darwin and at `builtFile` on linux.
- On the Mac, after `./equin start --force`:
  - `codesign -dv ~/.singularity/state/macos-app/equin.app` shows `Identifier=dev.equin.app` and
    `Authority=equin Local Code Signing`;
  - the gateway pid's executable path is `…/equin.app/Contents/MacOS/gateway`, and the tray's is
    `…/equin-desktop`;
  - Sonata's Downloads read prompts as "equin";
  - `tccutil reset SystemPolicyDownloadsFolder dev.equin.app` exits 0;
  - Settings shows one "equin" row each in Files & Folders and Notifications.
- A menu-bar notification still arrives. The shims still launch with their own Dock icons.
- A menu-bar-only rebuild followed by follow-main reconcile restarts the tray and leaves the gateway
  running.

## Out of scope

- `~/Applications/equin.app` and what opening it does.
- Renaming the launchd labels (`dev.singularity.gateway`) and `~/.singularity`: the rename track.
- The Sonata unreadable-folder state (`task-1792897366-9tldns`).
- Tauri release bundles, which already run under their own app.

## Implementation notes (2026-10-25)

Where the code differs from the plan above:

- **The bundle id is `dev.equin`, not `dev.equin.app`.** It is also the menu-bar crate's Tauri
  `identifier`, which `tauri-plugin-notification` files notifications under. Tauri warns against
  an identifier ending in `.app`: the folders named after it
  (`~/Library/Application Support/<id>`) would look like app bundles to Finder. The shims'
  `dev.equin.app.<id>` are unaffected.
- **No shared bundle-writer plugin, and the shims were not moved.** The shims stay ad-hoc signed
  in `~/Applications`, with their own plist keys and icon renderer, and they share no code with
  `equin.app` beyond `iconutil`. Only one writer was needed: `login-services/machine/internal/macos-app.ts`.
  The menu-bar dep no longer assembles a bundle at all; it builds `macos/{equin-desktop,equin.icns}`.
- **Signing a bundle** is `infra/codesign`'s `signBundle` (in place, on a staged copy) and
  `registerApp` (`lsregister -f`). `codeSignature` replaces the body of `gatewaySignature`.
  `signGateway` is gone, because `start` re-signs through the bundle install.
- **`RcodesignTool`** (`{ exec } | { installed }`): main's boot has no `ExecContext`, so
  follow-main waits for `rcodesign` through `deps`, the same way it waits for a service's
  own build.
- **`GatewayLaunchOptions.gateway` → `executable: ServiceExecutable`.**
  `bootSelfContainedApp` still takes the `Ready` and runs it unbundled.
- **Extra spike (swap under a running process).**
  - Re-signing and swapping the bundle while one of its executables runs changes that
    executable's on-disk CDHash. `codesign -v <pid>` then fails.
  - Even so, the running process and the children it spawns afterwards keep their Downloads
    grant, measured over 30–40 s. This was tested both ways: a main executable running while
    a non-main one changed, and a non-main one running while the main one changed.
