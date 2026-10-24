# SharedWorker-owned WebSocket (replace the cross-tab election)

## Context

`SharedWebSocket` (`plugins/primitives/plugins/networking/web/shared-websocket.ts`) shares one
server WebSocket per URL across all tabs by electing an ordinary tab as leader
(`cross-tab-election.ts`: Web Lock + BroadcastChannel, 4 s heartbeat, 12 s timeout → lock steal).
Everything awkward in that code exists because the owner is a tab:

- closing/freezing the leader tab ⇒ up to ~12 s live-data gap for every other tab;
- background-tab timer throttling can delay heartbeats ⇒ spurious steals;
- after a steal the demoted tab briefly holds a second socket (`onDemoted` patch, H6c);
- every frame is broadcast to every tab over BroadcastChannel; tests need fake locks, fake
  channels and fake timers to simulate freezes and steals.

SharedWorker is now Baseline 2026 (Chrome for Android re-enabled it in Chrome 148). A worker that
owns the socket makes "two leaders" and "no leader" inexpressible — rung 1 of the fix ladder.

**Decisions (user):**
- **Delete the election**, no fallback. A browser without `SharedWorker` gets a loud
  `UnsupportedTransportError`.
- **One worker per networking artifact version.** The worker script lives in networking's
  content-addressed web artifact, so tab and worker are always the same code; the tab↔worker
  protocol never crosses versions. During a rollout old and new tabs briefly hold two sockets
  (the server already tolerates mixed builds — `build` is per frame). A stable URL was rejected: a
  running SharedWorker cannot be upgraded in place, so it would demand a cross-version protocol and
  a retirement handshake — re-growing the coordination code this removes.

## Design

### Shape

```
tab realm                              SharedWorker (one per URL: name = singularity:shared-ws:<url>)
SharedWebSocket (thin port client) ──► WorkerHost: ports{portId → {port, will}}
  same public API: onopen/onmessage/       └── SocketOwner: real WebSocket, send queue,
  onclose/onerror/send/close/readyState         ReconnectSchedule, conn-id mint, status
  + setLastWill(data | null)
```

- **`SocketOwner`** (new, `web/socket-owner.ts`): the leader half of today's `SharedWebSocket`
  (`connectWs`, `writeOrQueue`, `teardownWs`, `scheduleReconnect`, `crypto.randomUUID()` conn per
  real open), with injected `makeWebSocket`. Reuses `reconnect-backoff.ts` unchanged.
- **Worker host** (`web/shared-ws.worker.ts`): `onconnect` → register port; fan out every server
  frame to all ports (same semantics as today — consumers filter by their subs); writes `tx` to
  the socket; opens the socket on the first attach, closes it when the last port leaves (no
  `extendedLifetime`). Exports `createWorkerHost(deps)` so tests run it in-process. Self-contained:
  imports only networking's own files.
- **`SharedWebSocket`** becomes the port client. The existing follower logic is kept exactly
  (`boundConn`: dispatch `onopen` once per server connection, reset on `close`). The default factory
  `new SharedWorker(new URL("./shared-ws.worker…", import.meta.url), { type: "module", name })`
  is evaluated lazily inside the factory (no side effects on import).

### Protocol (`web/shared-ws-protocol.ts`, `proto: 1`, mismatch ⇒ `fatal`)

| Direction | Message |
|---|---|
| tab → worker | `{kind:"attach", url, portId, proto}` · `{kind:"tx", data}` · `{kind:"will", data \| null}` · `{kind:"detach"}` |
| worker → tab | `{kind:"status", status, conn?, ports}` (on attach + every transition) · `{kind:"rx", data}` · `{kind:"diag", event}` · `{kind:"fatal", message}` |

The worker answers `attach` with one `status` (incl. `conn` when open), so a late-joining tab
dispatches `onopen` exactly once. Tab-side sends before the attach handshake are queued and flushed
after it.

### Tab lifetime

SharedWorker has no port-close event (and `MessagePort` close isn't in Safari), so:

- **Crash/kill path — Web Lock:** the tab acquires an exclusive lock `shared-ws-port:<portId>` with a
  never-resolving callback, and sends `attach` **only after the lock callback has run** (otherwise
  the worker's request is granted instantly and drops a live port). The worker
  `locks.request(name)`; the grant means the tab is gone ⇒ drop port, send its will.
- **Normal path — `pagehide`:** always `detach`, close the port and release the lock (a page
  entering bfcache must not look alive). `pageshow(persisted)` ⇒ new portId, new lock, new
  `SharedWorker` object, `boundConn = null` ⇒ the attach reply re-dispatches `onopen` ⇒ the
  consumer replays its subs.
- **Last will** (generic, per port, replace-on-set, `null` clears): the worker sends it to the
  server on `detach` and on lock release. `NotificationsClient` registers
  `{op:"unsub-tab", tabId}` as its will and **drops its own pagehide `unsub-tab` send** — one path,
  which now also covers crashed tabs (today their subs linger until the socket closes).
- A frozen-but-alive tab keeps its port; the browser buffers its messages. No leader is lost, so
  no takeover is needed.

### Diagnostics

- `ws-status-bus`: each tab publishes the status received from the worker (consumers unchanged).
- `net-diag-bus`: the worker sends `diag` events and every tab republishes them for its own trace
  log. The election events (`elected`, `demoted`, `steal-attempt`, `leader-timeout`,
  `follower-joined`) are deleted. New events: `port-attached` and `port-released` (with the reason:
  detach or lock).
- `isLeader` / `hasLeader` are removed. `LeaderRow` in
  `plugins/debug/plugins/live-state-health/web/components/live-state-health.tsx` becomes a
  **Transport row**: status, short conn id, port count (a growing count exposes leaked tabs).

### Build: worker entry in web-artifacts

`web-artifacts` (`core/internal/vite-builder.ts`) builds each plugin in lib mode with externals; it
has no worker support, and Vite's own worker pipeline would bypass our externals and inline audit,
and may emit an absolute `/assets/…` URL.

- **Step 0 is a spike.** Build a trivial SharedWorker both ways and inspect the output directory
  and the URL emitted in `index.js`:
  - (a) Vite's built-in worker plugin with `worker.format: "es"` and `base: "./"`;
  - (b) a first-class worker entry.
- **Expected outcome, (b):** a `web/*.worker.ts` file becomes a second `viteBuild` into the same
  artifact directory, emitted as `<name>.worker.js`, bundled with nothing external.
  - Record it as `workers: string[]` in `ArtifactMeta` (`store.ts`).
  - Leave it out of the import map and preloads (`pipeline.ts` / `compose.ts`).
  - Pruning works on whole directories, so the worker is kept with its artifact.
- **Build-time assertions:**
  - the worker bundle has zero imports and no `@plugins/` specifiers;
  - the URL the tab references resolves to a recorded worker.
  - These turn "you must keep the filename in sync" into a build failure.

## Files

- **Create (networking/web):** `socket-owner.ts`, `shared-ws.worker.ts`, `shared-ws-protocol.ts`,
  `testing/fake-shared-worker.ts`
- **Modify (networking):**
  - `shared-websocket.ts` (port client; `makeSharedWorker` + `locks` seams; `setLastWill`)
  - `transport-types.ts` (drop BroadcastChannel types; add `SharedWorkerLike`, `MessagePortLike`)
  - `index.ts`
  - `testing/transport-fakes.ts`: rewrite `createTransportHub` on the fake worker, keeping its
    surface. Tab `kill()` releases the fake lock.
  - `exempt/index.ts` (`no-raw-websocket` for `socket-owner.ts` and the worker)
  - `CLAUDE.md`
  - `e2e/shared-websocket.ts`
- **Modify (consumers):**
  - `live-state/web/notifications-client.ts`: register the will, drop the pagehide `unsub-tab`,
    drop the `isLeader` / `hasLeader` reads (~838).
  - `live-state-health.tsx` (Transport row)
- **Modify (build):** `web-artifacts` `vite-builder.ts`, `store.ts`, `pipeline.ts` and their tests
- **Delete:**
  - `cross-tab-election.ts` and `__tests__/cross-tab-election.test.ts`
  - the BroadcastChannel and lock-steal fakes
  - election-specific cases in `live-state/web/__tests__/notifications-{cross-tab,heartbeat}.test.ts`
    (port the transport-agnostic ones onto the new hub)

## Order

1. Build spike: pick (a) or (b).
2. Protocol and `SocketOwner`, with unit tests.
3. Worker host and fake worker.
4. The `SharedWebSocket` client and the hub rewrite.
5. Port tests, then delete the election.
6. Consumer changes and the Transport row.
7. web-artifacts worker entry, metadata and assertions.
8. Docs, exemptions, lint.
9. Build, e2e, and a manual check in each browser.

## Risks

- **Module SharedWorker support:** Safari 16+ and Firefox 114+. Before 148, Chrome for Android
  throws `UnsupportedTransportError`; the error message says so.
- **Worker script load failure** (e.g. a stale tab after store pruning): `worker.onerror` ⇒ status
  `error`, a `diag` event, and a loud failure. No silent degrade.
- **`navigator.locks` in SharedWorkerGlobalScope:** confirm in the spike on all three engines.
- **Debugging:** worker logs live in `chrome://inspect/#workers`, so everything worth seeing is also
  sent to the tabs as `diag`.

## Verification

- `./equin check` (type-check, eslint, boundaries, `plugins-doc-in-sync`).
- `./equin test plugins/primitives/plugins/networking plugins/primitives/plugins/live-state plugins/framework/plugins/tooling/plugins/web-artifacts`
  - **Socket ownership:**
    - one real socket across N tabs;
    - the socket closes when the last port leaves.
  - **`onopen` dispatch:**
    - once per conn per tab;
    - a late attach dispatches once;
    - a reconnect re-dispatches;
    - a bfcache detach/re-attach re-dispatches once.
  - **Backoff:** checked under fake timers.
  - **Tab death and the last will:**
    - killing a tab keeps the others connected with no reconnect;
    - the will fires on kill and on detach;
    - `null` clears it;
    - a tab dying before attach is ignored.
  - **Protocol:** a `proto` mismatch is fatal.
  - **Worker build:** zero imports and a relative URL.
- `./equin build`. Check that the networking artifact directory contains `*.worker.js`.
- E2E: `./equin run plugins/primitives/plugins/networking/e2e/shared-websocket.ts`, extended
  to cover:
  - two tabs on one server connection per URL;
  - `page.close()` on the first tab, after which the second receives an update within 1 s (today up
    to 12 s);
  - the closed tab's subs are released on the server.
- Manual check in Chrome, Firefox and Safari: the Live-state health Transport row shows the port
  count going up and down as tabs open and close.

## Outcome (2026-10-09)

What shipped, where it differs from the plan above:

- **Build — option (a), not (b).** Vite's own worker pass works in lib mode with
  `worker.format: "es"` and `base: "./"` (the default base emitted an
  origin-absolute `/assets/…` URL). The worker lands in
  `assets/<name>-<hash>.js` inside the artifact dir. Hardening in
  `vite-builder.ts`: the inline audit also runs on the worker build
  (`worker.plugins`), and `assertWorkersSelfContained` fails on any import left
  in a worker chunk. No `ArtifactMeta.workers` field was needed:
  `parseEmittedImports` reads the top level only, so worker chunks never join
  the import map or the preloads, and `scanStagedModules` still re-lexes them.
- **The worker bundles only networking's own files** (import maps don't reach
  workers, and the address hashes one plugin), so `reconnect-backoff.ts` spells
  out its delay rather than importing `packages/retry`.
- **e2e observability.** Playwright sees nothing of a SharedWorker's socket.
  `page.on("websocket")` and `context.routeWebSocket` both came back empty in a
  probe. A tab-side test hook replaces them. `networking/core/ws-test-hook.ts`
  defines the page global and the event/control types. Each `SharedWebSocket`
  reports status/rx/tx to that global and registers `drop` / `hold` / `release`,
  only when an init script installed it. The worker honours `test-fault`
  messages and `attach.holdConnects`. The harness half is `tapSharedSocket` in
  `@plugins/primitives/plugins/networking/e2e`. Seven e2e scripts migrated.
- **Network idle.** Playwright's `networkidle` never fires anymore: it sees the
  worker's script load as a page request that never finishes. The harness now
  measures idle itself (`e2e-harness/e2e/network-idle.ts`, used by `boot()`),
  leaving out worker-chunk loads (`isWorkerChunkPath`, web-artifacts
  `constants.ts`). The `e2e-harness/no-networkidle` lint rule bans the literal
  in e2e scripts.
- **jsdom.** `test/setup.ts` installs an inert `SharedWorker` and
  `navigator.locks`, so suites mounting the provider construct the client.
- **Async tests.** Hub-based live-state tests now `await flush()` after socket
  actions, because port delivery is async, as it is in a real browser.
