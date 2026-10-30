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

- `equin-desktop tray [--namespace <ns>]` (default the main namespace, the main
  checkout): the status icon — macOS an NSStatusItem (Tauri's tray, the mono
  spiral as a template image, accessory activation policy so no Dock icon);
  Linux a StatusNotifierItem through `ksni` (left click = `Activate` = the
  panel; no SNI watcher → `tray: unavailable`, exit 1). A click toggles the
  hidden `panel` window (360 × 560, borderless, always on top, hides on blur,
  kept alive while hidden) on `http://<ns>.localhost:9000/home/menu-bar?embed=1`,
  under the icon on macOS, top-right on Linux. When nothing answers on :9000
  (probed at start and on every show) it shows the bundled `frontend/index.html`
  instead, whose Start runs `launchctl kickstart -k gui/$UID/<gateway-label>`
  / `systemctl --user start <gateway-label>.service` (the label its job carries in
  `EQUIN_GATEWAY_LABEL`, written by `login-services/index.ts` from the bound
  gateway service) and loads the panel once the port answers.
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
  **The holder decides, before the fact** (`rust/src/main_frame.rs`): a
  main-frame load off the origin — a link, a form, `location.*`, a server
  redirect — is cancelled natively before it loads (macOS: a per-webview proxy
  in front of wry's `WKNavigationDelegate` answering from
  `targetFrame.isMainFrame` and, for redirects, `isForMainFrame`; Linux:
  WebKitGTK's response decision, `is_main_frame_main_resource`, so the request
  goes out but nothing renders), and handed to the installed app owning the
  URL (read from the shims on disk — `rust/src/shim.rs`; the shim set is the
  installed set), else the default browser; every new-window request is
  handed off and denied. Tauri's `on_navigation` cannot do this — wry passes
  it only the URL, not the frame — and frames are untouched (an app frames
  content origins and foreign sites). No script is injected into any page of
  the window. Every hand-off goes through one burst gate
  (`rust/src/scope_gate.rs`: the same URL within 2 s once; 3 at once, then one
  per 3 s; the rest logged as collapsed). A main frame that still lands off the
  origin is a bug: logged, and the window goes home natively
  (`window.navigate`), never by script in that page. **Window probe**:
  `equin-desktop probe-window --namespace <ns>` builds the real window hidden
  and judges a navigator script's rows (`rust/src/probe_window.{rs,js}`);
  `./equin run plugins/menu-bar/e2e/window-probe.ts` runs it. macOS bundles need an ATS exception for
  `localhost` + subdomains (`NSExceptionAllowsInsecureHTTPLoads`), else
  WKWebView never loads `http://*.localhost` — the equin app bundle and every shim carry it.
- **Bridge** (`rust/src/bridge.js`, the contract `core/` mirrors): an
  initialization script on the panel's main frame defines `window.equinNative`
  — `hostInfo()` (`{ version: 1, platform,
  capabilities: { notify, attention, launchApp: true, openUrl, apps, pin } }`),
  `setAttention(on)`, `notify({ title, body?, tag? })`, `openUrl(url)` (http(s),
  default browser), `launchApp(appId)` (the installed app's running window comes forward, else
  its shim launches — macOS `open <bundle>`, Linux `gtk-launch equin-<id>`;
  rejects `"not-installed"` without a shim), `hidePanel()`,
  `setPanelHeight(px)` (clamped 200–720), `apps()` / `pinApp(appId)` (the
  device's installed apps, below — capabilities `apps` / `pin`).
  **The bridge answers ONE page: the pin** (`panel::Pin`, `rust/src/panel.rs`
  — the panel app's route `/home/menu-bar` at the configured instance's exact
  origin, `http://<ns>.localhost:9000`). Tauri's ACL sees only the caller's
  origin (the IPC fetch's `Origin` header), and a same-origin frame calling
  `top`'s `invoke` is indistinguishable from the page, so the pin is held at
  three native points, all reading the pin:
  - **ACL** — the bridge's capability is granted at runtime
    (`Pin::capability`, `add_capability`) to window `panel` on that one origin,
    never a pattern over namespaces (so the invoke key Tauri logs on a bad call
    is useless elsewhere); `capabilities/panel-offline.json` grants only
    `start_gateway` to the bundled page.
  - **Navigation** — the panel's `on_navigation` admits the pin and the
    bundled offline page and refuses every other load before it happens
    (`panel refused <url>` in the log). The callback sees every frame's loads,
    so this also keeps every frame out of the panel (a prototype, `srcdoc`,
    `<object>`, another namespace): the panel route can render none. A
    new-window request (`target=_blank`) goes to the default browser; the
    panel's own ways out are `openUrl` / `launchApp`.
  - **Command gate** — `commands::handler` checks, before dispatch, the page
    the calling window shows NOW against the command's row in
    `rust/src/command_table.rs` (bridge commands: the pin; `start_gateway`: the
    offline page) — which also catches a `pushState` to another route.
  `bridge.js`'s own origin guard (the pin's origin, injected) is a courtesy.
  A new command = the Rust fn (in `generate_handler!`), its row in
  `command_table.rs` (which feeds `build.rs`'s ACL manifest and the runtime
  grant), the `bridge.js` method, and the web side's `core/` contract.
  **Probe**: `equin-desktop probe --namespace <ns>` builds the real panel with
  no tray icon, runs `rust/src/probe.js` natively in its main frame and judges
  the matrix (frames of every kind, another namespace, `pushState`,
  `window.open`, a navigated panel); `./equin run
  plugins/menu-bar/e2e/bridge-probe.ts` runs it on this checkout's helper and
  deploy.
- Icons: `rust/icons/*.svg` are the source; `build.rs` renders them (resvg)
  into the tray PNGs (`OUT_DIR`) and `icons/icon.png` (gitignored — Tauri's
  codegen requires it; `deps/`'s macOS step makes the `.icns` from it).
- Iterate on the crate with `cargo build --release` in `rust/` (its own
  `target/`, gitignored); the deps install uses the shared cargo-target cache.

(`<gateway-label>` is the gateway's launchd label / systemd unit name, `dev.equin.gateway` (`GATEWAY_SERVICE` in `infra/launcher/core`); an install from before the rename keeps `LEGACY_IDS.launchdLabel` until `./equin data-dir migrate` relabels it — the service stays bound to whichever label is installed (`installedAs`).)

## Installed apps — the helper's device power (`rust/src/apps.rs`)

**Installing and pinning an app acts on the device, so the helper does it,
never the server** (Trust boundaries, principle 2: a power lives on the
machine it acts on). The instance only says which apps exist and what they
look like: `GET /api/menu-bar/apps` (`getAppCatalog`, `machine/`, owner-only —
the helper is a local tool with no browser headers, which the gateway stamps
as the owner) lists every installable app's id, name, base path, icon PNG
paths (every iconset size, from `app-manifest`'s icon route) and a
fingerprint (`hash`: id, name, base path, icon picture). Plan:
`research/2026-10-29-menu-bar-device-powers-in-helper.md`.

**Every installable app is an OS app, ahead of any click.** The helper keeps
one launcher **shim** per catalog app, on its instance's origin + base path,
so a menu-bar tile always opens the app's own window at once. (A shim's own
bundle id is what gives a window its own Dock icon / Cmd-Tab entry, so it
cannot be skipped.)

- **Who keeps them** — only the tray of the main instance (`tray` with no
  `--namespace`, or the main namespace): it manages an `apps::Keeper`. A dev
  tray on another namespace, the probes and a worktree's build never write a
  shim (`hostInfo().capabilities.apps` is `false` there), so nothing but the
  installed helper decides what every installed app runs.
- **When** — the keeper syncs each time the pinned panel page *starts*
  loading (`on_page_load` `Started`): the tray's start, and the panel's own
  reload once main serves a newer web bundle — which is what a changed app set
  or icon is. Nothing polls. It is marked pending before the page's scripts
  run, so the page's first `apps()` answers after it.
- **Sync** — fetch the catalog; write a missing or stale shim (stale: another
  `EquinShimHash`, `EquinHelperDigest` — a digest of the helper's own
  executable, so a new helper rewrites them all — or URL); remove shims of
  renamed apps (the old bundle name) and of apps no longer in the catalog.
  Only equin's own shims are touched (read by their `EquinAppId`, `shim.rs`).
  A current shim runs no command and fetches no icon.
- **macOS** — `~/Applications/equin <Name>.app`: `Contents/MacOS/equin-desktop`
  (an APFS clone, `cp -c`, of the helper's OWN executable — the process must
  live in the shim's bundle to get its own Dock icon), `Info.plist`
  (`CFBundleIdentifier dev.equin.app.<id>`, `CFBundleExecutable
  equin-desktop`, `CFBundleIconFile app`, `EquinAppId`, `EquinUrl`,
  `EquinNamespace`, `EquinShimHash`, `EquinHelperDigest`, the `localhost` ATS
  exception; no `LSUIElement`), `Resources/app.icns` (each iconset size
  fetched from the icon route, packed by `iconutil`), ad-hoc signed.
  Assembled in `<bundle>.staging` and swapped in whole, so a running app's
  executable is never overwritten in place.
- **Linux** — `~/.local/share/applications/equin-<id>.desktop` (`Exec=<stable
  helper> window --app <id> --url <url>`, `StartupWMClass=equin-<id>`,
  `Icon=equin-<id>`, `X-Equin-AppId`, `X-Equin-ShimHash`,
  `X-Equin-HelperDigest`), PNG at
  `~/.local/share/icons/hicolor/512x512/apps/equin-<id>.png`. The stable
  helper is the helper's own copy at `~/.local/share/equin/equin-desktop`
  (the deps cache it is built into may be swept).
- **Names** — a bundle is named from the app's name only when it is a safe
  path segment (no `/`, `:`, `\`, control character or leading dot, at most
  64 characters); otherwise from its id.
- **Pin** — `equinNative.pinApp(appId)` (writing its shim first when it is not
  there yet): macOS appends a `persistent-apps` tile with `defaults write
  com.apple.dock`, then `killall Dock`; GNOME appends to `gsettings
  org.gnome.shell favorite-apps` (pin capability probed once: does `gsettings
  get` answer). Already pinned → nothing runs.
- **Read** — `equinNative.apps()` → `{ installed, pinned }` (the shims on
  disk; the Dock's `persistent-apps` / the dash's favorites matched against
  them), after the sync in flight. A failed sync is its failure.
  `useNativeApps()` (web) reads it on mount, on each panel focus (so an app
  dragged out of the Dock offers its pin again on the next open) and after a
  pin; pins in flight / failed are its `requests`.
- **Verify** — `HOME=$(mktemp -d) equin-desktop sync-apps --namespace <ns>`
  runs one sync against a scratch home (real `iconutil` / `codesign`, never
  the real `~/Applications` or Dock) and prints what it wrote and removed.
- The `state/menu-bar` data dir is legacy (the server's old stable copy):
  nothing writes it; Linux entries written before still name it until the
  helper's first sync rewrites them.

The app grid (`plugins/app-grid`) opens a tile's app through `launchApp` (its
window) whenever it has a shim — every app, once the helper's first sync ran —
and draws the **Keep in Dock** pin as a hover item action on each tile
(data-view's icons view corner), hidden once pinned or where the helper cannot
pin.

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

- Description: The menu-bar panel the native helper opens: the menu-bar app (unlisted, colorMode light — the panel is designed light) mounted at /home/menu-bar, whose whole layout is the panel (no pane; chromeless under ?embed=1), whose body is the MenuBar.Section slot, drawn in its own theme (a native menu's: the system font, 13px rows, a 2–16px spacing ramp, the menu palette), plus the header (the spiral and a status line joined from MenuBar.Status parts, whose attention lights the menu-bar icon's dot) and the footer ('Running · <host>', opening equin). useNativeHost() reads the helper's bridge (window.equinNative): pending, absent (a plain browser), or present with its platform, capabilities and methods — a capability the host lacks has no method. useNativeApps() reads the device's installed and pinned apps from the helper that keeps them (pending / unavailable / ready / error), re-read on panel focus and after a pin. usePanelInput() is the panel's typed text (the task field writes it, the app grid filters by it), kept as a draft across reloads. MenuBar.Mount runs headless work while the panel page is alive; the panel reports its content height to the helper, shows no toasts, and reloads itself while hidden once main serves a newer web bundle.
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
    - `NativeAppsState`
    - `NativeHost`
  - Exports (values):
    - `MenuBar`
    - `useNativeApps`
    - `useNativeHost`
    - `usePanelInput`
- Machine:
  - Uses:
    - `apps-core/app-manifest.appIconSvg`
    - `infra/endpoints.implementMachine`
  - Routes: `GET /api/menu-bar/apps`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `packages/list-bound.wholeList`
    - `primitives/pane.defineApp`
    - `ui/icons.symbol`
  - Exports (types):
    - `AppCatalog`
    - `CatalogApp`
    - `EquinNativeBridge`
    - `NativeApps`
    - `NativeCapabilities`
    - `NativeHostInfo`
    - `NativeMaterial`
    - `NativeNotification`
  - Exports (values):
    - `AppCatalogSchema`
    - `BRIDGE_METHODS`
    - `CatalogAppSchema`
    - `getAppCatalog`
    - `menuBarApp`
    - `NativeAppsSchema`
    - `NativeHostInfoSchema`
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
- Sub-plugins:
  - **`app-grid`** — The menu-bar panel's app grid (MenuBar.Section 'apps'): every Apps.App but the current app and the home app (the desktop included: its URL is its base path as a route prefix) — as the icons DataView…

<!-- AUTOGENERATED:END -->
