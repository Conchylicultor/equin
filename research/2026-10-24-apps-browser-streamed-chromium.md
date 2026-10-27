# Browser app: a real Chromium, streamed (experiment)

## Context

The Browser app (`plugins/apps/plugins/browser`) renders each tab as an
`<iframe>`. Most sites refuse framing (`X-Frame-Options`, CSP
`frame-ancestors`, JS frame-busting), so the app shipped a framing-stripping
proxy (`browser/proxy`): server-side fetch, header stripping, HTML rewriting,
an injected nav script. It is leaky by construction — no cookies/logins,
no WebSockets/service workers, cross-origin XHR broken, JS apps break.

Replace it: every tab is a page in a **real Chromium** (persistent profile, so
logins stick), streamed to a `<canvas>` with CDP `Page.startScreencast`, input
forwarded with CDP `Input.*`. The proxy, the escape overlay and the iframe go.
This is an experiment; the user asked for it to be built autonomously.

## Architecture

```
web: webview <canvas> ──ws /ws/browser/engine──▶ gateway ──▶ backend machine/ wsRoutes
                                                                │ relay (ws+unix)
                                                                ▼
                         bin/host.ts (detached, one per machine) ── Playwright persistent context
                                                                     └─ one Page per remote tab key
```

- **Host process** (`browser/engine/bin/host.ts`), detached, one per machine,
  modelled on the agent-browser host (`infra/mcp/browser/bin/host.ts`):
  `flockTry` singleton, atomic `status.json` (protocol, codeId, launcher
  namespace), `Bun.serve({ unix })` with a `websocket` handler. It owns a
  Playwright **persistent context** (`launchPersistentChromium` — a new sibling
  of `launchChromium` in `infra/deps/playwright-browser`) on the app's data dir
  area `profile`. Tabs survive backend restarts (every push to main restarts
  main's backend). Exits 30 min after its last tab closed.
- **Backend relay** (`browser/engine/machine/`): `wsRoutes["/ws/browser/engine"]`
  — one client socket ↔ one host socket, bytes passed through. `ensureHost()`
  as in `infra/mcp/browser/server/internal/host-client.ts`: Chromium dep check
  (`readyNow`/`requestDep`, dep `chromium` from `safe-fetch/browser-fetch`),
  `defineDaemon(...).launchDetached`, status-file watch. Upgrade rule: main
  replaces a host with another codeId; a worktree replaces a host it launched
  itself (dev iteration) and otherwise uses a same-protocol host. `machine/`
  because the portable `server/` half may not spawn processes.
- **Wire protocol** (`browser/engine/core/protocol.ts`, zod): one socket per
  *viewed* tab.
  - client → host (JSON text): `attach {key, url, viewport{w,h,dpr}}` (first
    message; host creates the page at `url` when the key is unknown),
    `navigate {url}`, `back`, `forward`, `reload`, `stop`, `resize`,
    `mouse {type, x, y, button, buttons, clickCount, modifiers}`,
    `wheel {x, y, dx, dy, modifiers}`, `key {type, key, code, keyCode, text,
    modifiers, commands?}`, `insertText {text}`, `ime {text, selStart, selEnd}`,
    `copy` (request the selection), `dialog {accept, promptText?}`,
    `select {value}`, `close` (close the remote page).
  - host → client: **binary = one JPEG frame**; JSON text events: `state {url,
    title, faviconUrl, loading, canGoBack, canGoForward}`, `cursor {value}`,
    `copied {text}`, `dialog {type, message, defaultValue}`, `select {options,
    rect}`, `popup {key, url}` (window.open / target=_blank — the client opens
    an app tab adopting that key), `download {name, path}`, `error {message}`.
- **Screencast**: `Page.startScreencast {format: jpeg, quality ~70, maxWidth,
  maxHeight = css size × dpr (dpr capped at 2)}` while a socket is attached;
  stopped on detach. Ack each frame after `ws.send` succeeds; a backpressured
  socket (`send` < 1 / buffered high) drops the frame but still acks later on
  drain — never queues stale frames. Viewport = the canvas CSS size via
  `Emulation.setDeviceMetricsOverride`.
- **Page helpers** (init script + `exposeBinding`): report the CSS cursor under
  the pointer on change; replace native `<select>` popups (not in the
  screencast) by reporting options + rect and applying the choice; selection
  read for copy. Native context menu: out of scope.

## Web side

- **Shell store** (`browser/shell/web/nav-store.ts`) becomes host-driven:
  `BrowserTab = {id, key, url, title, faviconUrl, loading, canGoBack,
  canGoForward, request: {seq, cmd} | null}`. `navigate/back/forward/reload`
  record a `request` (seq bump); the viewport sends the active tab's unsent
  request over its socket; host `state` events write back via
  `report(tabId, state)`. Drop `history[]`, `loadKey`, `expectCommit`,
  `escaped`, `proxyEnabled`, `useBrowserProxy`, `commit/syncDisplay/markEscaped`.
  `current` and `useBrowserTabs()` keep their meaning, so omnibox, history,
  bookmarks, start-page keep working. `url === ""` still = start page (no
  remote page until the first navigation). Tab strip shows the real title and
  favicon.
- **Viewport** (`browser/webview`): rewritten — a canvas (+ a hidden textarea
  that owns focus for keys/IME/paste) for the active tab only; the socket is
  open only while the tab is active and visible. Uses
  `useReconnectingWebSocket` from `primitives/networking`, extended with binary
  (`binaryType: "arraybuffer"`, `send(string | ArrayBuffer)`). Frames drawn
  with `createImageBitmap` on the next animation frame (latest-wins). Pointer
  events → `mouse` (clickCount = `event.detail`), wheel → `wheel`, keydown/up →
  `key` with the mac editing `commands` (Cmd+A/C/X/V/Z handled: Cmd+C/X send
  the key then `copy` → `navigator.clipboard.writeText`; paste event →
  `insertText`), composition events → `ime`. Cursor mirrored onto the canvas.
  Dialogs / select menus / downloads rendered with existing primitives. Not
  available (`servesUrls` false, demo scope) → a placeholder saying so.
- **Delete** `browser/proxy` entirely, `webview/escape-*`, the
  `proxy-toggle` entries in `config/apps/browser/shell/actions*.jsonc`;
  update the app's description.

## Files

- New: `plugins/apps/plugins/browser/plugins/engine/{core,bin,machine,data-dirs,exempt,package.json}`;
  `plugins/apps/plugins/browser/data-dirs/index.ts` (`defineAppDataDir(browserApp)`, area `profile`).
- Edit: `plugins/infra/plugins/deps/plugins/playwright-browser/deps` (+`launchPersistentChromium`),
  `plugins/primitives/plugins/networking/web/use-reconnecting-ws.ts` (binary),
  `browser/shell/web/nav-store.ts` (+ index exports), `browser/webview/web/**`,
  `browser/tabs/web/**` (title/favicon), config jsonc.
- Delete: `plugins/apps/plugins/browser/plugins/proxy/`.

## Out of scope (follow-ups)

Audio; native context menu; drag out of the page; file drop from the desktop
(file chooser via `filechooser` event is in if cheap); agents attaching to the
user's tabs through `browser_*` (the big payoff — the host already holds the
pages). Tab restore and the file chooser landed later:
`research/2026-10-27-apps-browser-tab-restore-and-uploads.md`.

## Verification

1. `./equin build`, open `/browser` with the `browser_*` MCP tools on this
   build: navigate to a framing-hostile site (github.com, google.com), check
   frames render, click a link, type in a search box, back/forward/reload,
   triple-click selects a paragraph, scroll, a `target=_blank` link opens an
   app tab, a `<select>` works.
2. Measure input→frame latency in the client (timestamp a `mouse` send, the
   next frame's arrival) and log it; report the numbers.
3. `./equin check` passes (boundaries, no-raw-websocket exemption declared,
   lint).
