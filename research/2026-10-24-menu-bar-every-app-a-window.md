# Menu bar: every app opens as its own window, instantly

## Context

The menu-bar panel's app grid opens an app in its own macOS window only when
the app has a launcher shim (`~/Applications/equin <Name>.app`); every other
tile opens a browser tab. The only way to get a shim was the tile's **+**,
which also pinned it to the Dock, and took >2 s (measured: `cp -c` 150 ms,
10 serial `sips` 2,080 ms, `iconutil` 250 ms, `codesign` 290 ms, then
`killall Dock`). The user wants every tile to open as a window, with no
first-click cost.

A shim (own bundle id) is what gives a window its own Dock icon / Cmd-Tab
entry, so it cannot be skipped. Instead it is made ahead of time.

## Design

1. **Shims are kept in sync for every installable app, by main** (`machine/`).
   `syncAllShims` replaces `reconcileOnMain`. It runs on main's boot and on
   each helper build (`onDepInstallSettled`), and only when the helper is
   built (`readyNow` ready). It never requests the build: no helper means no
   tray, so no panel. For every `installableApp` of `declaredApps`:
   - it writes the shim when it is missing or stale. Stale means the helper's
     identity changed (`syncStableHelper().changed`), or the shim's
     `EquinShimHash` (macOS plist key) / `X-Equin-ShimHash` (Linux desktop key)
     differs from `hash53` of the shim's inputs: name, url, namespace and the
     icon's SVG.
   - a shim of ours (it has an `EquinAppId`) whose app is gone, or that sits
     under an old name (an app rename), is removed.

   Shims are APFS clones, so ~15 bundles cost almost no disk.
2. **Icons rendered in-process.** `appIconPng` is widened to any size. The
   `.icns` iconset's 10 PNGs come from resvg directly (no `sips`); `iconutil`
   packs them. `appIconSvg` is exported so the hash does not need a raster.
3. **+ becomes "Keep in Dock"** (pin only). The endpoint becomes
   `POST /api/menu-bar/pin/:appId` (`pinApp`): it makes sure the shim exists
   (writing it if the sync has not yet), then pins it. When the helper is not
   built it keeps today's `waiting-for-helper` path. `menu-bar.install-requests`
   becomes `menu-bar.pin-requests`.
4. **New live value `menu-bar.pinned`**: the app ids pinned in the Dock
   (`defaults read com.apple.dock persistent-apps`, matched against each
   shim's `file://` URL) or the GNOME favorites (`gsettings get`). It is
   notified by the pin endpoint and by a file watcher, while subscribed, on
   `~/Library/Preferences` (filtered to `com.apple.dock.plist`) or
   `~/.config/dconf` on Linux, so an unpin in the Dock clears it. The **+** is
   shown only where `capabilities.pin` is true and the app is not pinned.
5. **Grid click unchanged**: installed → `launchApp` (now every app),
   otherwise `openUrl`. The `openUrl` fallback only covers the moment before
   the first sync finishes.

## Files

- `plugins/menu-bar/machine/internal/{install,shim-host,shim-files,values,machine-host,handle-install}.ts`, `machine/index.ts`
- `plugins/menu-bar/core/install.ts` (endpoint, values)
- `plugins/menu-bar/plugins/app-grid/web/components/{install-action,app-grid}.tsx`
- `plugins/apps-core/plugins/app-manifest/{core/endpoints.ts,machine/internal/icon-png.ts,machine/index.ts}`
- tests: `shim-files.test.ts`, `shim-host.test.ts` (fake host)
- `plugins/menu-bar/CLAUDE.md`

## Verification

- `./equin test plugins/menu-bar`: sync writes the missing shims, rewrites the
  stale ones, removes orphans and old names, and leaves current shims
  untouched; pin plans.
- `./equin build`. On main after the push, all apps appear in `~/Applications`
  and a tile opens a window.
