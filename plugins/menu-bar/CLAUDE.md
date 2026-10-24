# menu-bar

## Native helper

`rust/` is the Tauri 2 crate `equin-desktop`, built by `deps/` (`menu-bar-helper`,
the rust deps kind: `./equin deps install menu-bar-helper`; macOS gets an
`equin.app` around it — `dev.equin.menu-bar`, `LSUIElement`, ad-hoc signed — so
notifications have a bundle identity; Linux the bare binary). Generic: it knows
namespaces and URLs, never an app.

- `equin-desktop tray [--namespace <ns>]` (default `singularity`, the main
  checkout): the status icon — macOS an NSStatusItem (Tauri's tray, the mono
  spiral as a template image, accessory activation policy so no Dock icon);
  Linux a StatusNotifierItem through `ksni` (left click = `Activate` = the
  panel; no SNI watcher → `tray: unavailable`, exit 1). A click toggles the
  hidden `panel` window (360 × 560, borderless, always on top, hides on blur,
  kept alive while hidden) on `http://<ns>.localhost:9000/home/menu-bar?embed=1`,
  under the icon on macOS, top-right on Linux. When nothing answers on :9000
  (probed at start and on every show) it shows the bundled `frontend/index.html`
  instead, whose Start runs `launchctl kickstart -k gui/$UID/dev.singularity.gateway`
  / `systemctl --user start dev.singularity.gateway.service` and loads the panel
  once the port answers.
- **Window mode** — an installed app's process (`rust/src/window.rs`): on macOS
  the binary inside a shim bundle whose Info.plist has `EquinAppId` (its
  arguments then only carry an optional in-scope `--url`, a hand-off); on
  Linux `equin-desktop window --app <id> --url <url>` (the `.desktop` Exec),
  which sets the glib prgname / gdk program class to `equin-<id>` (the
  `StartupWMClass`). A regular app (own Dock icon), ONE window titled with the
  shim's name on `<url>?embed=1`, frame remembered per app
  (`<app config dir of dev.equin.app.<id>>/window.json`), no IPC. One process
  per app: a per-user Unix socket `equin-app-<id>.sock` ($TMPDIR /
  $XDG_RUNTIME_DIR) — a later launch hands its URL over and exits; the
  running window comes forward and navigates when the URL is in scope.
  **Scope** = the app URL's origin + base path. Out-of-scope navigation goes to
  the installed app owning the URL (read from the shims on disk —
  `rust/src/shim.rs`; the shim set is the installed set), else the default
  browser: `rust/src/scope.js` (main frame) turns out-of-scope link clicks and
  router pushes into `window.open`; every new-window request is handed off and
  denied; the navigation handler cancels a same-origin load another installed
  app owns; any other main-frame load landing outside the scope is handed off
  and stepped back from (an iframe may load any origin, so only the main-frame
  page-load event can tell). macOS bundles need an ATS exception for
  `localhost` + subdomains (`NSExceptionAllowsInsecureHTTPLoads`), else
  WKWebView never loads `http://*.localhost` — `equin.app` and every shim carry it.
- **Bridge** (`rust/src/bridge.js`, the contract `core/` mirrors): an
  initialization script on the panel's main frame defines `window.equinNative`
  only on `http://<ns>.localhost:9000` — `hostInfo()` (`{ version: 1, platform,
  capabilities: { notify, attention, launchApp: true, openUrl } }`),
  `setAttention(on)`, `notify({ title, body?, tag? })`, `openUrl(url)` (http(s),
  default browser), `launchApp(appId)` (the installed app's running window comes forward, else
  its shim launches — macOS `open <bundle>`, Linux `gtk-launch equin-<id>`;
  rejects `"not-installed"` without a shim), `hidePanel()`,
  `setPanelHeight(px)` (clamped 200–720). Every command is ACL-gated
  (`build.rs`'s app manifest): `capabilities/panel-bridge.json` grants the
  bridge to window `panel` on remote `http://*.localhost:9000/*` only (not
  local), `panel-offline.json` grants only `start_gateway` to the bundled page.
  A new command = the Rust fn, its name in `build.rs`, a capability grant, the
  `bridge.js` method, and the web side's `core/` contract.
- Icons: `rust/icons/*.svg` are the source; `build.rs` renders them (resvg)
  into the tray PNGs (`OUT_DIR`) and `icons/icon.png` (gitignored — Tauri's
  codegen requires it; `deps/`'s macOS step makes the `.icns` from it).
- Iterate on the crate with `cargo build --release` in `rust/` (its own
  `target/`, gitignored); the deps install uses the shared cargo-target cache.

## Installed apps (`machine/`)

`POST /api/menu-bar/install/:appId` (`installApp`, `needsMachine`) turns a tab
app into an OS app: a launcher **shim** running the helper's window mode on the
app's MAIN-namespace URL (`namespaceUrl(MAIN_WORKTREE_NAME, basePath)`). The
shim contract is fixed — the Rust helper reads it exactly so — and lives as pure
data in `machine/internal/shim-files.ts`:

- **macOS** — `~/Applications/equin <Name>.app`: `Contents/MacOS/equin-desktop`
  (an APFS clone, `cp -c`, of the stable helper — the process must live in the
  shim's bundle to get its own Dock icon), `Info.plist` (`CFBundleIdentifier
  dev.equin.app.<id>`, `CFBundleExecutable equin-desktop`, `CFBundleIconFile
  app`, `EquinAppId`, `EquinUrl`, `EquinNamespace`, the `localhost` ATS exception; no `LSUIElement`),
  `Resources/app.icns` (`sips` over the app-manifest renderer's 1024 px PNG,
  `iconutil`), ad-hoc signed. Assembled in `<bundle>.staging` and swapped in
  whole, so a running app's executable is never overwritten in place.
- **Linux** — `~/.local/share/applications/equin-<id>.desktop` (`Exec=<stable
  helper> window --app <id> --url <url>`, `StartupWMClass=equin-<id>`,
  `Icon=equin-<id>`, `X-Equin-AppId`), PNG at
  `~/.local/share/icons/hicolor/512x512/apps/equin-<id>.png`.
- **Pin** (when `capabilities.pin`): macOS appends a `persistent-apps` tile with
  `defaults write com.apple.dock`, then `killall Dock`; GNOME appends to
  `gsettings org.gnome.shell favorite-apps`. Already pinned → nothing runs.
- **Stable helper** — the dep's binary is copied into `state/menu-bar/`
  (`menuBarState`, with the identity it came from) so no shim names a
  deps-cache identity; when the identity changes every installed shim is
  rewritten (`reconcileShims`). Runs on install, and on MAIN's boot and each
  of its helper builds (`onDepInstallSettled`) — main owns the copy; a worktree
  install uses its own build until main's next reconcile.
- **Helper not built yet** — `readyNow` says so: the app is recorded
  `waiting-for-helper`, `requestDep` builds it, and the install finishes when
  the build settles (pushed); a failed build marks the request `failed`.

Live values (`core/install.ts`): `menu-bar.installed` (the shim set read from
disk — notified by the endpoint and a `defineFileWatcher` on the shim folder,
`depth: "children"`), `menu-bar.install-requests` (in flight / failed, in
memory) and `menu-bar.capabilities` (`{ platform, install, pin, reason }`:
macOS both; Linux install, pin when `gsettings get org.gnome.shell
favorite-apps` answers; elsewhere neither). Every host-touching step goes
through `ShimHost` (roots, command runner, icon renderer), which the tests fake
against a `/tmp` home — never the real `~/Applications`, Dock or dconf.

The app grid (`plugins/app-grid`) draws the **+** as a hover item action on
each tile (data-view's icons view corner), hidden once installed or where
`capabilities.install` is false; a tile opens an installed app through
`launchApp` when the helper has that capability.

`login-services/` declares `dev.equin.menu-bar` (`graphical`): the helper
binary inside `equin.app` (`cargoBinary(ready)`) run as `tray`, its stdio in
`logs/menu-bar/helper-stdio.log`. Once a `./equin start` has registered it, the
tray follows main by itself: main's boot (after a push changing `rust/`)
requests the helper build and reloads the tray onto it
(`infra/launcher/login-services`, which names no service). `./equin start
--only dev.equin.menu-bar --force` restarts the tray alone.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The menu-bar panel the native helper opens: the menu-bar app (unlisted, colorMode system — it follows the OS light/dark) mounted at /home/menu-bar, whose index pane is the panel (rendered chromeless under ?embed=1), whose body is the MenuBar.Section slot, plus the header (the spiral and a status line joined from MenuBar.Status parts, whose attention lights the menu-bar icon's dot) and the footer ('Running · <host>', opening equin). useNativeHost() reads the helper's bridge (window.equinNative): pending, absent (a plain browser), or present with its platform, capabilities and methods — a capability the host lacks has no method. MenuBar.Mount runs headless work while the panel page is alive; the panel reports its content height to the helper.
- Web:
  - Slots:
    - `MenuBar.Section`
    - `MenuBar.Status`
    - `MenuBar.Mount`
    - `panel.actions`
  - Slot contributors:
    - `MenuBar.Section` ← `menu-bar`
    - `MenuBar.Section` ← `menu-bar.app-grid`
    - `MenuBar.Section` ← `shell.notifications.native`
    - `MenuBar.Section` ← `tasks.menu-bar-task`
    - `MenuBar.Status` ← `conversations.menu-bar-status`
    - `MenuBar.Mount` ← `shell.notifications.native`
    - `panel.actions` ← `primitives.pane`
  - Contributes:
    - `Apps.App` "Menu bar" → `FullPane`
    - `Pane.Register` "menu-bar"
    - `MenuBar.Section` "Header" → `PanelHeader`
    - `MenuBar.Section` "Footer" → `PanelFooter`
  - Uses:
    - `apps-core.Apps`
    - `layouts/full-pane.FullPane`
    - `primitives/css/fill.Fill`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.Row`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.insetClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/loading.Loading`
    - `primitives/overlay/surface-overlay.SurfaceOverlay`
    - `primitives/pane.defineRoute`
    - `primitives/pane.Pane`
    - `primitives/pane.PaneChrome`
    - `primitives/slot-render.defineMountSlot`
    - `primitives/slot-render.defineRenderSlot`
  - Exports (types):
    - `MenuBarStatus`
    - `NativeHost`
  - Exports (values):
    - `MenuBar`
    - `useNativeHost`
- Server:
  - Contributes:
    - `resource.declare` "menu-bar.capabilities"
    - `resource.declare` "menu-bar.install-requests"
    - `resource.declare` "menu-bar.installed"
  - Resources:
    - `menu-bar.capabilities` (push, fixed)
    - `menu-bar.install-requests` (push, notified, whole: at most one in-flight or failed install per app — bounded by the apps there are)
    - `menu-bar.installed` (push, notified, whole: one id per app installed as an OS app — bounded by the apps there are)
- Machine:
  - Uses:
    - `apps-core/app-manifest.appIconPng`
    - `infra/endpoints.implementMachine`
    - `network/live.serveValue`
  - Register: `defineFileWatcher('menu-bar.shim-dir')`
  - Routes: `POST /api/menu-bar/install/:appId`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
    - `packages/list-bound.wholeList`
    - `primitives/pane.defineApp`
    - `ui/icons.symbol`
  - Exports (types):
    - `EquinNativeBridge`
    - `InstallCapabilities`
    - `InstalledApps`
    - `InstallRequest`
    - `InstallRequests`
    - `NativeCapabilities`
    - `NativeHostInfo`
    - `NativeNotification`
  - Exports (values):
    - `BRIDGE_METHODS`
    - `installApp`
    - `InstallCapabilitiesSchema`
    - `InstalledAppsSchema`
    - `InstallRequestSchema`
    - `InstallRequestsSchema`
    - `menuBarApp`
    - `menuBarCapabilities`
    - `menuBarInstalled`
    - `menuBarInstallRequests`
    - `NativeHostInfoSchema`
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps/rust.cargoBuild`
  - Exports (values): `menuBarHelper`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --success`
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-semibold`
  - Imported by:
    - `conversations/menu-bar-status`
    - `menu-bar/app-grid`
    - `shell/notifications/native`
    - `tasks/menu-bar-task`
  - Endpoint callers: `app-grid`
- Sub-plugins:
  - **`app-grid`** — The menu-bar panel's app grid (MenuBar.Section 'apps'): every Apps.App with a URL — the current app and surface-mode apps (the desktop) left out — as the compact icons DataView over the installedApp…

<!-- AUTOGENERATED:END -->
