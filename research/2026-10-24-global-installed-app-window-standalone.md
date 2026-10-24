# Installed app windows are standalone, not embedded

## Context

The menu-bar helper's window mode (`plugins/menu-bar/rust/src/window.rs`) loads
every installed app at `shim::embedded(url)` = `<url>?embed=1`. That flag means
"a same-origin frame hosted by another page" (`primitives/embed`), and two
readers act on it:

- `primitives/scope/app-instance` — `resolveInstanceId()` mints a fresh
  generation and never touches the registry;
- `apps-core/tabs` `tabs-store` — `loadPersistedTabs()` / `savePersistedTabs()`
  do nothing.

So in an installed app's window a reload drops the open tabs, the surface mode
and (for `/desktop`) every desktop window (`desktop.windows` store, keyed by
`appInstanceId()`). The window is not hosted by anything: it is the app on its
own, exactly like a browser-installed PWA, which `embed` already models as
`display-mode: standalone` → chromeless but **not** embedded. WKWebView / WebKitGTK
never match `display-mode: standalone`, so the helper has no way to say that
today and borrowed `?embed=1` for its chromelessness.

Outcome: an installed app's window is chromeless and owns its storage; a reload
restores it. (Part B, separate: restoring on relaunch.)

## Part A — the helper declares "standalone", not "embedded"

### Signal: a host marker injected by the window's init script

The window already gets one main-frame initialization script, `scope.js`
(`window.rs` `scope_script`). It additionally defines a declared global:

```js
Object.defineProperty(window, "equinStandalone", { value: true }); // main frame only
```

Why a global and not a new query flag:
- an init script runs on **every** main-frame load (reload, `window.navigate`
  on hand-off, an in-window cross-document load), so nothing has to be
  re-stamped onto URLs — unlike `?embed=`, which the shell history adapter has
  to re-stamp because the pane store drops every query on its first write;
- main frame only (`scope.js` already returns when `window.top !== window`, and
  Tauri's `initialization_script` is main-frame), so an iframe inside the
  window is never mistaken for the window;
- it is a declaration (same rationale as the embed flag), not a heuristic.

### Web: `primitives/embed`

- `core/internal/embed.ts`: declare the contract once —
  `STANDALONE_HOST_GLOBAL = "equinStandalone"` (exported from `core`), with a
  doc comment naming `menu-bar/rust/src/scope.js` as the writer.
- `web/internal/embed-document.ts`: `isStandaloneDocument()` (already exists,
  private, memoized) becomes
  `matchMedia("(display-mode: standalone)").matches || window[STANDALONE_HOST_GLOBAL] === true`,
  and is **exported** (Part B and the app-instance resolver need it).
  `isChromelessDocument()` is unchanged in shape (`chromeless` embed ∨
  standalone), so the layout, floating action bar and app launcher keep working
  without edits. `isEmbeddedDocument()` is now false in the window → the
  instance registry and persisted tabs work as in any browser tab (sessionStorage
  survives a reload of the same webview, and a reload resolves `reload` →
  adopts `history.state.appInstance`).
- `CLAUDE.md` / barrel description: the readers table gains "standalone = the
  helper's marker or `display-mode: standalone`".

### Native: `plugins/menu-bar/rust`

- `scope.js`: the marker line (above).
- `shim.rs`: `embedded()` → renamed `window_url()` and now **strips** any `embed`
  param instead of adding `embed=1` (a hand-off URL copied from a framed page
  must not turn the window into an embed). Test `embedded_sets_one_embed_flag`
  → `window_url_drops_embed_flag`.
- `window.rs`: the three call sites (`build_window` initial URL + `home`,
  `on_handoff`) use `window_url`; module doc + `menu-bar/CLAUDE.md` ("ONE
  window … on `<url>?embed=1`") updated.
- The panel (`panel.rs`, `/home/menu-bar?embed=1`) is untouched: it really is a
  host-owned surface with no state to keep.

### Side effects (intended)

- The experimental-deploy red frame now shows in a worktree namespace's
  installed window (it reads `isEmbeddedDocument`) — honest, same as a PWA.
- Version skew: an old helper keeps `?embed=1` (today's behaviour); a new
  helper against an old web shows the chrome until the web lands. Both come
  from the same checkout (`./equin deps install menu-bar-helper`), so they land
  together.

## Part B — restoring on relaunch (separate task; design sketch)

A relaunch is a `navigate` load in a fresh webview: sessionStorage is empty and
`getAppInstanceId()` mints. This is equally true of a browser PWA, so the fix
belongs to the standalone concept, not the helper.

Sketch:
1. **Durable instance identity for a standalone document.** In
   `app-instance`, when `isStandaloneDocument()`, the generation is not minted
   per load but is `standalone:<appId>` — one durable instance per installed
   app. `appId` comes from the marker (`equinStandalone = { appId }`, the
   helper knows it) or, for a PWA, the app whose base path owns the boot path
   (`resolveAppForPath`). No registry, no eviction sweep for it.
2. **Instance-scoped storage area.** `web-storage` gains `area: "instance"`,
   resolving to `local` in a standalone document and `session` elsewhere; the
   only two instance-scoped stores (`apps-core.tabs` tabs-store,
   `desktop.windows`) switch to it. `isFreshAppInstance()` is false when a
   durable entry exists.
3. **Deep launch.** A launch/hand-off URL ≠ the persisted focused tab's
   `rawPath` already goes through `bootTabs`' mismatch path (seeds a pending
   route on the focused tab), so "restore, then show the URL" falls out.
4. Caveat: a PWA can open two windows of one app; they would share the entry
   (last write wins). The helper enforces one window per app.

This also makes the hand-off `window.navigate` (`on_handoff`) non-destructive.

## Verification

- `./equin test plugins/primitives/plugins/embed plugins/primitives/plugins/scope/plugins/app-instance plugins/apps-core/plugins/tabs`
  — new cases: marker set ⇒ `isStandaloneDocument` & `isChromelessDocument`
  true, `isEmbeddedDocument` false; tabs-store loads/saves under the marker.
- `cargo test` in `plugins/menu-bar/rust` (shim URL test).
- `./equin build`; the marker must exist before boot, so the browser tools
  can't fake it on a plain load — the unit tests cover the web side.
- Real helper (the end-to-end check): `./equin deps install menu-bar-helper`, install Desktop from the
  launcher, open windows, Cmd-R → state survives.
