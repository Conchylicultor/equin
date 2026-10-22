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
<TransportProvider transport={browserServerTransport(server, { telemetry })}>…the unchanged app…</TransportProvider>
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

- **`serveOverPort(port, boot)`** (worker side, `port` = the worker's `self`):
  serves the `{ server, keys, boot }` `boot` resolves to over the port — `ready`
  with its keys, its boot report (`HostBoot`: stages, plugin count, slowest
  spans) and `readyAtMs` (the worker's clock, i.e. since it was created), or
  `failed` with the error (rethrown in the worker too).
  Requests and responses cross as plain data (bodies as transferred
  `ArrayBuffer`s), notifications sockets as numbered connections carrying the
  protocol frames verbatim.
- **`portBrowserServer(worker)`** (page side) → `Promise<{ server, keys, boot, readyAtMs }>`:
  a `BrowserServer` over that port, so `browserServerTransport` and the whole
  app path are unchanged. Rejects with `PortHostBootError` when the worker
  reports `failed`.

The worker itself is a plugin's `bin/browser-host.ts`, built by web-artifacts
(`browser-hosts.ts`) and imported by the page as `@browser-host/<pluginPath>`
(typed by `core/browser-host.d.ts`: `start(): Worker`).

Tests: `core/internal/port.test.ts` (a real `MessageChannel`: read, sub-ack, a
boot failure on both ends).

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

Tests: `web/__tests__/browser-server.test.tsx` drives the real
`NotificationsClient` through `<TransportProvider>` + `<NotificationsProvider>`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: A server that runs in the page's realm or across a worker's port — a third host of the unified live API (core: the BrowserServer interface; runtimeBrowserServer over a resource runtime booted in this realm; serveOverPort / portBrowserServer carrying one across a MessageChannel or a Web Worker). Web: browserServerTransport(server, { telemetry }), the Transport a <TransportProvider> points a subtree at — in-memory sockets to its runtime, requests through its router, an inert central socket.
- Web:
  - Uses:
    - `primitives/networking.publishWsStatus`
    - `primitives/networking.Transport`
    - `primitives/networking.TransportSocket`
  - Exports (values): `browserServerTransport`
- Cross-plugin:
  - Imported by: `framework/browser-server/demo/scope`
- Core:
  - Exports (types):
    - `BrowserServer`
    - `BrowserServerPeer`
    - `BrowserServerSocket`
    - `HostBoot`
    - `HostBooted`
    - `PortEnd`
    - `PortServer`
  - Exports (values):
    - `portBrowserServer`
    - `PortHostBootError`
    - `runtimeBrowserServer`
    - `serveOverPort`
- Test helpers:
  - Core: `@plugins/framework/plugins/browser-server/core/testing`
    - `channelHost` — A host's `start`, as a scenario's `host.start` takes it, whose "worker" is one end of an in-realm `MessageChannel`: the other end runs `serveOverPort` over the server `boot` returns — or, when `boot` throws, reports the failure (`PortHostBootError` on the page side), as a real worker whose graph fails to boot does.
    - `inRealmServer` — A browser server over a resource runtime in this realm, wired as a browser host is (`bootBrowserHost` + `runtimeBrowserServer`): the served declarations, the given routes and `/api/resources/:key` through the shared router, any other `/api` request the unsupported refusal (`unmatchedApiResponse`).
    - Types: `InRealmServerOptions`
- Sub-plugins:
  - **`demo`** — Demo scenarios for a browser server (core only): DemoScenario — the app, the route, and the browser host (DemoHost: the composition scope the page renders the demo in, and the worker whose real…

<!-- AUTOGENERATED:END -->
