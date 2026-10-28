# Trust boundaries Phase 2 — the native edge: pin the helper's bridge to the panel

Track: wiki "Trust boundaries" (block-f3f30a77…), End vision § "The native edge", Findings F1 / F2 / F13.

## Context

`window.equinNative` (the menu-bar helper's bridge, `plugins/menu-bar/rust`) is granted to a
**place**, not a page:

- `capabilities/panel-bridge.json` grants every bridge command to window `panel` on
  `http://*.localhost:9000/*` — every namespace, every composition.
- `bridge.js` defines the API on any origin matching `/^http:\/\/[a-z0-9-]+\.localhost:9000$/`.
- The panel has no navigation handler (F2): `location.assign` to another namespace keeps the bridge.
- Same-origin frames reach it through `top.equinNative` / `top.__TAURI_INTERNALS__.invoke` (F1).
- The invoke key Tauri prints on a bad call works from any page the glob covers (F13).

What Tauri can and cannot tell (read from tauri 2.12.5 / wry 0.57.1 source):

- The ACL's fetch path (`ipc/protocol.rs:487`) matches the capability against the **`Origin`
  header** — origin only, no path, and a same-origin frame calling `top`'s `invoke` sends the
  same origin from the top realm. So the ACL can pin the **origin** but never the path or the frame.
- `CapabilityBuilder` + `Manager::add_capability` grant at runtime (no glob in a file).
- `on_navigation` (wry `navigation_policy`, webkitgtk `decide-policy`) is consulted for **every
  frame's** navigation action, main or sub, before it loads.
- `on_document_title_changed` exists (used only by the probe, below).

Outcome wanted: the bridge answers only the panel's own main frame at the exact configured
instance URL; every other row of the 2026-10-24 probe matrix is denied, verified by a
repeatable probe.

## Design — one `Pin`, enforced at three native points

`panel::Pin` — the one value everything derives from: the panel document URL
(`http://<ns>.localhost:9000/home/menu-bar?embed=1` today; a remote https URL once hosted),
exposing `origin()` and `admits(&Url)` (same origin AND path `/home/menu-bar` or under it).
Built once in `Panel::new`; nothing else spells the URL.

1. **ACL: exact origin, granted at runtime.** Delete `capabilities/panel-bridge.json`. In
   `tray::run`'s setup, `app.add_capability(CapabilityBuilder::new("panel-bridge")
   .window("panel").remote(format!("{origin}/*")).permissions([...]))`, the permission list
   from the same command table `build.rs` lists. Other namespaces are simply not granted, so a
   leaked invoke key (F13) is useless anywhere else. `panel-offline.json` (local, `start_gateway`
   only) stays.

2. **Navigation: the panel stays put, and loads no frame.** `on_navigation` on the panel
   builder: allow iff `pin.admits(url)` or the bundled offline page (`tauri://localhost/…`);
   everything else is **denied before it loads** and logged
   (`equin-desktop: panel refused <url>`). Because the callback sees subframes too, this also
   refuses every iframe / `<object>` / `<embed>` whose URL is not the panel itself — including
   same-origin prototype frames and `about:srcdoc` (to confirm in step 0). No hand-off from
   here: the callback cannot tell a frame from the main frame, and the panel's own ways out
   already go through `openUrl` / `launchApp` (app-grid, panel-footer). `on_new_window`: hand
   http(s) to the default browser, `Deny` (today: no handler → no window; this makes
   cmd-click / `target=_blank` work as a hand-off instead of nothing).
   This replaces the "panel route renders no foreign frames (check)" item: the holder refuses
   the frame natively, before the fact (principle 4), rather than a lint guessing at every
   `MenuBar.Section` contributor.

3. **Command gate: the main frame's current URL.** One wrapper around
   `commands::handler()`: before dispatch, read `invoke.message.webview().url()` (WKWebView's
   URL, which follows `pushState`) and reject unless the command's row in a small table
   admits it — bridge commands: `pin.admits(url)`; `start_gateway`: the local offline page.
   This catches the one case the navigation handler cannot see: an SPA `pushState` to
   another route of the same document. Declared once (the table), not a check repeated
   in each command.

4. **`bridge.js`:** the origin regex becomes an injected exact pin (`__EQUIN_PIN__` =
   `{ origin, base }`, filled like `scope.js`'s `__EQUIN_SCOPE__`); still main frame only.
   Advisory only — points 1–3 are the enforcement.

Residual, stated on the track page: app code itself (the reviewed SPA bundle) running in the
panel's main realm can always call the bridge — that is the pinned principal. Untrusted
content cannot get there: it cannot load as a frame (2), and the panel cannot move to a page
that hosts it (2, 3).

Out of scope (stays on the track): device powers moving into the helper (the [Design] item —
install/pin as bridge commands), Phase 4's app-window navigation (window.rs/scope.js), hygiene
(F8, F11). Tauri still prints the key on a bad call (F13) — harmless once pinned; noted.

## Files

- `plugins/menu-bar/rust/src/panel.rs` — `Pin`, `on_navigation`, `on_new_window`, URL from the pin.
- `plugins/menu-bar/rust/src/commands.rs` — the command table (name, permission, admits) feeding
  the gate wrapper, the runtime capability, and `build.rs`' manifest list where it can share.
- `plugins/menu-bar/rust/src/tray.rs` — `add_capability` in setup; gated handler.
- `plugins/menu-bar/rust/src/bridge.js` — injected pin.
- `plugins/menu-bar/rust/capabilities/panel-bridge.json` — deleted.
- `plugins/menu-bar/rust/src/cli.rs`, `main.rs` — the `probe` mode (below).
- `plugins/menu-bar/e2e/bridge-probe.ts` — the repeatable probe matrix.
- `plugins/menu-bar/CLAUDE.md` — Bridge section rewritten (pin, navigation, gate; "a new command =" list updated).

## Verification

0. **First, confirm the load-bearing assumption** with a throwaway `cargo build` + probe: the
   panel's `on_navigation` is called for `about:srcdoc` and `<object>`/`<embed>` frames. If
   srcdoc bypasses it, add a backstop in `bridge.js` (main-frame MutationObserver removing any
   frame element before its document loads, logged) and say so on the track page.
1. **Rust unit tests** (`cargo test` in `rust/`): `Pin::admits` (other namespace, other path,
   `/home/menu-bar/x`, https, port), the navigation decision, the gate table, the built
   capability's remote URL.
2. **`equin-desktop probe --namespace <ns>`** — no tray icon; builds the real panel (same
   builder, capability, gate), loads the pin, then natively `eval`s an attacker script in the
   main frame (the stand-in for Findings' temporary Core.Root plugin). Rows, each reported
   allowed/denied:
   | row | expected |
   |---|---|
   | main frame on the pin → `hostInfo` | allowed |
   | `srcdoc` iframe → `top.equinNative` / `top.__TAURI_INTERNALS__.invoke` | denied (frame refused) |
   | `sandbox="allow-scripts allow-same-origin"` same-origin frame (prototype setting) | denied |
   | opaque frame (`sandbox="allow-scripts"`) with a guessed key | denied |
   | `<object>` / `<embed>` with same-origin HTML | denied |
   | iframe on another namespace | denied (frame refused) |
   | `location.assign` to another namespace, then the bridge | denied (panel stays) |
   | `pushState('/agents')` then `hostInfo`; back to the pin then `hostInfo` | denied, then allowed |
   | `window.open` | no window; handed off (probe mode records, does not open a browser) |
   Results come back as `document.title` (`on_document_title_changed`), printed as JSON; the
   process exits non-zero on any unexpected row. Hand-off in probe mode is recorded, not run.
3. **`./equin run plugins/menu-bar/e2e/bridge-probe.ts`** — builds/resolves this worktree's
   helper (`menu-bar-helper` dep), runs the probe against this worktree's own deploy, prints
   the matrix via the harness `report()` (shape of `principal/e2e/cross-site-probe.ts`).
4. `./equin build`, then the real tray on this worktree (`equin-desktop tray --namespace <wt>`):
   app grid launches apps, task field files, notifications, footer's Open equin, panel height —
   unchanged.
5. Wiki: Phase 2 checkboxes + status on the track page; file the next main task (Phase 3,
   content isolation) with the track page id and instructions id.

## Outcome (2026-10-28)

- **Step 0 confirmed:** WebKit consults the panel's `on_navigation` for `about:srcdoc`, `<object>`
  and `<embed>` loads — no `bridge.js` backstop was needed.
- **Probe, this checkout's deploy and helper** (`./equin run plugins/menu-bar/e2e/bridge-probe.ts`):
  12/12 rows held (main frame answered; every frame kind, another namespace, `pushState` away,
  a navigated panel denied; `window.open` handed off, no window). ~27 s.
- **Negative control:** with `navigation_allowed` forced to `true`, the srcdoc frame got the
  bridge, the URL frames and the other namespace loaded, and the panel navigated away — the
  probe reports each as broken, so its "denied" rows are not vacuous.
- Results travel as one `document.title` per row, spaced 250 ms: WebKit cuts a long title
  (~1000 chars) and coalesces titles set back to back.
- Not done: a manual click-through of the real tray (the probe drives the same window, grant and
  gate, and the tray's own commands are unchanged).
