# browser-server

A server that runs in the page (or a worker): the **third host of the unified
live API**, beside the Bun server and central. It is not a second way to
register resources — declarations (`liveValue`, `liveCollection`,
`defineEndpoint`), the client (`useLive`, `NotificationsClient`), the wire
protocol (`createResourceRuntime`), serving (`network/live`'s `serveValueOn` /
`serveCollectionOn`) and routing (`http-router`) are the one code path every
host runs. A host contributes only its runtime instance, its socket and request
entry points, its error sink and what it serves. It knows nothing about demos.
Design: `research/2026-10-13-framework-browser-server-host-v2.md` (D).

## Usage

```ts
// core/ — no DOM, no React
const server = createBrowserServer({
  serve: (s) => [
    s.serveValue(transcript, { source: "external", changes: { fixed: { reason: "demo pack" } },
      loader: ({ id }) => pack.transcript(id) }),
    s.serveCollection(conversations, { source: "external", changes: "notified",
      all: () => pack.conversations, rows: (ids) => pack.byIds(ids) }),
  ],
  routes: [[markViewed.route, implement(markViewed, () => undefined)]],
  unserved: (key) => new Error(`not served here: ${key}`),
});

// web/ — one transport per server, kept for its lifetime
<TransportProvider transport={browserServerTransport(server)}>…the unchanged app…</TransportProvider>
```

## core/: `createBrowserServer`

- **The runtime** is `createResourceRuntime({})`: the portable `snapHash`, no
  read-set, no L2, no profiler.
- **`serve(s)`** — `s` is `bindExternalServe(runtime, "worktree")`
  (`network/live/core`): `serveValue` / `serveCollection` typed by
  `LiveExternalServe<"worktree">`, external arm only (no change feed). It
  returns what it served (`{ keys }` — every served value and collection
  carries them).
- **Unserved keys fail as `loader-failed`, never as version skew.** Every
  descriptor `live-state/core` knows (`allResourceDescriptors()`) whose key
  nothing served is registered with an external loader rejecting
  `unserved(key)` — keyed ones on the point arm, which registers any keyed
  contract and reads nothing before its loader. A descriptor registered later
  (a lazy plugin) is registered as it arrives
  (`onResourceDescriptorRegistered`). The client sees `loader-failed` (the
  runtime does not ship a loader's message — the read names the key), which
  never touches the page-global contract-mismatch store; an unknown key would
  read as skew and advise a reload. Serving a key twice — or serving one
  without returning it from `serve` — is the runtime's loud duplicate-key
  throw. A central value (`origin: "central"`) is skipped: the central channel is not
  hosted.
- **`request(req)`** — the shared router (`createRequestHandler`) over
  `routes` plus `[RESOURCE_HTTP_ROUTE, runtime.handleResourceHttp]`. Unmatched:
  an `/api/…` path is `unsupportedEndpointResponse` from `infra/endpoints/core` —
  `409 { reason: "unsupported", method, path }`, which `fetchEndpoint` throws as
  `EndpointUnsupportedError` without reporting it (the server
  is real, that endpoint is just not part of it — `/api/central-resources/*`
  included), any other path a 404 naming it. `onError` defaults to
  `console.error`.
- **`connect(peer)`** — one in-memory notifications socket: a stable
  `RuntimeSocket` (the runtime keys its state by it) whose `send` calls
  `peer.deliver(frame)`; the returned end's `send(frame)` is the runtime's
  `message`, `close(code?, reason?)` its `close` (idempotent; a `send` after
  it throws). `dispose()` closes every socket from the server side — each
  peer's `closed(code, reason)` is told, as a real socket's close event — and
  stops following late descriptors.

## core/: a server in a Web Worker (`port.ts`, `compose.ts`)

- **`serveOverPort(port, boot)`** (worker side, `port` = the worker's `self`):
  serves the `{ server, keys }` `boot` resolves to over the port — `ready`
  with its keys, or `failed` with the error (rethrown in the worker too).
  Requests and responses cross as plain data (bodies as transferred
  `ArrayBuffer`s), notifications sockets as numbered connections carrying the
  protocol frames verbatim.
- **`portBrowserServer(worker)`** (page side) → `Promise<{ server, keys }>`:
  a `BrowserServer` over that port, so `browserServerTransport` and the whole
  app path are unchanged. Rejects with `PortHostBootError` when the worker
  reports `failed`.
- **`runtimeBrowserServer({ request, notifications })`** — a `BrowserServer`
  over a resource runtime a host booted in this realm (server-core's
  `bootBrowserHost`); `createBrowserServer` shares its socket wiring
  (`runtime-socket.ts`).
- **`composeBrowserServers(parts, fallback)`** — several servers behind ONE
  transport, routed by key (every frame names its key): a key belongs to the
  first part whose `keys` hold it, else to `fallback`. A `sub-batch` is split
  per server (a `complete` one reaches every server); `unsub-tab` reaches all;
  pings come from `fallback` only; a non-resource request tries `fallback` and
  then each part while the answer is an unsupported refusal. A server may be
  both a part and the fallback.

The worker itself is a plugin's `bin/browser-host.ts`, built by web-artifacts
(`browser-hosts.ts`) and imported by the page as `@browser-host/<pluginPath>`
(typed by `core/browser-host.d.ts`: `start(): Worker`).

Tests: `core/internal/port.test.ts` (a real `MessageChannel`: read, sub-ack, a
boot failure on both ends, a composition routing a split `sub-batch`).

## web/: `browserServerTransport(server)`

A `Transport` (`primitives/networking`). Make ONE per server: the scoped
live-state pipeline is keyed by transport identity.

- `socketUrl(p)` / `assetUrl(p)` → `browser:<server.id>:<p>` (an asset is
  unloadable; the routes it serves need none).
- `openSocket(url)` — the worktree notifications path is a socket over
  `server.connect`: `onopen` on a microtask after `publishWsStatus(open)`,
  frames delivered to `onmessage` on a microtask (a reply never re-enters the
  `send` that caused it), `setLastWill` stored and sent by `close()`, which then
  closes the end and publishes "closed"; a server-side close publishes
  "closed" and sends nothing more. Any other path (central) is an inert socket
  that publishes "closed".
- `fetch(input, init)` → `server.request(new Request(new URL(input,
  "http://browser-server.invalid"), init))` (a `Request` input is routed as is).

Tests: `web/__tests__/browser-server.test.tsx` drives the real
`NotificationsClient` through `<TransportProvider>` + `<NotificationsProvider>`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: A server that runs in the page — a third host of the unified live API (core: createBrowserServer serves liveValue / liveCollection declarations on a real resource runtime through serveValueOn / serveCollectionOn, routes requests through the shared http-router, and fails every other known resource key as loader-failed). Web: browserServerTransport(server), the Transport a <TransportProvider> points a subtree at — in-memory sockets to its runtime, requests through its router, an inert central socket.
- Web:
  - Uses:
    - `primitives/networking.publishWsStatus`
    - `primitives/networking.Transport`
    - `primitives/networking.TransportSocket`
  - Exports (values): `browserServerTransport`
- Core:
  - Uses:
    - `framework/http-router.createRequestHandler`
    - `framework/http-router.RouteHandler`
    - `framework/resource-runtime.createResourceRuntime`
    - `framework/resource-runtime.KeyedResourceContract`
    - `infra/endpoints.isUnsupportedEndpointRefusal`
    - `infra/endpoints.unsupportedEndpointResponse`
    - `network/live.bindExternalServe`
    - `network/live.LiveExternalServe`
    - `packages/resource-protocol.RESOURCE_HTTP_ROUTE`
    - `primitives/live-state.allResourceDescriptors`
    - `primitives/live-state.onResourceDescriptorRegistered`
    - `primitives/live-state.ResourceDescriptor`
  - Exports (types):
    - `BrowserServe`
    - `BrowserServed`
    - `BrowserServer`
    - `BrowserServerOptions`
    - `BrowserServerPeer`
    - `BrowserServerSocket`
    - `ComposedServer`
    - `PortEnd`
    - `PortServer`
  - Exports (values):
    - `composeBrowserServers`
    - `createBrowserServer`
    - `portBrowserServer`
    - `PortHostBootError`
    - `runtimeBrowserServer`
    - `serveOverPort`
- Cross-plugin:
  - Imported by: `framework/browser-server/demo/scope`
- Sub-plugins:
  - **`demo`** — Demo packs (core) and the two slots a plugin answers its own keys in every demo scope through (web): Demo.Resource (a useBackend hook returning a plugin's per-scope backend: a browser server serve…

<!-- AUTOGENERATED:END -->
