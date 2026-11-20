# scope

`<DemoScope scenario>` renders its subtree against the scenario's browser host
(`framework/browser-server`) — real server code in a worker, on the scenario's
seed — so the unchanged app reads demo data through `useLive` /
`useFetchEndpoint` and nothing reaches the page's real server. Design:
`research/2026-10-14-global-demo-scope-and-pack.md` §2; page server retired by
`research/2026-10-21-global-demo-config-from-worker.md`.

```tsx
<DemoScope scenario={{ id: "agent-manager", app, route, host: browserHost }}>
  …the unchanged app…
</DemoScope>
```

- **One host connection per mount**: started in an effect (so StrictMode's
  remount ends the first), `<Loading/>` until the host reports ready, then one
  `browserServerTransport` over `portBrowserServer(end)`, with
  `<TransportProvider>` + `<NotificationsProvider>` around the children. The
  end is the host's SharedWorker (`startShared(scenario.id)`: every tab of
  the demo on one server and one database) — connected through
  `connectDemoHost` (`web/internal/connect.ts`), never to a worker that is
  retiring (its last tab went: it flushes and closes; the tab moves to the
  next host generation) — or a dedicated worker where the browser has no
  SharedWorker.
  Unmount disposes the server and leaves the connection.
- **A host that fails to boot stays in the demo's box.** With `boot`, the
  page draws it (`DemoBoot` `failed`: the error and `retry`), the failure
  reported once through `reportError` (the crash collector files it as any
  uncaught error) — never thrown, since the scope's error boundary is the
  page's: on the website it is the whole site's, so one module the visitor's
  network lost (a dropped connection, a content blocker) blanked every page
  (report-1795030621-pibl6l). `retry` connects again: the failed worker
  retired itself, so the next one boots fresh and fetches its modules again
  (Chrome does not keep a failed module fetch). Without `boot`, it throws to
  the error boundary. The same holds for the scope's on-demand web plugins
  (`useScopePlugins`, the standalone site's demo): one that does not load is
  drawn `failed` in the box (each plugin already filed by the loader's
  plugin-load report), and `retry` loads them again — before, it threw to the
  page's error boundary, so a chunk lost after Enter equin took equin.ai's
  homepage down with it (report-1794951421-c3g90t).
- **A failed host on stored data can start over.** Where what this browser
  stored is what fails (a database the host cannot open — Safari's PGlite
  `ERRORDATA_STACK_SIZE exceeded`, report-1795156708-k37rzk), a retry hits it
  again and Reset needs a running host. So a failed host on a scenario
  keeping data (`storage`), on a page with Web Locks, also offers `startOver`
  (`null` otherwise — without them nothing keeps a host off the data, and the
  worker keeps its data in memory anyway — and for plugins that did not load): the page wipes the storage itself
  (`host-storage/stored`'s `wipeHostData`, under the storage's lock) and
  boots a fresh host from the starting data, as after a Reset (browser-side
  state cleared too). A wipe that fails is drawn `failed` with its error.
- **A gate, where the page draws the boot** (`boot={(state) => …}`,
  `DemoBoot`: `gate` → `starting` with the worker's `HostProgress`). The
  visitor enters through the gate on every visit. Behind it, the scope asks
  whether this browser holds the scenario's data (`scenario.storage`,
  `host-storage/stored`'s `hostDataStored`): if so the host starts at once
  (entering is then instant); if not it starts nothing — no worker, no
  download — until the gate's `enter`. A Reset never asks again. Without
  `boot`, it starts at once behind `<Loading/>`.
- **Progress while it boots**: `portBrowserServer`'s `onProgress` hands the
  worker's reports (downloaded bytes, the starting data's bytes, plugins
  loaded) to the boot render.
- **No head start.** Starting the host from the page's `<head>` (a module
  script connecting before the app boots) was built for /demo and measured
  again on /about's website composition (2026-11-15, return visits, n=9
  each): host.js arrived at ~26 ms instead of ~500 ms, yet the worker was
  still created at ~1.2 s and ready no sooner (median 5.2 s with, 5.1 s
  without), while FCP/LCP rose ~160 ms (1.23 s vs 1.07 s; a first visit's
  plain page 0.82 vs 0.77 s). Chrome fetches a shared worker's script in the
  browser process behind the page's requests already in flight and hands the
  worker over through a task on the page's busy main thread, so the worker
  starts once the page's own load lets it, wherever the script sits. What
  moves it is a smaller page load or a shorter worker boot (graph ~3.5 s),
  not an earlier script.
- **Every tab shares the running host — it joins, never takes it.** A
  worker that finds the same host already serving the storage under another
  generation's name (two tabs connecting within ms of the last one leaving, a
  stale tab) declines with `{ kind: "join", worker }`: the scope joins that
  generation (`HostGenerations.join`) and connects there — no screen. A
  Reset or a retirement is followed the same way.
- **A boot the browser interrupted starts again.** A host declining
  `{ kind: "interrupted" }` (WebKit cut its IndexedDB work short while the
  page was suspended — back/forward cache, a background tab — `host-storage`) is neither a failure
  nor reported: the scope advances past that worker's generation and
  connects again, booting a fresh host.
- **When the host will not serve this page**, the cause decides the message
  (`StopReason`, an exhaustive map): `updated` — equin was updated in another
  tab (another build took the data, or the data is from newer code) — or
  `unshared` — a browser without SharedWorker opened the demo in another tab.
  Each with Reload; it never renders an app that cannot reach its server.
- **Reset** (`useDemoHostControl().reset()`, inside the scope — the /about
  demo band's "Reset demo"): the host wipes its storage and ends with
  `reset`; every tab's scope reconnects to a fresh host, which seeds again.
  The fresh host is the NEXT host generation's SharedWorker (`startShared` is
  named `<scenario>@<generation>`, the generation kept page-wide in
  localStorage, `web/internal/host-generation.ts`): the old worker closes
  itself, but Chromium hands a `new SharedWorker` of the same name to a dying
  worker until the browser process hears of its close — a tab reconnecting at
  once would wait on a worker that never answers. The resetting tab advances
  the generation before it sends Reset (a tab opened mid-wipe already asks for
  the next one), and every tab told `ended: "reset"` advances past its own.
  The generation is `{ current, highest }`: moving on reaches the generation
  the other tabs already moved to, else a name no tab used (`highest` + 1) —
  never one that is closing or that told a tab to join another; joining moves
  `current` back to the generation the host serves at.
- **Scoped to the host's composition**: the children render inside
  `<PluginScope composition={scenario.host}>` (`web-sdk`), so only the plugins
  the worker's composition ships contribute to any slot read inside the demo
  (page-wide slots such as `Pane.Register` excepted). An out-of-composition
  read has no spelling in the demo.
- **Everything is the host's**: the story, config (its registry runs over a
  memory store seeded lazily from the bundled committed layer,
  `config_v2/bundled-layer`), and every other key (real portable server code,
  or a `needsMachine` read answered unavailable). There is no page-side server
  and no backend slot.
- **Nothing unanswered, by construction**: the build's browser-host coverage
  guard (codegen's `core/browser-host-coverage.ts`, run by
  `deriveBrowserHostGraph`) proves every live read, endpoint and config
  document the scoped plugins use is served by the worker's graph or declared
  `needsMachine` — answered `unavailable` without a request, rendered "not
  available". Nothing exempts it.
- **A gap the guard missed fails loudly**, never quietly: an unserved key
  fails `loader-failed` naming it (the host's key set is closed →
  `unserved`), terminal, never as skew; an unsupported endpoint is the host's
  409 refusal, thrown and reported like any other endpoint failure. There is
  no "not available in the demo" toast.
- **Frames by URL**: `attachFrameServing` runs alongside the host boot (the
  host module's `serviceWorkerUrl`); the scope's transport carries its
  `frameBase` — `null` where the browser has no Service Worker, so a frame
  shows `unsupported` (`contentUrlOver`). Unmount detaches it. See
  `browser-server`'s *frame serving*.
- **Telemetry** (D3 of `research/2026-10-22-global-demo-scope-sealed.md`):
  the scope's transport inherits the enclosing page's `telemetry` flag, so the
  reports and timings the demo's own traffic raises (endpoint errors, live
  read errors, latency samples) reach the page's own server; strict mode is
  `{ telemetry: false }`, which every emission site honours. Page-wide
  handlers (`window.onerror`, boot, the UI's observers) are the page's either
  way.
- **Boot time** — every host boot writes one line to the `demo-host-boot` client log
  (`~/.equin/worktrees/<wt>/logs/demo-host-boot.jsonl`, also the page console): the wait
  the page saw, the worker's ready instant on its own clock, its stages (`graph`: load →
  ready barrier with migrations; `seed`), the plugin count and the slowest boot spans.
  The same boot is handed to `browser-server`'s `hostBootReportSink` (when the
  scope's `telemetry` is on), which `debug/slow-ops` files once per boot as
  `boot browser-host:<scenario>` against its own budget — never on the reads,
  which mount only once the host is ready.

Tests (jsdom, the real `NotificationsClient`): `web/__tests__/demo-scope.test.tsx`,
over `browser-server/core/testing`'s `inRealmServer` + `channelHost` (an
in-realm `MessageChannel` standing in for the worker).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: <DemoScope scenario>: renders its subtree against the scenario's browser host — real server code in a worker, on the scenario's seed — and scoped to the host's composition (<PluginScope>), so the page shows exactly the plugins the worker serves. Everything inside reaches the host only (the scope's transport): the build's coverage guard holds the host to serving every read, endpoint and config the scope uses, or declaring it needsMachine (answered unavailable); a key or endpoint it still does not serve fails loudly. A host that fails to boot is drawn by the boot render (failed: reported through reportError, with a retry that boots a fresh host), and throws to the error boundary where there is none. An optional boot render gates the demo on every visit (DemoBoot: checking, the gate, then starting with the worker's progress, or failed): the visitor enters it (enter), or — while they are in the demo in another tab of this browser (a shared Web Lock each such tab holds) — the tab joins it with no gate (onEnter hears both, and which: the gate's click, or a join no one acted on); a page whose own URL says whether the visitor is in decides alone (resume: true — no gate, only the loading; false — the gate, no join); behind the gate, a browser already holding the demo's data starts the host at once, a first visit only on enter, since it downloads the whole server and its data. Connects to one SharedWorker per build (every tab of the demo shares its server and data: a worker that finds the same host serving under another name sends the tab there — it joins, never takes it), shows the true cause when the host will not serve the page (equin updated in another tab; a browser without SharedWorker that opened it in another tab), and exposes Reset (useDemoHostControl) — the host wipes its data and every tab reconnects to a fresh one.
- Web:
  - Uses: 25 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `framework/browser-server` ×7
    - `primitives/networking` ×3
    - `network/live/live-state` ×2
    - `primitives/dom/web-storage` ×2
    - `network/live.useLive`
    - `primitives/css/center.Center`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/css/ui-kit.Button`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/loading.Loading`
    - `primitives/log-channels.clientLog`
    - `primitives/scope/render-origin.RenderOrigin`
    - `ui/icons/sprites.ScopeIconSymbols`
  - Exports (types):
    - `DemoBoot`
    - `DemoEntry`
    - `DemoHostControl`
  - Exports (values):
    - `DemoScope`
    - `useDemoHostControl`
- Cross-plugin:
  - Uses tokens: `ui/tokens/density --space-lg`
  - Imported by:
    - `apps/website/landing/screenshot/chrome`
    - `apps/website/live-demo`

<!-- AUTOGENERATED:END -->
