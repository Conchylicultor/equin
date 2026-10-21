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
assetUrl }`. `originTransport` is the page's own server (same-origin
`SharedWebSocket`, the global `fetch`, plain asset paths) and the default of
`useTransport()`; `<TransportProvider transport>` (published from
`web/testing` until the demo scope ships its first caller) points a subtree
elsewhere — an in-browser backend (`framework/browser-server`'s
`browserServerTransport`; `research/2026-10-12-global-in-app-demo-scope.md`).
Every client that resolves its transport through `useTransport()` follows it:
live-state's `NotificationsProvider` (a scoped pipeline per transport),
endpoints' `useEndpoint` / `useEndpointMutation` / `useFetchEndpoint`, and asset
URLs (`transport.assetUrl(path)`). `socketUrl` doubles as the socket's identity
on the page-global ws-status bus, so two transports must never map one path to
the same URL. `fetchWithRetry` takes the transport's `fetch` as an option.

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
    - `TransportSocket`
    - `UrlStatus`
    - `WsStatus`
    - `WsStatusEvent`
  - Exports (values):
    - `fetchWithRetry`
    - `originTransport`
    - `probeUrlStatus`
    - `publishNetDiag`
    - `publishWsStatus`
    - `ReconnectingEventSource`
    - `SharedWebSocket`
    - `subscribeNetDiag`
    - `subscribeWsStatus`
    - `TransportProvider`
    - `useReconnectingWebSocket`
    - `useTransport`
    - `wsUrl`
- Cross-plugin:
  - Imported by:
    - `apps/events/event-list`
    - `apps/pages/page-tree`
    - `conversations/all-conversations`
    - `conversations/conversation-view/jsonl-viewer`
    - `conversations/conversations-view/data-view`
    - `conversations/conversations-view/data-view/history`
    - `framework/browser-server`
    - `framework/browser-server/demo/scope`
    - `infra/endpoints`
    - `infra/health`
    - `network/live`
    - `page/editor`
    - `page/editor-collab`
    - `primitives/live-state`
    - `primitives/log-channels`
    - `primitives/optimistic-mutation`
    - `primitives/overlay/image-viewer`
    - `shell/notifications`
    - `tasks/task-attachments`
    - `tasks/tasks-core`
- Exemptions:
  - Exempts itself from:
    - `no-raw-websocket` — `web/shared-ws.worker.ts`, `web/use-reconnecting-ws.ts` (sanctioned)
    - `no-raw-event-source` — `.` (sanctioned)
    - `endpoints/no-raw-web-fetch` — `web` (sanctioned)
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
    - Types: `FakeWsServerOptions`, `TabHandle`, `TransportHub`

<!-- AUTOGENERATED:END -->
