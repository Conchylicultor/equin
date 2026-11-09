# Open the current browser tab in its app's window (`equin://open`)

## Context

A page of equin open in Chrome cannot become its app's own macOS window: the
helper's bridges (`equinNative`, `equinWindow`) exist only inside the helper's
own webviews, so a Chrome tab has no way to reach the device. The native half
already exists — every installable app has a shim (`~/Applications/equin
<Name>.app`), `shim::owner_of(url)` finds the app owning a URL and
`shim::launch(shim, Some(url))` brings its window forward on that URL (or
starts it there). What is missing is a channel from the tab to the helper.

Outcome: an **Open in app window** row in the action bar's View options
popover. Clicking it opens `equin://open?url=<this page>`; macOS hands the link
to `equin.app` (the tray helper), which opens the page in its app's window.

## Design

Device powers stay in the helper (menu-bar CLAUDE.md, trust boundaries): the
server is not involved. The channel is a URL scheme the equin app bundle
registers — the OS's own browser→app channel; Chrome asks once ("Open equin?",
with *Always allow*).

### 1. The link format — `plugins/menu-bar/core`

`OPEN_LINK_SCHEME = "equin"` and `openLink(pageUrl): string` →
`equin://open?url=<encodeURIComponent(pageUrl)>`. The Rust side parses the same
grammar (`rust/src/open_link.rs`), unit-tested on the same examples.

### 2. The bundle registers the scheme — `infra/launcher/login-services`

Generic: an `AppComponent` declares `urlSchemes?: readonly string[]` (the
schemes whose links macOS hands this component — only meaningful on the main
component, which LaunchServices runs). `InstalledComponent` records it
(absent in old records = none), `sameComponent` compares it, and
`renderAppInfoPlist` emits `CFBundleURLTypes` (one entry, `CFBundleURLName`
`dev.equin`, the union of the components' schemes). The install already
re-registers the bundle with LaunchServices (`host.register`). The menu-bar
login service declares `urlSchemes: [OPEN_LINK_SCHEME]`.

### 3. The helper opens it — `plugins/menu-bar/rust`

- `src/open_link.rs`: `parse(link) -> Result<Url, String>` (scheme `equin`,
  host `open`, one `url` query param, http(s) only) and `open(link)`: the page
  goes to the installed app owning it (`shim::owner_of` + `shim::launch`),
  through the same burst gate as every hand-off (`scope_gate::hand_off`).
  **Never the default browser**: a link any website can build must not become
  an arbitrary-URL opener — a page with no installed app is refused, logged,
  and the user gets a notification saying so.
- `tray.rs`: `RunEvent::Opened { urls }` (macOS) → `open_link::open` each.
- `cli.rs` / `main.rs`: `equin-desktop open-link <link>` — the same path from
  a shell (verification; the Linux `x-scheme-handler` Exec later).

### 4. The button — `plugins/menu-bar/plugins/open-in-window` (web)

`ActionBar.ViewOption` row (icon `open_in_new`, "Open in app window"),
`onSelect` → `window.location.href = openLink(window.location.href)` (read at
click time). Hidden inside an installed app's window (`inAppWindow()`, a new
export of `menu-bar/app-window`: `window.equinWindow` is present) and off
macOS (the helper registers the scheme there only).

## Out of scope

- Linux (`.desktop` `MimeType=x-scheme-handler/equin` + `xdg-mime default`).
- Several windows per app (the running window navigates instead).
- Detecting from the page whether the helper is installed (Chrome silently does
  nothing for an unhandled scheme).

## Verification

- `cargo test` in `plugins/menu-bar/rust` (link parsing).
- `./equin test plugins/infra/plugins/launcher/plugins/login-services`
  (plist renders `CFBundleURLTypes`, old records read back).
- `cargo build --release` + `target/release/equin-desktop open-link
  'equin://open?url=http%3A%2F%2Fequin.localhost%3A9000%2Ffiles'` opens File
  Explorer's window (uses the installed shims).
- `./equin build`, screenshot the View options popover showing the row.
- After the push, main's boot reinstalls `equin.app` with the scheme; `open
  'equin://open?url=…'` then exercises the Apple-event path.
