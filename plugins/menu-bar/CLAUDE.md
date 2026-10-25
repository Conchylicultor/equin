# menu-bar

## Native helper

`rust/` is the Tauri 2 crate `equin-desktop`, built by `deps/` (`menu-bar-helper`,
the rust deps kind: `./equin deps install menu-bar-helper`; macOS gets the
binary beside the app icon, `macos/{equin-desktop,equin.icns}`, which the login
service installs into the ONE equin app bundle — `equin.app`, `dev.equin`
(also the crate's Tauri `identifier`, which its notifications use),
`LSUIElement`, signed with the machine's identity — so notifications and every
other permission are the app's; Linux the bare binary). Generic: it knows
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
  shim's name on `<url>` (never `?embed=`: the window is the app's own
  document, not an embed — it keeps its tab set across a reload and the
  floating global action bar; a relaunch starts fresh), frame remembered per app
  (`<app config dir of dev.equin.app.<id>>/window.json`), no IPC. One process
  per app: a per-user Unix socket `equin-app-<id>.sock` ($TMPDIR /
  $XDG_RUNTIME_DIR) — a later launch hands its URL over and exits; the
  running window comes forward and navigates when the URL is in scope.
  **Window scope** = the app URL's whole origin (its namespace), not its base
  path: the app's own ways to other apps (the launcher, a link into another
  app) stay in the window. (Routing a launch or hand-off *to* an app still
  uses the app's base path — `shim::in_scope` against the shim URL.)
  Navigation off the origin goes to the installed app owning the URL (read
  from the shims on disk — `rust/src/shim.rs`; the shim set is the installed
  set), else the default browser: `rust/src/scope.js` (main frame) turns
  off-origin link clicks into `window.open`; every new-window request is
  handed off and denied; any other main-frame load landing off the origin is
  handed off and stepped back from (an iframe may load any origin, so only the
  main-frame page-load event can tell). macOS bundles need an ATS exception for
  `localhost` + subdomains (`NSExceptionAllowsInsecureHTTPLoads`), else
  WKWebView never loads `http://*.localhost` — the equin app bundle and every shim carry it.
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

**Every installable app is an OS app, ahead of any click.** Main keeps one
launcher **shim** per app (`syncAllShimsOnMain`, `machine/internal/shims.ts`),
running the helper's window mode on the app's MAIN-namespace URL
(`namespaceUrl(MAIN_WORKTREE_NAME, basePath)`), so a menu-bar tile always opens
the app's own window at once. (A shim's own bundle id is what gives a window its
own Dock icon / Cmd-Tab entry, so it cannot be skipped. Creating one on the
first click would cost ~0.7 s; with `sips` it was ~2.8 s.) The sync runs on main's boot and each
helper build, only once the helper is built (it never requests the build: no
helper, no tray). It writes missing or stale shims. A shim is stale when its recorded
fingerprint (`shimHash`: app id, name, URL, namespace, icon SVG; `EquinShimHash`
/ `X-Equin-ShimHash`) differs, or when the helper's identity changed. It removes
shims of renamed apps (the old bundle name) and of removed apps. Only equin's own
shims are touched (read by their `EquinAppId`). A current shim runs no command.
APFS clones make the ~15 bundles nearly free on disk.

`POST /api/menu-bar/pin/:appId` (`pinApp`, `needsMachine`) keeps one in the
Dock / GNOME dash, writing its shim first when it is not there yet (a worktree,
or a pin racing main's first sync). The shim contract is fixed — the Rust helper
reads it exactly so — and lives as pure data in
`machine/internal/shim-files.ts`:

- **macOS** — `~/Applications/equin <Name>.app`: `Contents/MacOS/equin-desktop`
  (an APFS clone, `cp -c`, of the stable helper — the process must live in the
  shim's bundle to get its own Dock icon), `Info.plist` (`CFBundleIdentifier
  dev.equin.app.<id>`, `CFBundleExecutable equin-desktop`, `CFBundleIconFile
  app`, `EquinAppId`, `EquinUrl`, `EquinNamespace`, `EquinShimHash`, the `localhost` ATS exception; no `LSUIElement`),
  `Resources/app.icns` (every iconset size rendered by the app-manifest
  renderer at that size, packed by `iconutil`; ten `sips` runs took ~2 s),
  ad-hoc signed. Assembled in `<bundle>.staging` and swapped in
  whole, so a running app's executable is never overwritten in place.
- **Linux** — `~/.local/share/applications/equin-<id>.desktop` (`Exec=<stable
  helper> window --app <id> --url <url>`, `StartupWMClass=equin-<id>`,
  `Icon=equin-<id>`, `X-Equin-AppId`), PNG at
  `~/.local/share/icons/hicolor/512x512/apps/equin-<id>.png`.
- **Pin** (the pin endpoint, when `capabilities.pin`): macOS appends a `persistent-apps` tile with
  `defaults write com.apple.dock`, then `killall Dock`; GNOME appends to
  `gsettings org.gnome.shell favorite-apps`. Already pinned → nothing runs.
- **Stable helper** — the dep's binary is copied into `state/menu-bar/`
  (`menuBarState`, with the identity it came from) so no shim names a
  deps-cache identity; when the identity changes every shim is rewritten
  (`syncShims`' `rewriteAll`). Main owns the copy; a worktree pin uses its own
  build until main's next sync.
- **Helper not built yet** (a pin) — `readyNow` says so: the app is recorded
  `waiting-for-helper`, `requestDep` builds it, and the pin finishes when the
  build settles (pushed); a failed build marks the request `failed`.

Live values (`core/install.ts`): `menu-bar.installed` (the shim set read from
disk — notified by the sync, the endpoint and a `defineFileWatcher` on the shim
folder, `depth: "children"`), `menu-bar.pinned` (the Dock's `persistent-apps`
/ the dash's favorites matched against the shims — notified by the endpoint
and, while subscribed, a watcher on `~/Library/Preferences` /
`~/.config/dconf` filtered to the Dock's plist / dconf's `user`, so an unpin in
the Dock itself is heard), `menu-bar.pin-requests` (in flight / failed, in
memory) and `menu-bar.capabilities` (`{ platform, install, pin, reason }`:
macOS both; Linux install, pin when `gsettings get org.gnome.shell
favorite-apps` answers; elsewhere neither). Every host-touching step goes
through `ShimHost` (roots, command runner, icon renderer), which the tests fake
against a `/tmp` home — never the real `~/Applications`, Dock or dconf.

The app grid (`plugins/app-grid`) opens a tile's app through `launchApp` (its
window) whenever it has a shim — every app, once main's first sync ran — and
draws the **Keep in Dock** pin as a hover item action on each tile (data-view's
icons view corner), hidden once pinned or where `capabilities.pin` is false.

`login-services/` declares `dev.equin.menu-bar` (`graphical`): the helper run
as `tray` — on macOS from the equin app bundle, as its main executable
(`executable: { name: "equin-desktop", main: true }`; the bundle is the one
every login service runs from, `infra/launcher/login-services`), on Linux the
bare build — its stdio in
`logs/menu-bar/helper-stdio.log`. Once a `./equin start` has registered it, the
tray follows main by itself: main's boot (after a push changing `rust/`)
requests the helper build and reloads the tray onto it
(`infra/launcher/login-services`, which names no service). `./equin start
--only dev.equin.menu-bar --force` restarts the tray alone.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The menu-bar panel the native helper opens: the menu-bar app (unlisted, colorMode light — the panel is designed light) mounted at /home/menu-bar, whose whole layout is the panel (no pane; chromeless under ?embed=1), whose body is the MenuBar.Section slot, drawn in its own theme (a native menu's: the system font, 13px rows, a 2–16px spacing ramp, the menu palette), plus the header (the spiral and a status line joined from MenuBar.Status parts, whose attention lights the menu-bar icon's dot) and the footer ('Running · <host>', opening equin). useNativeHost() reads the helper's bridge (window.equinNative): pending, absent (a plain browser), or present with its platform, capabilities and methods — a capability the host lacks has no method. usePanelInput() is the panel's typed text (the task field writes it, the app grid filters by it), kept as a draft across reloads. MenuBar.Mount runs headless work while the panel page is alive; the panel reports its content height to the helper, shows no toasts, and reloads itself while hidden once main serves a newer web bundle.
- Web:
  - Slots:
    - `MenuBar.Section`
    - `MenuBar.Status`
    - `MenuBar.Mount`
  - Slot contributors:
    - `MenuBar.Section` ← `menu-bar`
    - `MenuBar.Section` ← `menu-bar.app-grid`
    - `MenuBar.Section` ← `shell.notifications.native`
    - `MenuBar.Section` ← `tasks.menu-bar-task`
    - `MenuBar.Status` ← `conversations.menu-bar-status`
    - `MenuBar.Mount` ← `shell.notifications.native`
  - Contributes:
    - `Apps.App` "Menu bar" → `MenuBarPanel`
    - `ThemeEngine.Theme` "Menu bar"
    - `MenuBar.Section` "Header" → `PanelHeader`
    - `MenuBar.Section` "Footer" → `PanelFooter`
  - Uses: 24 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/spacing` ×3
    - `primitives/persistent-draft` ×2
    - `primitives/slot-render` ×2
    - `apps-core.Apps`
    - `build.useStaleFrontend`
    - `primitives/css/clip.Clip`
    - `primitives/css/fill.Fill`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/row.Row`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/loading.Loading`
    - `primitives/log-channels.clientLog`
    - `shell/toast.useSuppressToasts`
    - `ui/theme-engine.ThemeEngine`
  - Exports (types):
    - `MenuBarStatus`
    - `NativeHost`
  - Exports (values):
    - `MenuBar`
    - `useNativeHost`
    - `usePanelInput`
- Server:
  - Contributes:
    - `resource.declare` "menu-bar.capabilities"
    - `resource.declare` "menu-bar.installed"
    - `resource.declare` "menu-bar.pin-requests"
    - `resource.declare` "menu-bar.pinned"
  - Resources:
    - `menu-bar.capabilities` (push, fixed)
    - `menu-bar.installed` (push, notified, whole: one id per app installed as an OS app — bounded by the apps there are)
    - `menu-bar.pin-requests` (push, notified, whole: at most one in-flight or failed pin per app — bounded by the apps there are)
    - `menu-bar.pinned` (push, notified, whole: one id per app installed as an OS app — bounded by the apps there are)
- Machine:
  - Uses:
    - `apps-core/app-manifest.appIconPng`
    - `apps-core/app-manifest.appIconSvg`
    - `infra/endpoints.implementMachine`
    - `network/live.serveValue`
  - Register:
    - `defineFileWatcher('menu-bar.shim-dir')`
    - `defineFileWatcher('menu-bar.pin-store')`
  - Routes: `POST /api/menu-bar/pin/:appId`
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
    - `NativeCapabilities`
    - `NativeHostInfo`
    - `NativeMaterial`
    - `NativeNotification`
    - `PinRequest`
    - `PinRequests`
  - Exports (values):
    - `BRIDGE_METHODS`
    - `InstallCapabilitiesSchema`
    - `InstalledAppsSchema`
    - `menuBarApp`
    - `menuBarCapabilities`
    - `menuBarInstalled`
    - `menuBarPinned`
    - `menuBarPinRequests`
    - `NativeHostInfoSchema`
    - `pinApp`
    - `PinRequestSchema`
    - `PinRequestsSchema`
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps.Ready`
    - `infra/deps/rust.cargoBuild`
    - `infra/deps/rust.CargoSource`
  - Exports (values):
    - `menuBarHelper`
    - `menuBarHelperIcon`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --popover`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/density --space-md`
    - `ui/tokens/material --popover-fill`
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
  - **`app-grid`** — The menu-bar panel's app grid (MenuBar.Section 'apps'): every Apps.App but the current app and the home app (the desktop included: its URL is its base path as a route prefix) — as the icons DataView…

<!-- AUTOGENERATED:END -->
