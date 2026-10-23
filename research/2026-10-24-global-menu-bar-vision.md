# equin in the OS menu bar — vision

High-level vision only. Details (exact slot shapes, file layout, the Rust API
surface, the install/shortcut mechanics per OS) are left to the implementing
task, which plans them before writing code.

Prototype: `proto-1792791657-kzcrw3` (scene `tray`, `os: macos | linux`).

## Context

equin is reached only through a browser tab today. A user asked for what the
Claude Mac app does: an icon in the menu bar, and — like VMware's "Unity" mode —
equin's apps living as first-class OS apps (own Dock icon, own window). The
gateway already runs as a per-user login service (launchd LaunchAgent / systemd
user unit, `framework/cli/start`), so equin is always on the machine; what is
missing is a native surface the browser cannot provide.

Two steps, this plan covers both at the vision level:

- **Step 0 — installable apps, no native code.** Each app gets a web manifest
  (its own `id`, `scope`, name, icon), so the browser can install it as a
  standalone window with its own Dock / launcher icon.
- **Step 1 — the menu bar.** A tiny native helper shows the equin icon in the
  macOS menu bar / Linux top bar and opens a panel — a page served by equin.
  Installing an app into the Dock happens **from that panel only**.

## The panel (from the prototype)

Top to bottom, minimal:

1. **Header** — the equin spiral (full colour) + a one-line status
   ("2 agents working · 1 needs you"). The menu-bar icon is a **mono** spiral
   (fewer turns, heavier stroke) with a dot when something needs the user.
2. **Inline task field** — type directly, no extra popover. Enter files the
   task; Shift+Enter adds a line (grows, then scrolls).
3. **App grid** — 4 columns, scrolls past 4 rows. Badges on tiles. A **+** on
   hover of an app not yet installed adds it to the Dock / dash. **Drag
   reorders** the grid (no drag-to-Dock).
4. **Notifications** switch — native notifications, **off by default**.
5. **Footer row** — "Running · equin.localhost": the whole row opens equin; a
   pause button on the right pauses all agents.

No install affordance inside equin itself (no "+ Add" in the Home gallery).

## Principle: everything lives in the plugin system — Rust included

The menu bar is one plugin, `plugins/menu-bar/` (not `desktop`: that name is
taken by `apps/desktop`). Every part of it — including the native helper — sits
in its folders. Rust will be needed again, so the plugin system gains a
first-class home for it now rather than a second root-level `tauri/`.

### New folder kind: `rust/`

Modelled on the existing `python/` leaf folder (one uv project that
`infra/deps`' python kind installs and runs — see
`framework/plugin-id/core/plugin-id.ts` `LEAF_FOLDERS`, and
`infra/deps/plugins/python`):

- `rust/` = one Cargo crate, no TypeScript, never imported — a **leaf folder**
  (vocabulary entry in `LEAF_FOLDERS` + its row in `boundary-config.ts`; tsc
  forces the row).
- A new **`rust` deps kind** under `infra/deps` (sibling of `python`) builds the
  crate on demand with the toolchain pinned through the existing `mise` kind,
  caches the artifact, and exposes "path to the built binary / `.app`" to host
  code. Lockfile and toolchain upgrades ride the existing `updates` runner.
- A shared Cargo target cache, as the release shell already does
  (`cache/release-cargo-target`).

The root `tauri/` release shell can later move under `plugins/release` through
the same mechanism — a follow-up, not in scope.

### The plugin's shape

| Folder | Role |
|---|---|
| `rust/` | The native helper (Tauri): menu-bar icon (colour/mono template image + attention dot), a borderless panel window loading the panel route from the gateway, native notifications, global shortcut later. **Generic** — holds no app knowledge; everything it shows comes from the page. |
| `web/` | The panel route (chromeless) and a **`MenuBar.Section` slot**. The panel renders contributions only; it never names a contributor (collection-consumer separation). |
| `machine/` | Desktop-only work: creating the OS app shortcut on install (macOS `.app` shim in `~/Applications` + Dock pin; Linux `.desktop` entry + dash favourite), persisting grid order, the notifications preference's native side. |
| `cli/` | Registering the helper as a second login service beside the gateway's. `start` gains a **generic** "login services" extension point that plugins contribute to; `start` never names `menu-bar`. `stop --disable` removes them all. |
| `deps/` | Declares the helper build (the `rust` kind). |

Sections are contributed by their owners, not hard-coded in the panel:

- app grid ← built from the `Apps.App` registry (name, icon via `app-icon`,
  badges) — a new app appears in the menu with zero menu-bar changes;
- task field ← tasks (reuses the task-draft flow);
- notifications switch ← `shell/notifications`;
- pause ← the agents side;
- status header / footer ← menu-bar itself.

### Step 0 in the same spirit

Per-app web manifests are generated from the `Apps.App` registry (one manifest
per app path, distinct `id` + `scope`, icon rendered from the app-icon
descriptor) — no per-app hand-written files. This works in any Chromium browser
on macOS and Linux today and is the fallback when the helper is not running.

## Cross-platform

| | macOS | Linux |
|---|---|---|
| Icon | `NSStatusItem` template image | StatusNotifierItem / AppIndicator (GNOME needs the AppIndicator extension; Ubuntu ships it) |
| Login service | LaunchAgent (as the gateway) | systemd user unit (as the gateway) |
| App shortcut | `.app` shim + Dock pin | `.desktop` file + dash favourite |
| Notifications | needs the helper's bundle id | libnotify / portal |

A capability the platform lacks is reported, and its UI hidden — never faked.
If the gateway is down the helper shows that state with a Start action (only a
process outside the gateway can report the gateway's absence).

## Phasing

1. Step 0 — per-app manifests from the `Apps.App` registry.
2. `rust/` folder kind + `infra/deps` rust kind (crate builds on demand).
3. `menu-bar` plugin: helper, panel route + `MenuBar.Section`, first
   sections (grid, task field, notifications, footer/pause).
4. Install-from-panel (`machine/` shortcut creation) + grid reorder.
5. `start` login-services extension point; the helper registers through it.

## Verification (for the implementing task)

- `./singularity check boundary-rules plugin-boundaries` accept `rust/`.
- A fresh worktree builds the helper on demand; `./singularity start` brings up
  gateway + icon; `stop --disable` removes both.
- Panel matches the prototype (compare-diff against `proto-1792791657-kzcrw3`);
  adding a throwaway app plugin makes it appear in the grid with no menu-bar
  edits.
- On macOS and Linux (GNOME): icon shows, + creates a working Dock / dash entry
  opening the app in its own window, notifications stay off until switched on.
