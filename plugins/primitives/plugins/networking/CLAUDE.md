# networking

## SharedWebSocket: one socket per URL, owned by a SharedWorker

`SharedWebSocket` shares one server WebSocket per URL across every tab of the
origin. The real socket lives in a SharedWorker (`web/shared-ws.worker.ts`, one
instance per URL via the worker `name`); each tab is a thin port client. No tab
owns the socket, so closing, freezing or crashing a tab never interrupts the
others — there is no leader to lose. Design:
`research/2026-10-08-networking-shared-worker-transport.md`.

- **Layout.** `shared-ws-protocol.ts` (the tab ↔ worker messages, `proto`),
  `socket-owner.ts` (the real socket: queue-until-open, reconnect backoff, a fresh
  connection id per open), `shared-ws-host.ts` (`createSharedWsHost`: the
  worker's logic, free of worker globals), `shared-ws.worker.ts` (the thin entry
  wiring the real `WebSocket` / `navigator.locks`), `shared-websocket.ts` (the
  tab client).
- **The worker bundles only this plugin's own files.** Import maps do not reach
  workers, and an artifact's address hashes only its own plugin, so
  web-artifacts' inline audit fails the build on any other first-party import
  from the worker's closure. That is why `reconnect-backoff.ts` spells its delay
  out instead of using `packages/retry`.
- **One worker per networking build.** The worker script is content-addressed
  next to the tab code naming it, so a tab only ever talks to a worker of its own
  build; during a rollout old and new tabs hold one socket each. The address is
  networking's OWN web artifact (`/artifacts/<networking web dir>/assets/
  shared-ws.worker-<hash>.js`), whose hash covers only this plugin's inlined
  files plus the global builder identity (`web-artifacts`, *A worker is bundled
  whole*) — so an edit to a consumer (live-state) never moves it; an edit to
  networking's `web/` or a builder/toolchain change does.
- **One worker per dialect.** `new SharedWebSocket(url, hooks?, { dialect })`
  — the dialect is part of the worker's name (`sharedWsWorkerName`), so a tab
  shares its socket only with tabs of the same dialect. The worker fans every
  server frame out to every tab on the socket, so a consumer whose server may
  answer one tab with a frame another bundle of it would misread names one its
  readers share. **A dialect is a protocol id, never a build id**: it must move
  exactly when the frames a tab reads change. live-state passes `PROTOCOL`
  (`packages/resource-protocol`, a hash of its frame vocabulary), so a tab left
  open across a deploy that changed the vocabulary never sees a frame of the
  newer one, while every other deploy keeps all tabs on one socket — a module
  URL (its old dialect) split the socket on every rebuild of live-state. No
  dialect = every tab of this networking build.
- **`onopen` fires once per server connection per tab** (consumers replay their
  state there): the worker re-sends its status on every port join/leave, and the
  tab dispatches only when the connection id changes (or after a re-attach).
- **Tab liveness.** A SharedWorker gets no port-close event, so each tab holds a
  Web Lock per port and attaches only once it is held; the worker queues for the
  same lock and, when granted, knows the tab is gone. `pagehide` always detaches
  (a bfcache'd page must not look alive); a persisted `pageshow` re-attaches.
- **Last will.** `setLastWill(frame)` — the worker sends it to the server when
  the port leaves, however it leaves. live-state registers its `unsub-tab` there.
- **Fail loudly.** No SharedWorker / Web Locks, a worker load error, or a
  protocol mismatch throws; there is no fallback transport.

## `Transport` — where a subtree's server traffic goes

`web/transport.ts`: a `Transport` is `{ socketUrl, openSocket, fetch,
servesUrls, machine, telemetry }`. **There is no default transport**:
`useTransport()` throws outside every `<TransportProvider>`. The app root
(`framework/web-core`'s `App.tsx`) mounts the page's own server,
`pageTransport` (leaf child plugin `plugins/page-transport`: same-origin
`SharedWebSocket`, the global `fetch`, assets loaded by their own path); a
`<TransportProvider>` points a subtree elsewhere — an in-browser backend
(`framework/browser-server`'s `browserServerTransport`;
`research/2026-10-22-global-demo-scope-sealed.md`). Every client resolves its
transport through `useTransport()` (or is handed one): live-state's
`NotificationsProvider` (one pipeline per transport), endpoints'
`useFetchEndpoint` / `useEndpoint` / `useEndpointMutation`, and the assets
elements load (`useAssetSrc(assetPath)`, `infra/endpoints`). `socketUrl` doubles as the socket's identity on
the page-global ws-status bus, so two transports must never map one path to
the same URL. `fetchWithRetry` takes the transport's `fetch` as an option.

- **`machine`** — whether the computer is behind the transport (`needsMachine`
  declarations answer `unavailable` without asking when it is not).
- **`servesUrls`** — whether an element can load the transport's `/api/…`
  paths by URL itself (the page's own server). `false` (an in-browser server):
  `useAssetSrc` fetches an asset through `fetch` and hands out a blob URL,
  ref-counted per transport (`transportScoped`) and revoked with its last
  holder.
- **`telemetry: boolean`** — whether the telemetry this subtree's server
  traffic raises is reported (to the page's own server, the one receiver).
  A flag, never a transport: nothing in a subtree can reach the page's server
  through its context. Each emission site checks the transport its traffic
  went over — the fetcher's `endpointErrorSink` (and `readNdjson`'s),
  live-state's client (`resourceErrorReportSink`, `httpStaleDropReportSink`,
  the `update` latency sample — `NotificationsClient` takes it as a hook) and
  the optimistic overlay (divergence reports, `confirm` samples; a rejection
  is the user's notice, raised regardless). The page's is `true`; a browser
  server's is the enclosing page's (`useTransport().telemetry` where the
  scope mounts); `false` drops it at the source. Page-wide handlers (reports'
  `report()`, latency, slow-ops, usage, analytics, logs, the UI's own
  observers) send through `pageTransport` under a sanctioned exemption.
- **`pageTransport` is lint-guarded.** `networking/no-page-transport` (this
  plugin's `lint/`) flags every import of the page-transport barrel — and of
  live-state's page-pipeline accessors (`getNotificationsClient`,
  `ensureNotificationsClient`), which reach the same server without naming
  it; each sanctioned importer declares a `kind: "sanctioned"` entry in its
  own `exempt/index.ts`. **No inline opt-out**: the
  `networking:no-inline-page-transport-disable` check (`check/`) fails any
  `eslint-disable` naming the rule, so every page-bound module is in a
  manifest — which is what the browser-host coverage guard trusts when it
  reads a page-bound module's endpoints as the page's.
- **Per-tab sockets go through the transport too.**
  `useReconnectingWebSocket({ path })` opens its socket by URL on the
  subtree's transport and throws under one no URL reaches (`servesUrls:
  false`), so a consumer that may render in a scope checks `servesUrls` first
  (`LiveLogChannel` says "not available"). There is no exported `wsUrl`: a
  socket URL built from `window.location` would reach the page's server from
  inside a scope.
- **`transportScoped(make)` / `useTransportScoped(scoped)`** — one value per
  transport (a `WeakMap`), for a module that needs one store / cache / client
  per server it talks to: the endpoints fetcher, live-state's pipeline, the
  pending-turn store, the page editor's content-doc registry, the asset blob
  store.
- **Tests.** `web/testing`: `testTransport(overrides?)` (page-shaped, the
  global `fetch` read at call time, so a stubbed fetch answers),
  `transportWrapper(t)` (a `render` / `renderHook` wrapper) and
  `renderWithTransport(ui, { transport? })`.

## Transport injection seams + deterministic fakes

`SharedWebSocket` and the worker host never touch the OS globals directly — they
go through injected factories that default to the globals:

- `new SharedWebSocket(url, hooks?, options?)` — `SharedWebSocketHooks` carries
  `makeSharedWorker`, `locks`, `pageLifecycle` (`null` ⇒ none). Production
  passes nothing (`options` is not a seam: its `dialect` names who shares the
  socket; `SharedWebSocketOptions`, exported for a consumer whose own socket
  factory forwards it — live-state's `makeSocket(url, options)` hook).
- `createSharedWsHost({ makeWebSocket, locks })` — the worker entry passes the
  real ones; tests pass fakes. The structural types (`WebSocketLike`,
  `SharedWorkerLike`, `MessagePortLike`, `LockManagerLike`) live in
  `web/transport-types.ts`.

`web/testing/transport-fakes.ts` (published as `@plugins/primitives/plugins/networking/web/testing`, no vitest dependency) provides the
deterministic fakes: `FakeWebSocket`/`FakeWsServer` (scripted server frames,
captured sent frames, restart), `FakeMessagePort` (real-microtask delivery,
structured clone), `FakeLockManager` (async microtask grant, FIFO queue,
`releaseTab`), `FakeSharedWorkers` (one REAL `createSharedWsHost` per worker
name, in-process), `FakePageLifecycle`, and `createTransportHub()` composing
them per-"tab" with a `kill()` affordance (ports go silent, locks free). The
tests in `web/__tests__/` and live-state's `web/__tests__/` (H1/H2/H4/H6/H7) are
built on them — see
`research/2026-07-03-global-live-state-client-transport-harness.md`. Run with
`./singularity test plugins/primitives/plugins/networking plugins/primitives/plugins/live-state`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: WebSocket / EventSource / fetch primitives with reconnection, status-bus, and retry. Used by live-state internally and by terminal/logs/health/stats directly.
- Load-bearing: yes
- Web:
  - Uses: `primitives/latest-ref.useLatestRef`
  - Exports (types):
    - `FetchWithRetryOptions`
    - `LockManagerLike`
    - `MakeSharedWorker`
    - `MessagePortLike`
    - `NetDiagEvent`
    - `PageLifecycleLike`
    - `ReconnectingEventSourceOptions`
    - `ReconnectingWsHandle`
    - `ReconnectingWsOptions`
    - `SharedWebSocketHooks`
    - `SharedWebSocketOptions`
    - `SharedWorkerLike`
    - `Transport`
    - `TransportScoped`
    - `TransportSocket`
    - `UrlStatus`
    - `WsStatus`
    - `WsStatusEvent`
  - Exports (values):
    - `fetchWithRetry`
    - `probeUrlStatus`
    - `publishNetDiag`
    - `publishWsStatus`
    - `ReconnectingEventSource`
    - `SharedWebSocket`
    - `subscribeNetDiag`
    - `subscribeWsStatus`
    - `TransportProvider`
    - `transportScoped`
    - `useReconnectingWebSocket`
    - `useTransport`
    - `useTransportScoped`
- Cross-plugin:
  - Imported by: 29 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives` ×6
    - `conversations` ×5
    - `apps` ×4
    - `debug` ×3
    - `framework` ×3
    - `infra` ×2
    - `page` ×2
    - `network/live`
    - `shell/notifications`
    - `tasks/tasks-core`
    - `ui/icons/emoji`
- Exemptions:
  - Exempts itself from:
    - `no-raw-websocket` — `web/shared-ws.worker.ts`, `web/use-reconnecting-ws.ts` (sanctioned)
    - `no-raw-event-source` — `.` (sanctioned)
    - `endpoints/no-raw-web-fetch` — `web` (sanctioned)
  - Exempted by:
    - `apps-core/app-usage` (0 debt)
    - `apps/deploy/analytics/collect` (0 debt)
    - `debug/latency-ledger` (0 debt)
    - `debug/slow-ops` (0 debt)
    - `framework/web-core` (0 debt)
    - `infra/boot-snapshot` (0 debt)
    - `infra/health` (0 debt)
    - `primitives/log-channels` (0 debt)
    - `reports` (0 debt)
    - `ui/icons/sprites` (0 debt)
- Core:
  - Exports (types):
    - `WsTestControls`
    - `WsTestEvent`
    - `WsTestHook`
  - Exports (values):
    - `WS_TEST_HOOK_GLOBAL`
    - `wsTestHook`
- Test helpers:
  - Web: `@plugins/primitives/plugins/networking/web/testing`
    - `createTransportHub` — Compose one server + worker registry + lock manager into a multi-tab transport.
    - `FakeLockManager` — A `navigator.locks`-shaped exclusive lock, promise-based like the real API.
    - `FakeMessagePort` — One end of an entangled `MessageChannel`. `postMessage` delivers a `structuredClone` to the other end on a REAL microtask.
    - `FakePageLifecycle` — A page's `pagehide` / `pageshow` events, fired by hand.
    - `FakeSharedWorkers` — The browser's SharedWorker registry: one REAL `createSharedWsHost` per worker name (the production worker's logic, in-process), shared by every tab; `make(name)` is the `makeSharedWorker` factory, connecting a fresh `MessageChannel` to that host like the worker's `connect` event.
    - `FakeWebSocket` — A `WebSocketLike` with no network.
    - `FakeWsServer` — A no-network WebSocket server: `connect` is the bound `makeWebSocket` factory; every socket it ever handed out is retained for introspection (`all`), and the currently-OPEN subset (`openSockets`) is derived live from `readyState` so it is the single source of truth for the one-socket invariant.
    - `renderWithTransport` — `render(ui)` under a `<TransportProvider>` — what every component reading `useTransport()` (the endpoints hooks, `useLive`) needs, since the context has no default.
    - `testTransport` — A page-shaped transport for a test: same-origin sockets (`SharedWebSocket`), the global `fetch` read at call time (so a fetch the test stubs answers), assets loaded by their own path, the computer behind it, and its telemetry reported — each overridable.
    - `transportWrapper` — A `wrapper` (`render` / `renderHook`) mounting `transport` above the tree.
    - Types: `FakeWsServerOptions`, `RenderWithTransportOptions`, `TabHandle`, `TransportHub`
- Sub-plugins:
  - **`page-transport`** — pageTransport: the page's own server as a Transport (same-origin SharedWebSocket, the global fetch, plain asset paths, machine, its telemetry reported). The app root mounts it; every other importer…

<!-- AUTOGENERATED:END -->
