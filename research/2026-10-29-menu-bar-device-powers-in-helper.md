# Device powers move to the helper: installing and pinning apps

Trust boundaries track, Phase 2's open [Design] item. Track page
`block-f3f30a77-fa7e-4db0-ab22-be3884857103`. Design: End vision, "Device powers
move to the helper (principle 2)"; Findings F9, F10, F11.

## Context

Today the **server** acts on the device:

- `syncAllShimsOnMain` (`plugins/menu-bar/machine/internal/shims.ts`) runs on
  main's boot and on each helper build. It copies the helper binary into
  `state/menu-bar/` (the "stable helper"), writes one `~/Applications/equin
  <Name>.app` (or `.desktop`) per installable app, renders icons, runs
  `iconutil` / `codesign`, and removes stale shims.
- `POST /api/menu-bar/pin/:appId` (`pinApp`, `needsMachine`) writes a missing
  shim, runs `defaults write com.apple.dock` + `killall Dock` / `gsettings set`,
  and handles "helper not built yet" (`pin-requests`).
- Four live values (`menu-bar.installed`, `.pinned`, `.pin-requests`,
  `.capabilities`) and two file watchers report the result to the panel.

So a power that acts on the device lives on the server. It cannot carry over to
a hosted instance, a worktree pin can swap the shared stable helper every shim
runs (F10), and the server builds bundle paths from app names without checking
them (F11). Phase 1 already closed the CSRF hole (F9). The design moves the power
to the helper. The helper is the device's agent, and its bridge is already
pinned to the panel page.

**Done when:** the helper owns installing and pinning (the panel asks through
the bridge), the server writes nothing into `~/Applications`, the Dock or the
dash, and the bridge probe still holds 12/12.

## Design

### Split

| | Before (server) | After |
|---|---|---|
| What apps exist (id, name, base path, icon, fingerprint) | `declaredApps` → `shimApps()` | **server**: one read-only catalog route |
| Icon PNGs | rendered in-process | **server**: the existing icon route (more sizes) |
| Writing, refreshing and removing shims; copying the helper | server, from `state/menu-bar` | **helper**: copies its own executable |
| Dock / dash pin | pin endpoint | **helper**: `pinApp` bridge command |
| Installed / pinned sets, capabilities | 4 live values + 2 watchers | **helper**: `apps()` bridge command + `hostInfo` |

The server keeps only what it knows: which apps exist and what they look like.
Everything that touches the device goes to the helper.

### Server: the catalog (`menu-bar/machine`)

`GET /api/menu-bar/apps` (`menuBarAppCatalog`, `defineEndpoint`, owner, the
default). Its response:
`{ apps: [{ id, name, basePath, hash, icons: { <px>: <path> } }] }`.

- `hash` = today's `shimHash` input minus the URL and namespace (id, name,
  base path, icon SVG). The helper adds its own origin, so the fingerprint stays
  the server's and the URL stays the helper's.
- It is built from `declaredApps` + `installableApp` + `appIconSvg`, as
  `shimApps()` is today. It stays `machine/` because `appIconSvg` reads the
  installed icon sets.
- The helper is a local tool: it sends no `Origin` or `Sec-Fetch-*` headers, so
  the gateway stamps it `owner` (Phase 1). Hosted later swaps in a device token.
  No `public` access is needed.
- `APP_ICON_SIZES` (`apps-core/plugins/app-manifest/core/endpoints.ts`) grows
  to cover the iconset: 16, 32, 64, 128, 256, 512 and 1024, plus 192 for the
  manifest. Each PNG is still rendered at its own size, as today's `ICONSET`
  does.

Deleted from `menu-bar`:

- `machine/internal/{shims,shim-host,shim-files,pin-requests,values,capabilities,machine-host,handle-pin}.ts` and their tests;
- `pinApp`, the four live values and their schemas in `core/install.ts`;
- both file watchers;
- the `menuBarState` data dir (`data-dirs/index.ts`), retired by the paths
  plugin's rule for a removed declaration;
- the `onReady` sync and the `onDepInstallSettled` hook.

What is left of `core/install.ts` is the catalog's endpoint and schema.

### Helper: `rust/src/apps.rs` (new; `shim.rs` keeps reading)

**Which helper keeps the apps.** Only the tray of the main instance (`tray`
with no `--namespace`, or `--namespace` = `MAIN_NAMESPACE`) keeps the device's
apps. This is the login service's tray. A dev tray on another namespace, and the
probe modes, never write a shim: `hostInfo.capabilities.apps` is `false` there.
A worktree build therefore cannot rewrite what installed apps run. That
closes F10 by construction. Shims open the main namespace's apps, as they do today.

**Sync (installing).**

1. Fetch the catalog from the pinned origin (`ureq`, with no TLS feature).
2. For each app, compare the shim on disk (`EquinShimHash` plus a new
   `EquinHelperDigest`, a digest of the helper's own executable) with the
   catalog. Write a shim that is missing or stale. Remove shims of apps that are
   gone or renamed (only equin's own shims, read by `EquinAppId`).
3. A sync with nothing to do runs no command and fetches no icon.

The sync runs on one trigger, decided natively: the pin page **starting** to
load (`on_page_load` `Started` on a URL that `Pin::admits`). That covers tray
start (the panel is loaded hidden at boot) and every new main deploy (the panel
reloads itself when main serves a newer bundle, through `stale-reload`). An app
set or icon change is always a new bundle. Nothing polls. The sync holds one
`Mutex`, and both bridge commands below take it.

**Writing a shim.** Today's `shim-host.ts` / `shim-files.ts` ported to Rust,
with the same contract `shim.rs` already reads:

- **macOS:** assemble `<bundle>.staging`:
  - `cp -c` of `current_exe()` into `Contents/MacOS`;
  - `Info.plist`, written with the `plist` crate the helper already depends on;
    it carries `EquinUrl = <pin origin><basePath>`, `EquinShimHash` and
    `EquinHelperDigest`;
  - icon PNGs fetched from the catalog's paths into a temp `.iconset`, then
    `iconutil` and `codesign -s -`.

  Then swap it in whole.
- **Linux:** the helper first copies itself to a path it owns,
  `$XDG_DATA_HOME/equin/equin-desktop` (written to a temp file, then renamed).
  The deps cache can be swept, so the copy is what `Exec=` names. Then it writes
  the 512 px icon and the `.desktop` entry, with an `X-Equin-HelperDigest` line.
- **F11:** the bundle name comes from a checked app name. The helper rejects
  `/`, `:`, NUL and control characters, a leading `.`, and names over 64
  characters, and falls back to the app id. An app id must pass
  `shim::valid_app_id`.

**Pinning.** `dockPinPlan` and `gnomePinPlan` (with their `defaults` / `gsettings`
parsers) ported as pure functions, plus `pinned()` read the same way. The pin
capability is `true` on macOS. On Linux it is `true` when `gsettings get
org.gnome.shell favorite-apps` answers, probed once.

**Commands** (rows in `command_table.rs` `PANEL_COMMANDS`, so the existing
runtime grant and command gate cover them; `bridge.js` methods; mirrored in
`core/native-bridge.ts`):

- `apps()` → `{ installed: string[], pinned: string[] }`. It waits on the sync
  lock, so it answers after the load's sync. Only on an apps-keeping tray.
- `pinApp(appId)`: makes sure the app's shim exists (syncs if it is missing),
  then pins it. It resolves once the app is pinned and rejects with the reason
  otherwise.
- `hostInfo.capabilities` gains `apps` and `pin`.
- A one-shot CLI mode, `equin-desktop sync-apps --namespace <ns>`, for
  verification only. It runs the same sync once against a namespace, with
  `$HOME` as the roots.

`launch_app`, `shim::installed`, `owner_of` and `hand_off` are unchanged. They
already read shims from disk.

### Web (`menu-bar/web`, `menu-bar/plugins/app-grid`)

- `useNativeHost()`'s `present` host gains `apps` and `pinApp`. Each is `null`
  when its capability is false, like the other methods. A bridge method is
  required only when its capability is set, so a helper built before this
  change still parses. The tray follows main, so that state is short-lived.
- A new `useNativeApps()` returns a state: `pending | unavailable | ready
  {installed, pinned} | error`, never a stand-in. It reads `apps()` on mount,
  again on the window's `focus` event (the panel takes focus each time it is
  shown and hides on blur, so an unpin in the Dock shows on the next open), and
  after a pin.
- `app-grid.tsx` uses `useNativeApps().installed` in place of the
  `menu-bar.installed` live value. `pin-action.tsx` calls `host.pinApp` in place
  of the endpoint and reads `pinned` and `capabilities.pin`. While the call is in
  flight the `IconButton`'s own pending state shows. A rejection is the error mark
  with its reason. The `pin-requests` / `waiting-for-helper` path is gone: the one
  doing the pinning is the helper itself, so it exists.

### Decided here (from the design's open question)

- **Installing from a plain browser:** dropped. With no helper there is no pin
  action. The browser's own PWA install (`app-manifest`) is the browser's path.
  Today a browser opened on `/home/menu-bar` could pin through the server; after
  this change it cannot.

### Touch-ups

- `principal/e2e/cross-site-probe.ts`: the F9 row targets `GET
  /api/menu-bar/apps` cross-site (403) in place of the deleted pin route.
- `menu-bar/CLAUDE.md`'s "Installed apps" section is rewritten around the helper.
  `docs/` and the plugin reference are regenerated by build.
- The 2026-10-24 F10 note in `menu-bar/CLAUDE.md` ("a worktree pin uses its own
  build") is deleted.

## Critical files

- New: `plugins/menu-bar/rust/src/apps.rs` (sync, write, pin, catalog fetch,
  unit tests against a temp root with a fake command runner, like today's
  `shim-host.test.ts`).
- `plugins/menu-bar/rust/src/{commands.rs,command_table.rs,bridge.js,panel.rs,cli.rs,main.rs}`
  and `Cargo.toml` (add `ureq`).
- `plugins/menu-bar/machine/index.ts`: a catalog route only.
  `plugins/menu-bar/core/{install.ts,native-bridge.ts}`.
- `plugins/menu-bar/web/native-host.ts`, plus a new `web/native-apps.ts`.
- `plugins/menu-bar/plugins/app-grid/web/components/{app-grid,pin-action}.tsx`.
- `plugins/apps-core/plugins/app-manifest/core/endpoints.ts` (sizes).
- `plugins/menu-bar/data-dirs/index.ts`,
  `plugins/framework/plugins/principal/e2e/cross-site-probe.ts`.

## Verification

1. `cargo test` in `rust/` covers the plan and parser ports, staleness, rename
   and removal, F11 name checks and the command gate with the new commands.
   `./equin test plugins/menu-bar`. `./equin check`.
2. `./equin build` (backgrounded), which also builds the helper dep.
3. **Live sync against a throwaway home:** `HOME=$(mktemp -d) equin-desktop
   sync-apps --namespace <wt>`. Every app gets a signed bundle (`codesign -v`)
   with `EquinUrl` on `<wt>`, a real `.icns` and the right hash. A second run
   runs no command. Deleting an app from the fixture removes its shim. This runs
   the real `iconutil` / `codesign`, and never touches the real `~/Applications`
   or the Dock.
4. `rg` shows that no `~/Applications`, `defaults`, `killall Dock` or `gsettings`
   remains in any TS file under `plugins/`.
5. `./equin run plugins/menu-bar/e2e/bridge-probe.ts`: 12/12 held. The new
   commands are refused to every frame and namespace row by the same gate. One
   row is added: a frame calling `pin_app` is denied.
6. The cross-site probe still refuses every route.
7. A real pin from the real panel happens only after a push to main (the login
   service's tray is main's). Afterwards, update the track page: tick the
   [Design] item and add a status paragraph. Then file the next main task.
