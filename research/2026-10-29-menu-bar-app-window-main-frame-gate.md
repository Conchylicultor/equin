# App windows decide main-frame loads before the fact (Trust boundaries, Phase 4)

Track: page `block-f3f30a77-fa7e-4db0-ab22-be3884857103`; End vision → "Native windows (principle 4)"; Findings F7.

## Context

An installed app's window (`plugins/menu-bar/rust/src/window.rs`, the helper's window mode) keeps to its
namespace's origin. Today it learns a main-frame load left that origin only from `on_page_load(Finished)`,
**after** the foreign page has loaded and run. It then hands the URL off and `window.eval`s
`history.back()` / `location.replace(home)` **inside the foreign page**. This breaks principle 4 ("the holder
decides, before the fact; it never asks the page to undo it"), and a page can flood the default browser
with hand-offs (`window.open` in a loop, chained navigations).

Why it was built that way: Tauri's `on_navigation(Fn(&Url) -> bool)` gets only a URL. wry's
`navigation_policy` (`wry-0.57.1/src/wkwebview/navigation.rs:64`) discards `WKNavigationAction.targetFrame`,
so the callback cannot tell the main frame from an iframe. The panel avoids the problem by refusing every
frame. An app window cannot do that: it must keep framing `<item>.content.localhost` (Phase 3) and foreign
embeds.

## Approach: wrap wry's navigation delegate, decide on the main frame natively

The information exists natively. wry just drops it:
- **macOS:** `WKNavigationAction.targetFrame.isMainFrame` (before the request is sent) and
  `WKNavigationResponse.isForMainFrame` (before a response commits, which catches server redirects).
- **Linux:** WebKitGTK's `decide-policy` with a `ResponsePolicyDecision` and
  `is_main_frame_main_resource()` (v2_40, which wry already enables). It runs before the response commits:
  nothing renders and no script runs. A navigation-action decision there has no main-frame flag, so Linux
  decides at the response. The request has been sent, but the page never loads.

### 1. `rust/src/scope_gate.rs` (new, pure, unit-tested)
- `fn admits_main_frame(scope: &Url, url: &Url) -> bool`: non-web schemes (`about:`, `blob:`, `data:`)
  are admitted as today, and web URLs must pass `shim::in_scope(scope, url)`.
- `struct HandOffGate`, which collapses bursts. `admit(&mut self, url, now: Instant) -> Admit::{Go, Collapsed}`
  applies two rules:
  - the same URL within 2 s is collapsed (a double click, a redirect loop);
  - at most 3 hand-offs in any 10 s window, with the rest collapsed.
  It uses timestamps only, with no timers. Each collapsed hand-off logs
  `equin-desktop: collapsed hand-off of <url> (n in burst)`.
- `fn hand_off(url)` (moved from `window.rs`) goes through one process-wide `Mutex<HandOffGate>`, then
  calls `shim::hand_off` on a thread. Both the main-frame gate and `on_new_window` use it.

### 2. `rust/src/main_frame.rs` (new, platform hooks)
`pub fn install(window: &WebviewWindow, decide: Arc<dyn Fn(&Url) -> bool + Send + Sync>)`, run through
`window.with_webview`. `decide` returns *admit?*. On refuse, the hook cancels the load and the closure has
already handed the URL off.
- **macOS:** an objc2 `define_class!` proxy, `EquinMainFrameDelegate`, whose ivars hold
  `inner: Retained<ProtocolObject<dyn WKNavigationDelegate>>` (wry's delegate, read via
  `navigationDelegate()`) and `decide`.
  - `webView:decidePolicyForNavigationAction:decisionHandler:`: when `targetFrame` is the main frame and
    `decide` refuses → `Cancel`. Anything else is forwarded to `inner`, so Tauri's `on_navigation` and
    downloads still run.
  - `webView:decidePolicyForNavigationResponse:decisionHandler:`: when `isForMainFrame` and `decide`
    refuses the response URL → `Cancel`. Anything else is forwarded.
  - `respondsToSelector:` / `forwardingTargetForSelector:` cover the rest of wry's methods (didCommit /
    didFinish, which are page-load events, plus downloads and process termination).

  `setNavigationDelegate(proxy)`. The webview holds its delegate weakly, so the proxy is kept alive in
  `app.manage(...)`. It is a per-webview wrapper, never a swizzle, so the panel and the probe are untouched.
- **Linux:** `webview.inner().connect_decide_policy(...)`. On `PolicyDecisionType::Response` with
  `is_main_frame_main_resource()` and `decide` refusing → `ignore()`, return `true`. Otherwise return
  `false`, which leaves wry's handler and WebKit's default in place.
- New deps, at the versions already in `Cargo.lock`:
  - macOS: `objc2 0.6`, `block2 0.6`, `objc2-foundation 0.3`, and `objc2-web-kit 0.3` with the features
    `WKNavigationDelegate`, `WKNavigationAction`, `WKNavigationResponse`, `WKFrameInfo`, `WKWebView`,
    `block2`.
  - Linux: `webkit2gtk 2` with `v2_40`.

### 3. `rust/src/window.rs`
- `build_window` installs the gate right after `build()` with
  `decide = |url| admits_main_frame(&scope, url) || { hand_off(url); false }`.
- **Delete** the in-page step-back (`window.eval(...)`) and **`src/scope.js`** with its
  `initialization_script`:
  - a link click, a form submit and `location.*` are all main-frame navigation actions, so the native gate
    now catches them;
  - `target=_blank` / `window.open` are already caught by `on_new_window`;
  - the `pushState` wrappers are dead code, because the scope's base is always `""` and a cross-origin
    `pushState` throws.

  After this, no script is injected into any page of an app window.
- `on_page_load(Finished)` stays as a **loud backstop** for an invariant that should never break. If a main
  frame finishes off-scope, it logs `equin-desktop: BUG: main frame reached <url> past the gate` and
  replaces the page natively with `window.navigate(home)`, never with script. It also asserts the gate was
  installed before the first in-scope load finishes, so a race shows up loudly.
- Update the module doc comment.

### 4. Live probe: `equin-desktop probe-window --namespace <ns>` + `plugins/menu-bar/e2e/window-probe.ts`
`rust/src/probe_window.rs` follows `probe.rs`:
- it builds the **real** app window through `build_window`, with an injected hand-off sink that records the
  hand-offs instead of opening them;
- it records every gate decision (URL, main frame or not, admitted);
- it loads `http://<ns>.localhost:9000/home` and evaluates `rust/src/probe_window.js` natively in the main
  frame (the stand-in for app code that navigates away);
- it prints one JSON line per row, then a verdict.

For that, `build_window` takes a small `WindowHooks { hand_off, on_decision }`. The real launch passes
`scope_gate::hand_off` and no observer.

Rows. Foreign URLs are `https://equin-probe.invalid/…`, so nothing reaches the network:

| row | expected |
|---|---|
| link click off-origin | refused on the main frame before load, handed off once, page stays |
| `location.assign` / `location.replace` off-origin | same |
| form POST off-origin | same |
| main frame to another namespace (`http://<other>.localhost:9000/`) | same |
| in-namespace route (another app) | admitted, loads |
| iframe on `<item>.content.localhost:9000` and an iframe on a foreign site | admitted as non-main-frame decisions, no hand-off, page stays |
| burst: 30 `window.open` + 30 `location.assign` to distinct foreign URLs | ≤ 3 hand-offs, the rest collapsed, page stays |
| invariant | no off-scope `PageLoadEvent` for the whole run (the foreign page never loaded) |

`window-probe.ts` reuses `bridge-probe.ts`'s runner: ensure the dep, spawn, parse rows, `report()`.
That runner is extracted into `plugins/menu-bar/e2e/index.ts` as `runHelperProbe(args, title)`, so both
scripts share it.

**Negative control (manual, reported, never shipped):** with the gate's `install` call temporarily removed,
the off-origin rows and the invariant must turn red.

### 5. Docs & track
- `plugins/menu-bar/CLAUDE.md` (Window mode, Probe) and the End vision "Native windows" bullets: describe
  the native gate rather than `scope.js` plus a backstop.
- On the track page:
  - tick Phase 4 and fill in its Status block (the rule, why not Tauri's callback, verified live: n/n);
  - set the next step;
  - file the **next main task**, one only, with the page ids: the remaining Phase 2 `[Design]`, device
    powers moving to the helper.

## Files
- New: `rust/src/scope_gate.rs`, `rust/src/main_frame.rs`, `rust/src/probe_window.rs`,
  `rust/src/probe_window.js`, `e2e/window-probe.ts`, `e2e/index.ts`.
- Edited: `rust/src/window.rs`, `rust/src/main.rs` / `cli.rs` (the `probe-window` subcommand),
  `rust/Cargo.toml`, `e2e/bridge-probe.ts` (uses the shared runner), `plugins/menu-bar/CLAUDE.md`.
- Deleted: `rust/src/scope.js`.

## Verification
1. `cargo test` in `rust/` covers the `HandOffGate` windows, `admits_main_frame`, and the existing scope
   tests.
2. Build: `./equin deps install menu-bar-helper`, then `./equin build`.
3. `./equin run plugins/menu-bar/e2e/window-probe.ts`: all rows held. Then run the negative control by hand.
4. Regression: `./equin run plugins/menu-bar/e2e/bridge-probe.ts` still 12/12. Open an installed app
   window by hand: the launcher moves to another app in the same window, a page embed with a foreign site
   and a prototype frame still render, and an external link opens once in the browser.
5. `./equin check`.

## Risks
- **Linux is compiled and reasoned about only.** This machine is macOS and the probe runs on macOS. The
  Linux hook is ~15 lines on a documented API.
- The delegate proxy depends on WebKit honouring `respondsToSelector:` / forwarding. wry's delegate
  implements only plain selectors (no `preferences:` variant), so the two overridden selectors are the ones
  WebKit calls. The probe's "in-namespace route loads" row and the page-load events prove forwarding works.
