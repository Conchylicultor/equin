# Installed app windows are plain app documents (v2)

Supersedes [v1](2026-10-24-global-installed-app-window-standalone.md).

## Context

The menu-bar helper's window mode loaded every installed app at `<url>?embed=1`,
which marks the document *embedded* (`primitives/embed`): no persisted tab set,
a fresh app instance on every load — so a reload lost the tabs, the surface mode
and the desktop's windows. v1 proposed a "standalone" marker that kept the
window chromeless. Review: an installed app must keep the **global action bar**
(Improve, Build, screenshot, …) — otherwise it cannot be improved while in use.

## Decision

An installed app's window is just the app's document, like a browser tab:

- It boots in the default `solo` surface mode — tab bar and rail already hidden,
  the global action bar floating top-right, the floating launcher top-left —
  and Esc / view options can still switch to docked (tab bar + rail), which
  fits a window whose scope is the whole namespace.
- Not embedded, so the tab set and app instance persist in its sessionStorage;
  a reload restores them.
- Relaunching starts fresh (a `navigate` load mints a new instance). Restoring
  on relaunch is explicitly out of scope.

## Changes

- `menu-bar/rust/src/shim.rs`: `embedded()` → `window_url()`, which drops any
  `embed` param instead of setting `embed=1` (a hand-off URL carrying one must
  not turn the window into an embed). `window.rs` call sites + docs.
  The panel (`/home/menu-bar?embed=1`) is unchanged — it is a host-owned surface.
- `primitives/embed`: `isChromelessDocument()` no longer counts
  `display-mode: standalone`, so a browser-installed PWA behaves like the
  helper's window (same toolbar). `isStandaloneDocument()` is removed (no reader).
- Docs: `primitives/embed/CLAUDE.md`, `apps-core/app-manifest/CLAUDE.md`
  ("Installed = chromeless" → installed = the app's own document),
  `menu-bar/CLAUDE.md`.

## Verification

- `cargo test` for the shim URL; `./equin test plugins/primitives/plugins/embed`.
- `./equin build`, `./equin deps install menu-bar-helper`, open an installed
  app: floating action bar present, Cmd-R keeps tabs / desktop windows.
