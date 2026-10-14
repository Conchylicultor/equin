# Browser-server host — in-app demo Phase 1a + 1b

> Implements §1a + §1b of [`2026-10-13-global-in-app-demo-scope-v2.md`](./2026-10-13-global-in-app-demo-scope-v2.md).
> Track: **Demos and client server** (wiki `block-3e397e42-8412-4895-b854-e620a1b4f789`).

## Context

Server code runs only inside the Bun server-core. The resource runtime imports `node:crypto`,
the `bun` `ServerWebSocket` type and `Bun.hash`. The HTTP router (route table, matcher,
`safeHandle`, `/api/resources/:key`) is inlined in `server-core/bin/index.ts`. So nothing can host
the real runtime and router in a page, and the demo scope has nothing to mount.

**Outcome:** `createBrowserServer` (core) + `browserServerTransport` (web) run the **real**
`createResourceRuntime` and the **same** router as Bun, behind a `Transport`. Existing
runtime/server-core suites pass unchanged, and a new test drives the real `NotificationsClient`
against it.

## Findings that change the v2 design

1. **`defineResource` does NOT accept window/point descriptors directly.** A keyed
   `defineResource` requires a `ScopePolicy`: a `RoutePlan` minted by `mintRoutePlan` (minting is
   lint-restricted to query compilers, `resource-runtime:compiled-routes`) plus a membership. It
   throws without them (`runtime.ts:2980`, `:3210`). `windowQueryResource` / `serveCollection`
   are that compile step, and they are DB-bound.
   **What works with no DB is the runtime's EXTERNAL arm** (`defineExternalResource`, D31):
   - **Window descriptor:** `defineExternalResource(descriptor, { loader, membership: { kind: "window", limitOf } })`.
     This gives real keyed membership. Its ids come from the loader, and `notify(params)` re-reads
     the tuple and sends keyed deltas.
   - **Point descriptor (`:rows`):** the external keyed arm refuses a point (`runtime.ts:3200`).
     It is served instead as a flat external `{ key, schema, mode: "push", loader }`. The client
     keeps its own `keyOf` from the descriptor, and push delivers full values, which the client
     replaces whole. That is correct, just not delta-efficient, and Phase 1 has no notifies.
   - **Value / non-keyed descriptor:** a flat external push resource.
   So the browser server registers **everything through `defineExternalResource`**: its data is
   by definition not in this host's Postgres. `server.notify(key, params)` is the returned
   `ExternalResource.notify`.
2. **The router cannot live in `server-core/core`.** That barrel is server-bound: `resources.ts`
   creates the runtime at module eval, with the profiler hooks, read-set, error reporter and
   boot holders. Importing it from `browser-server/core` would drag all of that into the page.
   The router therefore becomes its own pure leaf plugin, **`framework/plugins/http-router/core`**.
   Both hosts import it, and it has one implementation.
3. **Three more host-only touches** beyond what v2 listed:
   - `Bun.hash.wyhash` in `keyed-diff.ts:56` (`hashSnapEncoder`);
   - `process.env.SINGULARITY_PROFILING` in `runtime-profiler/core/recorder.ts:1061,1303`
     (reached by `implement()`). A real browser has no `process`, though jsdom does;
   - a client bug: `NotificationsClient.getChannelStatuses()` (`notifications-client.ts:758`) reads
     `channelStatuses.get(WS_URLS.worktree)`, the origin URL, instead of `this.socketUrls[kind]`.
     Under a scoped transport it always says "connecting".
4. **No `HttpRoutes` type exists.** The real shape is `Record<string, HttpHandler>`
   (`server-core/core/types.ts:13,63`), and `implement()` returns a bare `HttpHandler`.
5. **No descriptor enumeration** exists in `live-state/core` (the `byKey` map is private,
   `resource.ts:126`).

## Design

### 1a. Host-agnostic server code

**New leaf `packages/plugins/string-hash/core`.** It holds portable, synchronous JS hashes:
- `hash53(str, seed?)`: the cyrb53 moved out of `resource-protocol/core/internal/frames.ts`,
  which then imports it;
- `hashHex(str)`: two-seed cyrb53, 106 bits, hex;
- `hash64(str): bigint`.

**`framework/plugins/resource-runtime/core`:**
- `node:crypto` is gone:
  - `bootEpoch = globalThis.crypto.randomUUID()`;
  - `normalizeEtag` uses `hashHex`. ETags change value once on deploy, so a client's held ETag
    misses once and refetches. That self-heals; the token is opaque.
- `import type { ServerWebSocket } from "bun"` → a structural
  `export interface RuntimeSocket { send(data: string): void }`:
  - the runtime only ever calls `ws.send` (`:3762`, `:3788`) and uses `ws` as a Map key;
  - `WsHandler.message(ws, msg: string | { toString(): string })`;
  - Bun's socket satisfies it, so `server-core`'s `wsRoutes` assignment still typechecks
    (parameter contravariance).
- `keyed-diff.ts`: the snap hash becomes a runtime option `ResourceRuntimeOptions.snapHash?: (json) => bigint`,
  defaulting to `hash64`:
  - `server-core/core/resources.ts` and central pass `Bun.hash.wyhash`, so the server hot path is
    unchanged;
  - the exported `hashSnapEncoder` name keeps working for tests (the portable default).
- Comments saying "acyclic besides `bun`" are updated.

**`infra/plugins/runtime-profiler/core/recorder.ts`:** `profilingDisabled()` reads
`globalThis.process?.env?.SINGULARITY_PROFILING === "0"`. This is the one host probe, kept in one
function.

**New leaf `framework/plugins/http-router/core`.** The code moves out of `bin/index.ts`:
`pathSegments`, `registerHttpRoute`, `matchSegments`, `withDefaultCacheControl` and `safeHandle`.

```ts
export type RouteHandler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;
export function createRequestHandler(opts: {
  routes: Iterable<[key: string, handler: RouteHandler]>;   // "METHOD /path/:p"
  onError: (err: Error, req: Request, pathname: string) => void;  // Bun: console.error + reportServerError
  onUnmatched?: (req: Request, pathname: string) => Response;     // default 404 "Not found"
}): (req: Request) => Promise<Response>;
```

- **Duplicate route keys throw** at construction. Today the literal map silently overwrites
  ("fail loudly").
- The resource read route key, `RESOURCE_HTTP_ROUTE = "GET /api/resources/:key"`, is exported from
  `resource-protocol/core`, next to the error-body contract the client already reads there. Both
  hosts mount `[RESOURCE_HTTP_ROUTE, runtime.handleResourceHttp]`.
- **`server-core/bin/index.ts`:**
  - `populateRoutes` collects `[key, handler]` pairs plus the resource route, then calls
    `createRequestHandler`;
  - `Bun.serve.fetch` keeps the WS-upgrade branch and otherwise delegates;
  - `wsRoutes` stays in bin (Bun-specific upgrade).
- `server-core/core/types.ts`'s `HttpHandler` stays as declared. It is structurally identical to
  `RouteHandler`, the same pattern the runtime already uses for `WsHandler`, and it avoids a
  cross-plugin re-export.

### 1b. `framework/plugins/browser-server` (new)

It knows nothing about demos.

**`core/`** (no DOM, no React; it runs in a page or a worker):

```ts
export type ServedResource =
  | { kind: "window"; descriptor: KeyedResourceContract; loader; limitOf }   // external window arm
  | { kind: "tuple"; descriptor: ResourceContract | KeyedResourceContract; loader }; // flat push (values, points)

export function createBrowserServer(opts: {
  resources: ServedResource[];
  routes: Iterable<[string, RouteHandler]>;          // e.g. [[ep.route, implement(ep, h)]]
  unserved: (key: string) => Error;                   // loader for every known-but-unserved descriptor
  knownDescriptors: () => Iterable<ResourceDescriptor>; // + onRegistered for late (lazy) ones
  onUnmatched?: (req, pathname) => Response;          // default: /api/* → 409 {reason:"unsupported"}, else 404 naming it
}): BrowserServer;

interface BrowserServer {
  readonly id: string;                                // crypto.randomUUID()
  request(req: Request): Promise<Response>;           // createRequestHandler(...)
  connect(peer: { deliver(frame: string): void }): ServerSocketEnd; // runtime.notificationsWsHandler.open; send→message; close→close
  notify(key: string, params?: ResourceParams): void; // ExternalResource.notify
  dispose(): void;                                    // close every socket (stops heartbeats)
}
```

**Unserved keys fail as `loader-failed`, never as skew.**
- At creation, every known descriptor without a `ServedResource` gets a flat external resource
  whose loader throws `unserved(key)`.
- The client then sees `sub-error loader-failed` → HTTP 500 `loader-failed` → `ResourceHttpError`.
  `noteContractRefusal` ignores `loader-failed`, so the page-global contract-mismatch store is
  never touched.
- **Late descriptors** (lazy plugins) are handled by a new `live-state/core` export,
  `onResourceDescriptorRegistered(fn)`, plus `allResourceDescriptors()`. Each late descriptor is
  defined on the live runtime as it arrives.
- **Verify first:** a post-boot `defineExternalResource` on a runtime with open sockets works.
  If it does not, route late keys through `defineDeferredResource` / `bindDeferredResources`.

`/api/central-resources/*` and `/ws/central-notifications` are out of scope. The central channel
opens lazily, only on a central-origin observe. A central request reaches `onUnmatched` (409),
and a central socket is an inert socket that publishes "closed".

**`web/`:** `browserServerTransport(server): Transport`, created once per server (the scoped
pipeline is keyed by Transport identity):
- `socketUrl(p)` → `browser:${server.id}:${p}`.
- `openSocket(url)`:
  - for the worktree path, it returns a `TransportSocket` over `server.connect(...)`;
  - in a microtask it publishes `publishWsStatus({ url, status: "open" })` and fires `onopen`;
  - `send` → `end.send` → `runtime.message`;
  - `close()` publishes "closed" and closes the end. It also runs the stored last-will frame
    first, the way the real socket's server side does on disconnect.
  - Frames are delivered to `onmessage` asynchronously (`queueMicrotask`), so a server reply
    never re-enters the client's `send` call.
- `fetch(input, init)` → `server.request(new Request(new URL(input, "http://browser-server.invalid"), init))`.
- `assetUrl(p)` → `browser:${server.id}:${p}` (unloadable; no asset is needed on the target route).

**Fix** `NotificationsClient.getChannelStatuses()` to read through `this.socketUrls[kind]`.

### Files

- **New:**
  - `packages/plugins/string-hash/{core/index.ts, package.json}`
  - `framework/plugins/http-router/core/{index.ts, router.ts, router.test.ts}`
  - `framework/plugins/browser-server/{core/index.ts, core/browser-server.ts, web/index.ts, web/transport.ts, web/__tests__/browser-server.test.ts}`, each with a `CLAUDE.md`
- **Edited:**
  - `resource-runtime/core/{runtime.ts, keyed-diff.ts, index.ts}`
  - `server-core/bin/index.ts`
  - `server-core/core/resources.ts` (pass `snapHash`)
  - central's runtime construction (pass `snapHash`)
  - `resource-protocol/core` (`RESOURCE_HTTP_ROUTE`, import `hash53`)
  - `runtime-profiler/core/recorder.ts`
  - `live-state/core/resource.ts` + barrel (enumerate / onRegistered)
  - `live-state/web/notifications-client.ts` (status fix)
  - `networking/web/index.ts`: publish `TransportProvider`, which the demo scope needs next. Only
    if the browser-server test needs it; otherwise leave it to Phase 1 demo-scope.

## Verification

1. `./singularity test plugins/framework/plugins/resource-runtime plugins/framework/plugins/server-core plugins/packages/plugins/resource-protocol plugins/primitives/plugins/live-state`:
   unchanged suites pass.
2. `./singularity test plugins/framework/plugins/http-router`: literal and param match, method
   filter, `decodeURIComponent`, default `no-store`, 500 plus `onError` on a throw, duplicate-key
   throw, `onUnmatched`.
3. `./singularity test plugins/framework/plugins/browser-server`: the jsdom test runs the real
   `NotificationsClient` (via `TransportProvider` + `NotificationsProvider`, or directly with
   `makeSocket` / `socketUrl` / `fetchImpl` from the transport) against `createBrowserServer`:
   - **subscribe:** a `liveValue` and a `liveCollection` window resolve to the loader's data,
     and the status bus reports "open";
   - **replay:** close and reopen the socket. One `sub-batch` re-subscribes, and the values
     stay or come back `up-to-date`;
   - **unserved:** a known descriptor with no resource gives `loader-failed` with the
     `unserved` message, and `useResourceContractMismatches()` stays empty;
   - **route:** `implement(endpoint, h)` mounted in `routes` answers via `transport.fetch`, with
     the args parsed by the endpoint's schema;
   - **unmatched:** an unmatched `POST /api/x` gives 409 `{reason:"unsupported"}`, and a
     non-`/api` path gives a 404 naming it;
   - **notify:** after `server.notify` on the window, a keyed delta lands (Phase 1 does not need
     it, but it proves the arm).
4. `./singularity build` (the Bun server runs the extracted router) and smoke the app at
   `http://<worktree>.localhost:9000`. `./singularity check` is green, including
   `resource-runtime:compiled-routes`, boundaries and plugin docs.

## Wrap-up

- Update the track card (`block-d04c6c0d-…`): tick the Browser-server sub-task and update
  Status. Note the external-arm finding: window via the external window arm, point via flat push.
- File the next main task, "Phase 1: demo data on top of browser-server (DemoScope, pack,
  contributed answers)". Its context gets the page id and the track-instructions id.
