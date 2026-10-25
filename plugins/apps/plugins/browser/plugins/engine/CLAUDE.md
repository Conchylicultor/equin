# engine

The Browser app's tabs are pages in a real Chromium, streamed: CDP
`Page.startScreencast` JPEG frames out, CDP `Input.*` in. Plan:
`research/2026-10-24-apps-browser-streamed-chromium.md`.

```
web canvas ──ws ENGINE_WS_PATH──▶ gateway ──▶ backend machine/ relay ──ws+unix──▶ bin/host.ts ── Chromium (persistent context)
```

## The host (`bin/`)

ONE detached process per machine (`bin/host.ts`), modelled on the agent
browser's host (`infra/mcp/browser`): `flockTry(host.lock)` singleton (the loser
exits 0), an atomic `status.json` (`shared/host-files.ts`: protocol, `codeId`,
pid, `launchedBy` namespace, page/socket counts, idle deadline), and
`Bun.serve({ unix: host.sock })` — `ENGINE_WS_PATH` upgrades to a tab socket,
`POST /shutdown {reason}` exits. It owns one Playwright persistent context
(`launchPersistentChromium`, profile in the app's data dir area
`apps/browser/profile`, so logins stick) and one `Page` per remote key
(`bin/host-pages.ts`).

- **Which Chromium**: on macOS the installed **headed** Chromium, as a
  background-only copy (`bin/background-app.ts`: the app bundle with
  `LSBackgroundOnly`, re-signed ad hoc, cached in `cache/browser-engine-app`
  per build) — no Dock icon, no Cmd+Tab, no menu bar. Headed means the GPU
  draws (Metal WebGL, GPU compositing) and sites see a real browser
  (`window.chrome`, plugins); the headless shell was flagged by bot checks
  (Google's reCAPTCHA looped). Its windows sit off-screen (launch flags, and
  `Browser.setWindowBounds` for every page's window), unthrottled; the viewed
  page is brought to the front of its window on attach. `LSUIElement` makes
  Chromium abort at start — do not use it. Elsewhere: the headless shell.
- **Not an automated browser**: no `--enable-automation`, Blink's
  `AutomationControlled` off — `navigator.webdriver` is false.

- **Wire** (`core/protocol.ts`, zod): one socket per *viewed* tab. First client
  message `attach {key, url, viewport}` (creates the page when the key is
  unknown); binary host messages are JPEG frames, text ones `HostEvent`s. Bump
  `ENGINE_PROTOCOL` on any change.
- **One socket per key**: a new attach closes the old one (4000).
- **Frames are latest-wins**: a frame that would queue behind > 512 KB is held
  unacked and sent on `drain` (Chromium sends no other until the ack); the
  relay applies the same rule on its hop.
- **Frames are device pixels**: Chromium is launched with
  `--force-device-scale-factor=2` and each page's metrics override keeps the
  window's scale (`deviceScaleFactor: 0`); a 1x client's frames are scaled down
  by the screencast's `maxWidth/maxHeight`. A CDP `deviceScaleFactor` alone
  gives 1x frames in headless, and the `viewport` override that forces device
  pixels pins the captured region to the document's top (scrolled-to content
  never drawn) — do not reintroduce it.
- **Page helpers** (`bin/page-script.ts`, an init script + `exposeBinding`,
  top frame only): CSS cursor under the pointer, title + favicon (a
  MutationObserver), `<select>` popups reported as options + rect (the native
  popup is never in a frame), selection read for `copy`.
- **The UA** says `Chrome`, not `HeadlessChrome` (sites refuse that): the
  context is relaunched once with the corrected UA.
- **Popups** (`context.on("page")` for a page the host did not open) get a new
  key, announced as `popup` on the opener's socket — or, for `noopener`
  (`target=_blank`'s default), on the page that last got input.
- **Downloads** go to `~/Downloads` (a free name), announced as `download`.

## Lifecycle

- A page with no socket: frozen after 60 s (`Debugger.pause` — headless pages
  are always "visible" and rasterize on the CPU), closed after 30 min. Attach
  thaws it and clears both deadlines. `close` closes it now.
- The host exits 30 min after it has no page and no socket, on `/shutdown`, or
  on SIGTERM/INT/HUP — closing the context (flushing the profile) and writing
  an `exited` status.
- One-shot deadlines and file watchers; nothing polls.

## The backend half (`machine/`)

`wsRoutes[ENGINE_WS_PATH]` = `machine/internal/relay.ts`: per client socket,
`ensureHost()` then a `ws+unix://` socket to the host; bytes pass through
(binary stays binary), client messages are buffered until the host socket
opens, each side closes the other. No host to reach → one `error` event and a
1013 close (the client's reconnect retries).

`ensureHost()` (`machine/internal/host-client.ts`): refused in a release;
Chromium via `readyNow` (not installed → `requestDep` and an error saying it is
installing); `defineDaemon(...).launchDetached` `bun bin/host.ts --launched-by
<namespace>`; waits on the status file (`defineFileWatcher`). A running host
with this checkout's `codeId` (hash of `bin/` + `shared/` + `core/`) and
protocol is used. Otherwise **main**, or the namespace that launched it (a
worktree iterating on the engine), replaces it (`/shutdown`, then relaunch —
open tabs reload into fresh pages); any other backend uses a same-protocol
host and refuses another protocol.

Files: `services/browser-engine/` (`data-dirs`) — `host.sock`, `host.pid`,
`host.lock`, `status.json`.

## Not yet

Audio; native context menu; `<select>` / cursor inside iframes; file chooser;
agents attaching to the user's tabs.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The Browser app's engine, backend half: relays each viewed tab's socket (ENGINE_WS_PATH) byte for byte to the machine's engine host over its Unix socket — launching the host (a detached `bin/host.ts`, Chromium on a persistent profile in apps/browser/profile) when there is none, after checking Chromium is installed (requesting the install when not), and replacing it when it runs other code and this backend is main or the namespace that launched it.
- Exemptions:
  - Exempts itself from:
    - `no-raw-websocket` — `machine/internal/relay.ts` (sanctioned)
    - `boundaries/no-platform-api` — `shared/code-id.ts` (sanctioned)
- Core:
  - Exports (types):
    - `ClientMessage`
    - `EngineViewport`
    - `HostEvent`
    - `PageState`
  - Exports (values):
    - `ClientMessageSchema`
    - `ENGINE_PROTOCOL`
    - `ENGINE_WS_PATH`
    - `HostEventSchema`
    - `PageStateSchema`
- Machine:
  - Register:
    - `defineDaemon('browser-engine.host')`
    - `defineFileWatcher('browser-engine.host-status')`

<!-- AUTOGENERATED:END -->
