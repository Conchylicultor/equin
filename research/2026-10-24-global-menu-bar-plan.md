# equin outside the browser — implementation plan

Implements [`2026-10-24-global-menu-bar-vision.md`](2026-10-24-global-menu-bar-vision.md).
Panel design: prototype `proto-1792791657-kzcrw3` (scene `tray`, `os: macos | linux`).

## Context

equin is reachable only through a browser tab. The user wants what the Claude
Mac app has: an equin icon in the macOS menu bar / Linux top bar opening a small
panel, and equin's apps installable as first-class OS apps (own window, own
Dock / dash icon). Everything — the native helper included — lives in the
plugin system; the panel renders contributions only.

Decisions taken with the user (2026-10-24):

- **Installed apps run in a native webview** (WKWebView on macOS, WebKitGTK on
  Linux) through the same Rust helper, one process + bundle id per app — the
  only way to get a real per-app Dock icon in one click. The Step 0 web
  manifest stays as the Chromium path. Known WebKit exposure is small (CSS
  anchor positioning in conversation notes, `field-sizing` in the ui-kit
  textarea); gaps are fixed as found.
- **No pause button.** The footer is just "Running · equin.localhost" opening
  equin.
- Install happens only from the panel; no install affordance inside equin, no
  drag-to-Dock.

## Phase 0 — installable web apps (no native code)

### 0a. One app identity, readable on the server

Today an app's icon is authored twice: `defineApp({ iconKey })` (core) and
`Apps.App({ icon: appIcon(symbol(…), { color }) })` (web), held equal by the
`app-icon:key-in-sync` check; the colour exists only on the web side. The server
cannot know an app's icon.

- `defineApp` (`plugins/primitives/plugins/pane/core/route.ts`) gains
  `iconColor?: AvatarColor` (keyboard-party `pink`, settings `slate`).
- `Apps.App` **drops `icon`**: `apps-core` derives it as
  `appIcon(symbol(app.iconKey), { color: app.iconColor })` (rung 1 — the two can
  no longer disagree). `mark` stays. Delete the `app-icon:key-in-sync` check.
  ~20 shell `web/index.ts` lose one line each.
- Codegen emits `plugins/apps-core/core/apps.generated.ts`: every `defineApp`
  value imported from its shell's `core/` (from the existing static reader
  `tooling/codegen/core/declared-apps.ts`), as `declaredApps: AppRef[]`.
  `theme-engine/server/internal/theme-declarations.generated.ts`'s `apps` list
  is replaced by it (one list, not two).

### 0b. `apps-core/plugins/app-manifest` (new sub-plugin)

- **server (portable)** — `GET /api/apps/:appId/manifest.webmanifest`:
  `{ id: "<basePath>/", name, short_name, start_url: "<basePath>", scope:
  "<basePath>/", display: "standalone", theme_color, background_color, icons }`
  from `declaredApps`. Surface-mode apps (desktop) and apps with no URL are
  skipped (404).
- **machine** — `GET /api/apps/:appId/icon/:size.png` (sizes from a closed set:
  192, 512, plus 1024 for `.icns`): `appIconToSvg`
  (`apps-core/plugins/app-icon/core/internal/app-icon-to-svg.ts`) over
  `symbolBody` (`ui/icons/server`), rasterized with resvg as the release CLI
  already does, cached host-wide. Same code path the native shims use for their
  icon files (0b is the single icon renderer).
- **head** — a `DocumentHead.Fragment` (model:
  `theme-engine/server/internal/document-head.ts`) keyed per `basePath`:
  `<link rel="manifest">`, `<meta name="theme-color">`, `apple-touch-icon`.
- **standalone = chromeless**: `primitives/embed`'s `isChromelessDocument()`
  also answers true under `matchMedia("(display-mode: standalone)")` and under
  the native shim (`?embed=1`, below), so an installed app's window has no rail,
  tab bar or global action bar — just the app.

Every basePath is distinct (`/agents`, `/mail`, …), so scopes do not overlap.
Chrome treats `*.localhost` as a secure context, so install works on `http://`.

## Phase 1 — the `rust/` folder kind and the `rust` deps kind

### Folder kind

- `"rust"` in `LEAF_FOLDERS` (`plugins/framework/plugins/plugin-id/core/plugin-id.ts`,
  doc comment updated): one Cargo crate, no TypeScript, never imported.
- `boundary-config.ts`: `folders.rust = []`, `platformApis.rust = "allowed"`
  (tsc forces both rows).
- `.gitignore`: `plugins/**/rust/target/`. Root `CLAUDE.md` "Known folders" list
  regenerated to the real vocabulary (it already misses `machine`, `guard`).

### Deps kind: `plugins/infra/plugins/deps/plugins/rust`

Built **on top of the existing `build` kind** (`deps/plugins/build`), not a
parallel engine — identity hashing, intact check, bundle sealing all come free:

```ts
cargoBuild({
  crate: "plugins/menu-bar/rust",      // the rust/ folder
  bin: "equin-desktop",
  then?: (ctx: BuildContext, built: string) => Promise<void>, // e.g. assemble a .app
}) // → build({ inputs: [<crate>/**, Cargo.lock], tool: { versionArgv: ["cargo","--version"] }, output, run })
```

- `run` = `cargo build --release --locked --manifest-path <crate>/Cargo.toml`
  with `CARGO_TARGET_DIR` = a declared shared cache data dir
  (`cargo-target`, `reclaim: safe`, the pattern of `release-cargo-target`).
- Toolchain: the `rust` entry already in `mise.toml` / `mise.lock` (mise
  updater moves it).
- `lint/no-bare-cargo`: TS code spawns cargo only through this kind.
- `rust/plugins/cargo-updater` — `Updater` contributed via `UpdaterDeclare`
  (shape of `python/plugins/uv-updater`): finds
  `:(glob)plugins/**/rust/Cargo.lock`, `cargo update` past the 3-day cooldown,
  holds file + `deps-cargo:holds` check; smoke = `cargo check`. Rides the
  existing Dependency-upgrades automation.

Moving root `tauri/` under `plugins/release` on this kind is a follow-up task.

## Phase 2 — `plugins/menu-bar`

### Shape

| Folder | Role |
|---|---|
| `rust/` | `equin-desktop` (Tauri 2). Two modes from one binary: **tray** (status item, hidden panel window, notifications) and **window** (one app's window — the shim's process). Generic: no app knowledge. |
| `deps/` | `cargoBuild({ crate, bin, then })`: on macOS `then` assembles `equin.app` (Info.plist with `LSUIElement`, ad-hoc `codesign -s -`, `.icns` of the spiral); on Linux the bare binary. |
| `web/` | Panel pane, `MenuBar.Section` / `MenuBar.Status` slots, `useNativeHost()` bridge, the app-grid section, header + footer. |
| `core/` | Endpoint + live-value contracts (install, installed set, capabilities). |
| `machine/` | Shortcut creation, Dock / dash pinning, installed-set scan, capabilities. |
| `login-services/` | The helper's login service declaration (Phase 4). |

### The helper (`rust/`)

- **Tray mode** — `equin-desktop tray [--namespace <ns>]` (default main;
  `--namespace` lets a worktree test its own build).
  - macOS: `NSStatusItem` with the **mono** spiral as a template image
    (prototype's `Logo mono` path), plus an attention dot variant.
  - Linux: StatusNotifierItem via `ksni` (not libappindicator, so left click
    calls `Activate` instead of forcing a menu). Where the host has no SNI
    watcher (stock GNOME without the AppIndicator extension), the helper
    reports `tray: unavailable` and exits loudly — nothing faked.
  - Click toggles a borderless, always-on-top **panel window** (≈360 px wide)
    loading `http://<ns>.localhost:9000/home/menu-bar?embed=1`; placed under the
    icon rect on macOS, top-right under the bar on Linux X11 (Wayland places it;
    known limitation). Blur hides it. The webview stays alive while hidden, so
    the page's mounts (notifications, attention) keep running.
  - Gateway down: the webview's load failure shows the bundled
    `frontend/index.html` "equin isn't running · Start" (Start =
    `launchctl kickstart` / `systemctl --user start` of the gateway service).
    Only an outside process can report the gateway's absence.
- **Window mode** — `equin-desktop window --app <id> --url <url>`; on macOS
  read from its own bundle's Info.plist (`EquinAppId`, `EquinUrl`) when
  launched as a shim. Loads `<url>?embed=1`. Navigation leaving the app's
  `basePath`: launches that app's shim if installed, else opens the default
  browser.
- **Bridge** — Tauri IPC from the remote origin, capability scoped to window
  label `panel` and origin `http://*.localhost:9000` only (app windows get no
  IPC; other origins inside iframes cannot call it). Commands:
  `host_info → { platform, capabilities }`, `set_attention(bool)`,
  `notify({ title, body, tag })`, `open_url(url)`, `launch_app(id)`,
  `hide_panel()`.

### Web side

- **Panel route** — `Pane.define({ route: /home/menu-bar, app: homeApp,
  useResolve: false })` (model: `exhibitStagePane`), rendered chromeless via
  `?embed=1`. Body = `<MenuBar.Section.Render/>`; the panel names no section.
- **Slots** (`menu-bar/web/slots.ts`):
  - `MenuBar.Section` — `defineRenderSlot<{ id; component }>`; order lives in the
    reorder config `config/menu-bar/menu-bar.section.jsonc` (header, task, apps,
    notifications, footer — matching the prototype).
  - `MenuBar.Status` — `defineRenderSlot<{ id; useStatus: Hook<() => Pending |
    { text: string | null; attention: boolean }> }>` (`framework/hook-value`).
    The header joins the texts with " · "; any `attention` sets the menu-bar dot
    through the bridge.
- **`useNativeHost()`** — `{ kind: "absent" } | { kind: "present"; platform;
  capabilities; notify; setAttention; openUrl; launchApp }`. Consumers branch on
  the union; a missing capability hides its UI.
- **Sections and owners**:
  - header (spiral + status line) and footer ("Running · equin.localhost",
    whole row opens equin via `openUrl`) — `menu-bar` itself.
  - **app grid** — `menu-bar/plugins/app-grid`: `DataView<AppRow>` with the
    `icons` view, rows = `Apps.App.useContributions()` through `appRow`
    (`apps-core/plugins/app-launcher/web`) exactly like Home's
    `app-cards/web/components/app-grid.tsx`; `storageKey:
    defineDataView("menu-bar.apps")` gives drag-reorder persisted per view for
    free (Home's `view-order`). 4 columns, scrolls past 4 rows, badges from
    `Apps.App.badge`. A **+** item action on hover for tab apps not in the
    installed set, shown only when `capabilities.install`; spinner while
    pending (`Button` auto-pends). Tile click: `launchApp` if installed, else
    `openUrl`. If the icons view has no hover corner-action affordance, add one
    to data-view generically (not in menu-bar).
  - **status** — `conversations/plugins/menu-bar-status`: from `useConversations()`
    partitioned like `agent-manager/welcome` (`working|starting` → "N agents
    working", `waiting` → "N need you", `attention: waiting > 0`).
  - **task field** — `tasks/plugins/menu-bar-task`: autogrowing textarea (Enter
    files, Shift+Enter newline, max ≈6 lines then scrolls), submits one card
    through the task-draft form's `submitChain` / `createTaskChain` with the
    draft defaults (so auto-start behaves as in Improve). Confirmation inline
    ("Filed — …").
  - **notifications switch** — `shell/notifications/plugins/native`: config_v2
    `boolField({ default: false })`; the section renders only when the bridge
    has `notify`. A `MenuBar` mount on the panel page subscribes to new
    `shell/notifications` rows (live) and calls `notify` while on.

### Install (`machine/`)

`POST /api/menu-bar/install/:appId` (`needsMachine`, `implementMachine`), plus a
live value `menu-bar.installed` (the shim set, read from disk; invalidated by
the endpoint and a `defineFileWatcher` on the shim dirs — no polling) and
`menu-bar.capabilities`.

The helper is first copied from the deps cache to a stable path
(`state/menu-bar/` data dir) so shims never name a cache identity; a reconcile
step re-syncs every installed shim when the helper identity changes (run by the
install endpoint and the login-service start).

- **macOS** — `~/Applications/equin <Name>.app`: `Contents/MacOS/equin-desktop`
  (APFS clonefile of the helper — the process must live in the shim bundle to
  get its own Dock icon), `Info.plist` (`CFBundleIdentifier dev.equin.app.<id>`,
  `EquinAppId`, `EquinUrl`), `Resources/app.icns` (PNGs from 0b's renderer →
  `iconutil`), ad-hoc signed. Dock pin: append a `persistent-apps` tile via
  `defaults write com.apple.dock`, then `killall Dock` (what `dockutil` does).
- **Linux** — `~/.local/share/applications/equin-<id>.desktop`
  (`Exec=<stable helper> window --app <id> --url …`, `StartupWMClass=equin-<id>`,
  the helper setting the matching window class/app id), icon PNG under
  `~/.local/share/icons/hicolor/512x512/apps/`. Dash pin on GNOME: append to
  `gsettings org.gnome.shell favorite-apps`. Other desktops: launcher entry only;
  `capabilities.pin = false`, reported.

## Phase 3 — login services next to the gateway

- Generalize `GatewayLoginService` (`infra/launcher/server/internal/gateway-service.ts`)
  into `LoginService` over a `LoginServiceSpec { label, argv, cwd, env,
  stdioLog, session: "background" | "graphical" }`. The gateway is one spec;
  `launchd-plist.ts` / `systemd-unit.ts` render either. `graphical` →
  LaunchAgent with `LimitLoadToSessionType=Aqua`; systemd user unit
  `PartOf=graphical-session.target`, `WantedBy=graphical-session.target` (no
  linger needed).
- New sub-plugin `infra/launcher/plugins/login-services`: `defineLoginService({
  id, owner, dep, spec(ready) })` and a collected dir `login-services/` (new
  barrel folder kind, row: imports `core`, `deps`, `data-dirs`; registry
  generated like `deps.generated.ts`).
- `start` brings up the gateway, then every declared login service (ensuring
  each one's dep, `holdDep`'d like the gateway binary). `stop` unloads them;
  `stop --disable` removes them. Neither names `menu-bar`.
- `menu-bar/login-services/index.ts` declares `dev.equin.menu-bar` →
  `equin-desktop tray`.

## Phasing (each a reviewable build)

1. **0a + 0b** — app identity from `defineApp`, manifests, icons, standalone
   chromeless.
2. **`rust/` kind + `infra/deps/rust` + cargo-updater.**
3. **`menu-bar` plugin**: helper tray + panel + bridge, header/footer, app grid
   (open only), status, task field, notifications switch.
4. **Install**: window mode, `machine/` shims + pin + installed set + reconcile.
5. **Login services**: generalized service + `start`/`stop`.

## Verification

- `./equin check` (incl. `boundary-rules`, `plugin-boundaries`,
  `plugins-registry-in-sync`) accepts `rust/` and `login-services/`;
  `./equin test plugins/infra/plugins/deps/plugins/rust
  plugins/infra/plugins/launcher plugins/menu-bar` (unit tests for plist / unit
  rendering, shim file layout, manifest shape).
- Phase 0: Chrome on `http://<wt>.localhost:9000/mail` shows the install icon;
  installed window is chromeless with the Mail icon; `GET …/manifest.webmanifest`
  for every app validates (each distinct `id`/`scope`).
- `./equin deps install menu-bar-helper` builds from a fresh worktree; a second
  run is a cache hit.
- `equin-desktop tray --namespace <wt>` shows the icon; panel matches the
  prototype (`compare-diff.ts --name proto-1792791657-kzcrw3` against the panel
  route, both OS options); a throwaway `Apps.App` contribution appears in the
  grid with no menu-bar edit; drag reorder survives a reload; filing a task from
  the field creates it; notifications stay off until switched on.
- **+** on macOS creates a working `~/Applications/equin Mail.app` with its own
  Dock icon and window; on Ubuntu GNOME a dash favourite. Capabilities a host
  lacks hide their UI.
- `./equin start` brings up gateway + icon; `./equin stop --disable` removes
  both definitions. (Run only with the user's go-ahead — `start`/`stop` are
  user-only per CLAUDE.md.)

## Risks

- WebKit / WebKitGTK gaps in apps never tested there (accepted).
- Linux tray: SNI host required; panel placement on Wayland is the
  compositor's.
- macOS Dock pinning goes through the Dock's preferences (no public API).
- Tauri IPC from a remote origin: capability scoped to the panel window and
  origin; security-review it before the menu-bar plugin lands.
