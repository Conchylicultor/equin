# The gateway as a signed macOS app bundle

## Context

The Sonata MIDI watcher crashed with `EPERM` on `~/Downloads` after the user clicked Deny on the
gateway's Downloads prompt (report `report-1792896395-ol96qb`). Undoing that one decision turned out
to be impossible:

- `tccutil reset <service> <id>` takes **bundle ids only**. The gateway is a bare executable, so the
  only reset is `tccutil reset SystemPolicyDownloadsFolder`, which resets *every* app.
- System Settings → Files & Folders lists a bundle-less client as an anonymous "exec" row named by its
  file name. A *denied* folder gets no switch at all. The user's list shows many such "gateway" rows
  (stale ad-hoc builds from before `infra/codesign`), each showing only "Full Disk Access".
- The prompt says `"gateway" wants access…`, which doesn't tell the user it's equin.

`infra/codesign` (2026-10-24) already gives the gateway a stable designated requirement, so grants
survive rebuilds. What's missing is the **bundle identity** that macOS's tools and UI key on.

**Goal:** on macOS the gateway runs from `equin Gateway.app` (`CFBundleIdentifier dev.equin.gateway`),
signed by this machine's identity. Then:

- one decision can be reset with `tccutil reset <Service> dev.equin.gateway`;
- Settings shows one named entry with an icon and a switch per folder, including denied ones;
- prompts say "equin Gateway".

Backends stay charged to it, so it remains the app-level permission subject. Agents keep disclaiming
(`packages/spawn-disclaim`). Linux is unchanged (bare binary).

## Step 0 — spike (gates everything below)

Do this by hand with a scratch Go binary that `os.ReadDir`s `~/Downloads` and spawns a child doing the
same. Wrap it in `Spike.app` (Info.plist + `Contents/MacOS/spike`), sign it with
`rcodesign sign --pem-file … --pem-file … <app>` using the local identity
(`~/.singularity/state/codesign/local/`), and register it with `lsregister -f`. Load it as a
**LaunchAgent** whose `ProgramArguments[0]` is `Spike.app/Contents/MacOS/spike`, which is how the
gateway is launched.

To pass, the spike must show:

1. The prompt names the bundle display name, not `spike`.
2. After Deny, `tccutil reset SystemPolicyDownloadsFolder dev.equin.spike` succeeds and the next read
   prompts again.
3. Settings shows one row with the name and icon, and the Downloads switch is present after Deny.
4. The child's read is covered by the bundle's Allow: `disclaim-exec --print-responsible <child pid>`
   is the agent's pid.
5. Rebuild into a **different path** (the deps cache is content-hashed) and re-sign: the grant holds,
   and `tccutil reset … <id>` still resolves once the old path is deleted, or after
   `lsregister -u <old>`.
6. Optional: `AssociatedBundleIdentifiers` in the plist makes Login Items show "equin Gateway"
   instead of an unidentified item, if macOS accepts it for a self-signed bundle without a team id.

If 1–4 fail (macOS ignores the bundle when launchd execs the inner binary directly), stop and report.
Don't work around it.

## Design

### 1. Shared primitive: `infra/codesign/plugins/app-bundle` (new)

Three places now assemble a `.app` by hand: the menu-bar helper (`plugins/menu-bar/deps/internal/helper.ts`
`assembleApp`), the per-app shims (`plugins/menu-bar/machine/internal/shim-host.ts` `writeMacShim`),
and the gateway would be a third. Extract one primitive instead:

- `core/`: pure data.
  - `renderInfoPlist({ bundleId, name, executable, iconFile?, uiElement?, extra? })`. `extra` is a
    typed plist fragment, for the menu-bar's ATS exception.
  - The `ICONSET` size table, which exists today in both helper.ts and shim-files.ts.
- `deps/`: the host half.
  - `writeAppBundle({ dest, executable: {from, name, clone?}, info, iconPng: (px) => Buffer, sign })`.
    It stages at `<dest>.staging`, packs `.icns` with `iconutil`, signs, verifies, then swaps in whole.
    The swap is the same as `writeMacShim`'s, so a running executable is never rewritten in place.
  - `sign` is `{ kind: "ad-hoc" } | { kind: "identity", identifier }`. The identity form goes through
    codesign (below).
- Check that the boundary table lets `menu-bar/machine` import a `deps` barrel. If it doesn't, put
  the host half in a barrel it can import.

### 2. `infra/codesign`: sign bundles too

- `signBinary` becomes `signCode(path, …)`, accepting a Mach-O **or** a `.app`. It keeps the
  sign-a-copy-then-rename contract.
  - For a directory, copy it with `cp -cR` (an APFS clone), sign the copy, verify it, then rename the
    old bundle aside, rename the new one in, and remove the old one.
  - `rcodesign sign <app>` and `codesign --force --sign <sha1> <app>` both sign bundles natively. The
    bundle's identifier is its `CFBundleIdentifier`, so `--identifier` must equal it; assert this.
- `isSignedBy` already works on a bundle path (`codesign -v -R=…` verifies the seal).
- Update the tests in `codesign.test.ts`, using a fake host for the directory case.

### 3. The gateway dep (`plugins/infra/plugins/launcher/deps/internal/gateway.ts`)

- `output: (t) => t.platform === "darwin" ? "equin Gateway.app" : "gateway"`. The function form of
  `output` already exists. Check that `NAME` allows a space; if not, use `equin-gateway.app` and set
  the display name in the plist.
- On darwin, `run` does `go build -o <tmp>/gateway`, then `then` calls `writeAppBundle`:
  - executable named `gateway`, so `pgrep -x gateway` in `sidequests/monitors/fd` keeps working;
  - `bundleId: "dev.equin.gateway"` and display name `equin Gateway`, as product-name requires;
  - `uiElement: true`: no Dock icon;
  - the spiral icon from `plugins/menu-bar/rust/icons/app.svg`, rendered in-process like the shims do;
  - signed with the machine identity.
  - Linux is unchanged.
- **Identifier change:** `GATEWAY_CODESIGN_IDENTIFIER` becomes `dev.equin.gateway`.
  - Grants are lost once with the move to a bundle anyway, so this is the cheap moment to align with
    `dev.equin.menu-bar`.
  - The launchd **label** stays `dev.singularity.gateway`. Renaming internal identifiers is the rename
    track's decision, not this one. Drop the "same as the launchd label" comment.
- A new `gatewayExecutable(ready)`: `builtFile(ready)` on Linux, `…/Contents/MacOS/gateway` on darwin.
  Only `gatewaySignature` and `signGateway` keep using `builtFile`, since they act on the bundle.

### 4. Consumers of the path

- `plugins/infra/plugins/launcher/server/internal/boot.ts:474`: `argv[0] = gatewayExecutable(gateway)`.
  This feeds the launchd plist, `spawnGatewayDaemon`, `serve-app` and the release launcher's
  `bundledGateway` unchanged.
- `plugins/framework/plugins/cli/plugins/start/cli/run.ts` (`prepareGateway` / `adoptGatewayLaunch`):
  - `signGateway` re-signs the bundle;
  - then `registerApp(bundle)` runs `lsregister -f`, so `tccutil` and Settings can resolve the id;
  - and `lsregister -u` runs on the bundle the previous plist named, once it is replaced, so no stale
    registration lingers.
  - Both are idempotent and macOS-only, and live in `app-bundle/deps`.
- `gateway-drift` (`machine/internal/check.ts:113`, `diff.ts:42`):
  - compare `gatewayExecutable(now.ready)` with the installed argv[0];
  - widen `binaryIdentity`'s regex fixtures to the bundle path;
  - the Gateway health row's "unsigned" detail checks the bundle.
- Fixtures that hard-code `…/env/gateway` (`launch-spec.test.ts`, the launchd-plist and systemd-unit
  tests) gain a darwin bundle case.
- Optional, behind spike item 6: `AssociatedBundleIdentifiers` in `launchd-plist.ts`, for gateway jobs.

### 5. Move the existing bundle writers onto the primitive

- `menu-bar/deps/internal/helper.ts` `assembleApp` → `writeAppBundle` (keeping the ad-hoc signature).
- `menu-bar/machine/internal/shim-host.ts` `writeMacShim` → `writeAppBundle` with `clone: true`.
- Their tests keep their host fakes.

Moving the menu-bar helper to the machine identity, so its notification grant survives rebuilds, is a
one-line `sign` change. File it as a sidequest rather than doing it here.

### 6. Docs and migration

- `infra/codesign/CLAUDE.md` and `infra/launcher` docs: the bundle, the per-app reset command
  (`tccutil reset <Service> dev.equin.gateway`), and the old bare-binary rows. Those were keyed by
  path, are now dead, and are removed with the **−** button in Settings.
- Update the reset advice in research doc §3 "Migration", which says `tccutil reset <Service>`
  (all apps).
- **Rollout:** the user runs `./equin start --force` once, which rebuilds, writes the plist and
  restarts launchd. The bundle then prompts once for each grant still wanted (Downloads). Agents never
  run `start`.

## Verification

- `./equin test plugins/infra/plugins/codesign plugins/infra/plugins/launcher plugins/menu-bar` and
  `./equin check`.
- On the Mac, after the user runs `./equin start --force`:
  - `codesign -dv "<bundle>"` shows `Identifier=dev.equin.gateway`, `Authority=equin Local Code Signing`
    and `Info.plist entries=…`;
  - `ps -o comm= -p $(cat ~/.singularity/gateway.pid)` ends in `.app/Contents/MacOS/gateway`;
  - `disclaim-exec --print-responsible <backend pid>` is the gateway's pid;
  - the Sonata Downloads read prompts as "equin Gateway";
  - `tccutil reset SystemPolicyDownloadsFolder dev.equin.gateway` exits 0;
  - Settings → Files & Folders shows one "equin Gateway" row with an icon and a Downloads switch.
- The menu-bar helper and shims still build, launch and show their icons (the primitive migration).
- `./equin release` for a Linux target still seals a bare `gateway`.

## Out of scope

- Renaming the launchd label and the `~/.singularity` paths (rename track).
- The Sonata crash on an unreadable folder: task `task-1792897366-9tldns`.
- Releases signed with a Developer ID (unchanged: a configured identity already wins).
