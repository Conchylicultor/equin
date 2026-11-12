# browser-server

A server that runs in the page's realm or across a worker's port: the **third
host of the unified live API**, beside the Bun server and central. It is not a
second way to register resources — declarations (`liveValue`,
`liveCollection`, `defineEndpoint`), the client (`useLive`,
`NotificationsClient`), the wire protocol (`createResourceRuntime`), serving
(`network/live`'s `serveValueOn` / `serveCollectionOn`) and routing
(`http-router`) are the one code path every host runs. A host contributes only
its runtime instance, its socket and request entry points. It knows nothing
about demos. Design: `research/2026-10-13-framework-browser-server-host-v2.md`
(D); the page server was retired by
`research/2026-10-21-global-demo-config-from-worker.md` — every browser server
now hosts a booted plugin graph (server-core's `bootBrowserHost`), there is no
hand-served page-side server.

## Usage

```ts
// worker (a plugin's bin/browser-host.ts) — boot the graph, serve it over the port
serveOverPort(port, async () => {
  const host = await bootBrowserHost({ entries: hostEntries, seed, onUnmatched: unmatchedApiResponse });
  return { server: runtimeBrowserServer(host), keys: new Set(host.keys), boot: host.boot };
});

// page — one transport per server, kept for its lifetime
const { server } = await portBrowserServer(worker);
const frames = await attachFrameServing(worker, serviceWorkerUrl); // alongside the boot
<TransportProvider transport={browserServerTransport(server, { telemetry, frameBase })}>…the unchanged app…</TransportProvider>
```

## core/: the `BrowserServer` interface

`{ id, request(req), connect(peer), dispose() }` (`internal/browser-server.ts`).
Two implementations:

- **`runtimeBrowserServer({ request, notifications })`** — over a resource
  runtime a host booted in this realm (`runtime-socket.ts`).
  - `request` is the host's router: the graph's routes plus
    `/api/resources/:key`; an unmatched `/api/…` path is
    `unmatchedApiResponse` (`infra/endpoints/core`) —
    `409 { reason: "unsupported", method, path }`, which the fetcher throws
    and reports like any other endpoint failure — under a browser host it is
    a gap the build's coverage guard missed (`/api/central-resources/*`
    included); any other path is a 404 naming it.
  - `connect(peer)` — one in-memory notifications socket: a stable
    `RuntimeSocket` (the runtime keys its state by it) whose `send` calls
    `peer.deliver(frame)`; the returned end's `send(frame)` is the runtime's
    `message`, `close(code?, reason?)` its `close` (idempotent; a `send` after
    it throws). `dispose()` closes every socket from the server side — each
    peer's `closed(code, reason)` is told, as a real socket's close event.
- **`portBrowserServer(worker)`** (page side) — a `BrowserServer` over a port
  (see below).

**A browser host serves a closed key set.** `bootBrowserHost` closes the
runtime's key set before booting the graph, so a key no plugin of the graph
serves is refused `unserved` (HTTP 404, no verdict, reported once per key) —
which the client reads as a terminal `loader-failed` naming the key, never as
version skew ("App updated — reload"). See `resource-runtime`'s `keySet`.

## core/: a server in a Web Worker (`port.ts`)

- **`serveHost({ accept, boot, reset?, onEnded? })`** (worker side): serves
  the host on every page END `accept` hands over — a dedicated worker's `self`
  once, or each connection of a SharedWorker (several tabs, one server). Each
  end is told `ready`, or `refused` (the boot threw a `HostRefusedError`,
  carrying a typed `HostRefusal`: `outdated` — its data is from newer code —
  or `join` — the same host already serves it as another SharedWorker, which
  the page connects to instead) or `failed`.
  Every end is told `accepted` first. An end whose page holds a Web Lock says
  so (`hello`, sent by `connectSharedHost`); the host drops that end's sockets
  when the lock is released (the tab went away). `retire: { lock, run }` (a
  SharedWorker host): once its last end left and every request it was
  answering settled, it takes `lock` exclusively and, still with no end, ends
  `retired` and runs `run` — see *A SharedWorker host's end of life* below.
  `reset` (a page's
  Reset) runs `opts.reset`, then every end is told `ended: "reset"` (and a
  host with `retire` then retires, under its lock — a SharedWorker closes only
  so); the returned `end(why)` tells every end `ended` from the worker's side,
  after which the host answers nothing. `HostEndReason` is a closed union, one
  arm per cause — `reset`, `retired` (followed by the page), `updated`
  (another build took the storage), `unshared` (no SharedWorker: another
  tab's own worker took it) — so a page decides by the cause. `browser-server/host-storage`'s `serveBrowserHost` builds on it.
- **`serveOverPort(port, boot)`** (worker side, `port` = the worker's `self`):
  serves the `{ server, keys, boot }` `boot` resolves to over the port — `ready`
  with its keys, its boot report (`HostBoot`: stages, plugin count, slowest
  spans) and `readyAtMs` (the worker's clock, i.e. since it was created), or
  `failed` with the error (rethrown in the worker too).
  Requests and responses cross as plain data (bodies as transferred
  `ArrayBuffer`s), notifications sockets as numbered connections carrying the
  protocol frames verbatim.
- **`portBrowserServer(end)`** (page side; a `Worker` or a SharedWorker's
  `port`) → `Promise<{ server, keys, boot, readyAtMs, ended, reset }>`:
  a `BrowserServer` over that port, so `browserServerTransport` and the whole
  app path are unchanged. Rejects with `PortHostBootError` when the worker
  reports `failed`, `PortHostRefusedError` (its `refusal`) when
  `refused`. `ended` resolves with the reason the host stopped serving; every
  request still waiting, and every later one, rejects `HostEndedError`.
  `reset()` asks the host to wipe its data.
- **`attachPort(worker, port)`** hands the worker one more end (`ToHost`'s
  `attach` arm, the port transferred) that `serveOverPort` answers exactly as
  its own (requests queue until the graph is up); **`portRequester(end)`** is
  the requesting half over any such end — what `portBrowserServer` and the
  frame-serving Service Worker both send requests through.

## core/: a SharedWorker host's end of life (`shared-host.ts`)

A SharedWorker host is started with `extendedLifetime` (the host module's
`startShared`): Chromium would otherwise terminate it the instant its last tab
closes or reloads, losing whatever it was still answering or flushing (the
demo's PGlite runs with `relaxedDurability`; dropping it costs ~25 ms a write
and ~8 ms a read — `research/2026-11-10-framework-browser-host-end-of-life.md`).
Left alone, an extended worker never ends, so it RETIRES itself: when no page
holds it, it finishes its requests, closes its storage and then the worker.

A worker that has called `close()` is still matched by `new SharedWorker(url,
name)` until the browser process hears of it, and a page matched to it waits
for good (no message, no error, no port `close`). So retiring is done under
the Web Lock `retireLockName(name)`: the worker takes it EXCLUSIVELY, and only
with no end; a page connects only through **`connectSharedHost({ open, name,
passed })`**, which takes it SHARED with `ifAvailable` and holds it until the
worker's `accepted`. Found taken, the name is retiring: `passed(name)` moves
`name()` on (the demo: the next host generation) and it tries again. The
connection (`{ name, port, leave }`, port not started) also holds the page's
presence lock and sends `hello`. Without Web Locks (a test realm) it just
connects. Limits: a browser without `extendedLifetime` (Firefox, Safari) still
ends the worker with its last tab; a tab killed between `new SharedWorker` and
its `hello` reaching the worker leaves an end that never leaves (the worker
then lives until the browser ends it); a head start no scope ever takes holds
the retire lock shared until its tab goes.

The worker itself is a plugin's `bin/browser-host.ts`, built by web-artifacts
(`browser-hosts.ts`) and imported by the page as `@browser-host/<pluginPath>`
(typed by `core/browser-host.d.ts`: `start(): Worker`, `startShared(name):
SharedWorker` — one worker per build and name, every tab connected to it,
through `connectSharedHost` — and
`serviceWorkerUrl`, the frame-serving Service Worker built beside it).
Where its state lives (memory, or IndexedDB across reloads, tabs and builds) is
the `host-storage` sub-plugin's.

Tests: `core/internal/port.test.ts` (a real `MessageChannel`: read, sub-ack, a
boot failure on both ends, an attached port answering beside the page's).

## core/testing: servers for tests

Tests cannot start a real Web Worker:

- **`inRealmServer({ serve?, routes?, keySet? })`** — a browser server over a
  runtime in the test's own realm, wired as a browser host is (closed key set
  by default, the shared router, the unsupported refusal for any other `/api`
  path).
- **`channelHost(boot)`** — a scenario `host.start` whose "worker" is one end
  of an in-realm `MessageChannel` running `serveOverPort` over `boot()`'s
  server (or reporting its failure, as a real worker whose graph fails to
  boot). Both ports are `.start()`ed — `addEventListener` alone does not.

## Page inputs — a value the page hands its host (`pageInput`, `HostInputs.Supply`)

A host's own code never reads the page's server. A fact that is the PAGE's —
the Maps browser key the real app already sends that page — reaches the host
from the page's chrome instead, declared by the plugin owning the value:

- `web/`'s `HostInputs.Supply({ value: liveValue })` — "a page may hand this
  value of its own server to a browser host" (`google-maps` supplies
  `google-maps.browser-config`).
- `demo/scope`'s `DemoScope` (page chrome, the page's registry and transport)
  reads every supply with `useLive` and posts it over the port:
  `portBrowserServer(end, { inputs })` lists the keys at connect (`inputs`
  frame), `PortServer.supply(key, input)` sends each value (`input` frame,
  `{ kind: "value" | "failed" }`).
- In the worker, `core`'s `pageInput(key)` reads it: `absent` when no
  connected page declares the key, else the newest value (waiting for the
  first); `watch(changed)` hears each new one. Memory only — never in the
  host's storage, so never in a build-time snapshot. A host provider serves it
  (`google-maps/page-config`).

## Third-party hosts — `ExternalHosts.Declare`

`web/`'s `ExternalHosts.Declare({ hosts, reason })`: the hosts a plugin's code
loads from in the page or the worker (Google's map, the instruments' sample
CDNs) — the one exception to "no request leaves the browser"; the page's own
server is never one. Literal hosts, read statically by the browser-host
codegen (codegen's `parseExternalHostsDeclarations` over the scoped web
barrels) into each host's `externalHosts` (`core/browser-host.generated.ts`),
which the demo's no-leak e2e holds every off-origin request to.

## web/: `browserServerTransport(server)`

A `Transport` (`primitives/networking`). Make ONE per server: the scoped
live-state pipeline is keyed by transport identity.

- `socketUrl(p)` → `browser:<server.id>:<p>` (the socket's identity on the
  ws-status bus, distinct from the page's).
- `servesUrls: false` — no URL reaches a server in the page, so an element's
  asset (`AssetPath`) is fetched through `fetch` below and handed over as a
  blob URL by `useAssetSrc` (`infra/endpoints`).
- `openSocket(url)` — the worktree notifications path is a socket over
  `server.connect`: `onopen` on a microtask after `publishWsStatus(open)`,
  frames delivered to `onmessage` on a microtask (a reply never re-enters the
  `send` that caused it), `setLastWill` stored and sent by `close()`, which then
  closes the end and publishes "closed"; a server-side close publishes
  "closed" and sends nothing more. Any other path (central) is an inert socket
  that publishes "closed".
- `fetch(input, init)` → `server.request(new Request(new URL(input,
  "http://browser-server.invalid"), init))` (a `Request` input is routed as is).
- `telemetry` — whether the telemetry its traffic raises is reported (to the
  page's own server: a browser server keeps none); the caller passes the
  enclosing page's setting, or `false` to drop it.
- `frameBase` — where its frame documents load by URL
  (`attachFrameServing`'s), or `null` where nothing serves them.

Tests: `web/__tests__/browser-server.test.tsx` drives the real
`NotificationsClient` through `<TransportProvider>` + `<NotificationsProvider>`.

## web/: frame serving — a frame document by URL

An `<iframe>` whose relative sub-resources (`styles.css`, a CSS `url()`) must
resolve beside it cannot load a blob URL, and no URL reaches a server in a
worker. So every browser host carries a **Service Worker**
(`web/frames-sw.ts`, built by web-artifacts as a classic script into the
host's artifact dir, `frames-sw.js`; exported as the host module's
`serviceWorkerUrl`) that answers frame documents from the worker:

- **Scope** — the `frames/` dir beside the script,
  `/artifacts/<host dir>/frames/`: each build has its own, and an
  uncontrolled request there (a shift-reload, no Service Worker) misses the
  artifact store, which the gateway answers 404 — never the app.
- **URL** — `<scope><serverId>/api/…` (`frames-protocol.ts`): the server's own
  path behind a fresh id per attachment, so two tabs never answer each other's
  frames. `frameBase` is the prefix the transport's `content` serving (`same-origin`, with its reason) puts in front of a content path; `contentUrlOver`
  (`infra/endpoints`) builds the URL.
- **`attachFrameServing(worker, serviceWorkerUrl)`** (page, run alongside the
  host boot) → `{ kind: "serving", frameBase, detach }` | `{ kind:
  "unsupported", reason }` (no Service Worker here: an insecure origin, a
  private window refusing registration). Registers the script on its scope and
  waits for `activated` (never `navigator.serviceWorker.ready`: the page is
  outside the scope, never controlled), drops registrations an earlier build
  left (`/artifacts/*/frames/`) that no tab holds — a serving page holds a
  shared Web Lock named by its scope until it detaches, so a tab still on an
  older build keeps its frames — then hands one end of a channel to the worker
  (`attachPort`) and the other to the Service Worker. A Service Worker
  restarted from idle has lost its ports: it asks every window
  (`need-port`) ONCE per server id however many frames wait, the owning page
  hands a fresh one (a second port for an id already served is closed, never
  swapped in under requests in flight), and with no answer in 5 s it answers
  a loud 503 page.
- **The Service Worker** answers GET and HEAD only (a HEAD as the GET without
  its body), routes by server id, refuses a segment decoding to `.`, `..`, a
  separator or NUL (`%2e%2e`, `%2f` — the URL parser folds only literal dot
  segments), lets a cross-origin request pass, and answers any other
  same-origin request of a frame 404 — a frame's absolute `/api` path never
  reaches the page's server. The page's own elements are never controlled:
  they keep `useAssetSrc`'s blobs.

Tests: `web/frames-protocol.test.ts` (routing, encoded traversal),
`demo/scope`'s `demo-scope.test.tsx` (frame base null without a Service
Worker; with a stubbed one: registration, stale-scope drop, the handed port
reaching the server, detach on unmount).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: A server that runs in the page's realm or across a worker's port — a third host of the unified live API (core: the BrowserServer interface; runtimeBrowserServer over a resource runtime booted in this realm; serveOverPort / portBrowserServer carrying one across a MessageChannel or a Web Worker). Web: browserServerTransport(server, { telemetry, frameBase }), the Transport a <TransportProvider> points a subtree at — in-memory sockets to its runtime, requests through its router, an inert central socket; attachFrameServing(worker, serviceWorkerUrl) serves the server's frame documents by URL through the host's frame-serving Service Worker (frames-sw.ts), giving the transport its frameBase. HostInputs.Supply: a plugin declares a value of the page's own server the page may hand a browser host (a page input). ExternalHosts.Declare: the third-party hosts a plugin's code loads from in the page, read statically into each browser host's externalHosts.
- Web:
  - Slots:
    - `HostInputs.Supply`
    - `ExternalHosts.Declare`
  - Slot contributors:
    - `HostInputs.Supply` ← `integrations.google-maps.browser-config`
    - `ExternalHosts.Declare` ← `apps.prototypes.canvas`
    - `ExternalHosts.Declare` ← `apps.sonata.audio.piano`
    - `ExternalHosts.Declare` ← `apps.sonata.audio.soundfont`
    - `ExternalHosts.Declare` ← `map.google`
  - Uses:
    - `primitives/networking.publishWsStatus`
    - `primitives/networking.Transport`
    - `primitives/networking.TransportSocket`
  - Exports (types):
    - `ExternalHostsDeclaration`
    - `FrameServing`
    - `HostBootInfo`
    - `HostInputSupply`
  - Exports (values):
    - `attachFrameServing`
    - `browserServerTransport`
    - `ExternalHosts`
    - `hostBootReportSink`
    - `HostInputs`
- Cross-plugin:
  - Imported by:
    - `apps/demo`
    - `apps/prototypes/canvas`
    - `apps/sonata/audio/piano`
    - `apps/sonata/audio/soundfont`
    - `debug/slow-ops`
    - `framework/browser-server/demo/prestart`
    - `framework/browser-server/demo/scope`
    - `framework/browser-server/host-storage`
    - `integrations/google-maps/browser-config`
    - `integrations/google-maps/page-config`
    - `map/google`
- Core:
  - Exports (types):
    - `BrowserServer`
    - `BrowserServerPeer`
    - `BrowserServerSocket`
    - `HostBoot`
    - `HostBooted`
    - `HostEndReason`
    - `HostProgress`
    - `HostRefusal`
    - `PageInput`
    - `PageInputRead`
    - `PageInputValue`
    - `PortEnd`
    - `PortServer`
    - `PortServerOptions`
    - `ServedHost`
    - `ServeHostOptions`
    - `SharedHostConnection`
  - Exports (values):
    - `attachPort`
    - `connectSharedHost`
    - `HostEndedError`
    - `HostRefusedError`
    - `pageInput`
    - `portBrowserServer`
    - `PortHostBootError`
    - `PortHostRefusedError`
    - `portRequester`
    - `reportDataProgress`
    - `reportingLoads`
    - `retireLockName`
    - `runtimeBrowserServer`
    - `serveHost`
    - `serveOverPort`
- Test helpers:
  - Core: `@plugins/framework/plugins/browser-server/core/testing`
    - `channelHost` — A host's `start`, as a scenario's `host.start` takes it, whose "worker" is one end of an in-realm `MessageChannel`: the other end runs `serveOverPort` over the server `boot` returns — or, when `boot` throws, reports the failure (`PortHostBootError` on the page side), as a real worker whose graph fails to boot does. `serviceWorkerUrl` is the host module's frame-serving script URL — only a test that stubs `navigator.serviceWorker` registers it.
    - `inRealmServer` — A browser server over a resource runtime in this realm, wired as a browser host is (`bootBrowserHost` + `runtimeBrowserServer`): the served declarations, the given routes and `/api/resources/:key` through the shared router, any other `/api` request the unsupported refusal (`unmatchedApiResponse`).
    - Types: `InRealmServerOptions`
- Sub-plugins:
  - **`bun-host`** — A browser host's server graph as Bun boots it (a build's snapshot take, a boot test): withDiskProviders swaps the two providers whose data is bundled text through vite's import.meta.glob, which Bun…
  - **`demo`** — Demo scenarios for a browser server (core only): DemoScenario — the app, the route, and the browser host (DemoHost: the composition scope the page renders the demo in, and the worker whose real…
  - **`host-storage`** — Where a browser host keeps its state: in memory (lost with the worker) or persistent (IndexedDB, named), declared once by the worker's entry point before boot (declareHostStorage / hostStorage).…
  - **`test-host`** — Test harness that boots a slice of the app's server registry as a portable host under bun test: the registry or portable dependsOn closure of some roots, plus — derived, never hand-listed — one host…

<!-- AUTOGENERATED:END -->
