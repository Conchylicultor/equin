# Browser-server host v2: one serving code path for every host (in-app demo Phase 1a + 1b)

> Supersedes [`2026-10-13-framework-browser-server-host.md`](./2026-10-13-framework-browser-server-host.md).
> v1 registered raw descriptors through `defineExternalResource`, the low-level spelling the
> Resources track bans in plugin code.
> Parent design: [`2026-10-13-global-in-app-demo-scope-v2.md`](./2026-10-13-global-in-app-demo-scope-v2.md) §1.
> Tracks:
> - **Demos and client server** (`block-3e397e42-…`)
> - **Resources** (`block-f64cfc08-…`): its unified API (`liveValue` / `liveCollection` →
>   `serveValue` / `serveCollection` → `useLive`) is what this host serves.

## Context

Server code runs only inside the Bun server-core:
- the resource runtime imports `node:crypto`, the `bun` socket type and `Bun.hash`;
- the HTTP router is inlined in `server-core/bin/index.ts`.

So nothing can host the real runtime in a page, and the demo scope has nothing to mount.

**Principle:** the browser server is a **third host of the unified live API**, beside the Bun
server and central. It is not a second way to register resources.
- Declarations, the client, the wire protocol, serving and routing are one code path.
- A host contributes only:
  - its runtime instance and options;
  - its socket and request entry point;
  - its error sink;
  - how it finds what it serves.

**Done when:**
- `createBrowserServer` and `browserServerTransport` exist;
- all three hosts serve through one `serveValueOn` (central's duplicate wrapper is removed);
- external collections can be served on any host;
- the Bun server uses the extracted router;
- the existing runtime, server-core, network/live and central suites pass unchanged;
- a test drives the real `NotificationsClient` against the browser server.

## Findings (verified in code)

1. **`defineResource` does not take window or point descriptors directly.**
   - A keyed entry needs a `RoutePlan` minted by `mintRoutePlan` (lint-restricted to the query
     compilers) plus a membership (`runtime.ts:2980,3210`).
   - Only the external arm needs no DB (`defineExternalResource`, D31). It is window-only today:
     a point is refused (`runtime.ts:3200`).
   - Both stay **substrate**. `serveValue` / `serveCollection` compile to them, and only network/live
     calls them (`live/no-legacy-resource-spelling`).
2. **Value serving is already host-parametric, but duplicated per host.**
   - `network/live/shared/compile-value.ts`'s `registerValueOf` / `registerPagedOf` take a
     `ValueRuntime` (the `defineResource` + `defineExternalResource` pair).
   - `server/internal/serve-value.ts` and `central/internal/serve-value.ts` each wrap them with
     the same post-processing: building the served object, `notify` (by params or by question),
     paged meta. Central differs only in being external-only and having no `declare`.
3. **`serveCollection` is SQL-only.** Its docs say "hand-written loaders are out of scope for
   now". No unified spelling serves a collection from outside Postgres.
4. **More host-only touches:**
   - `Bun.hash.wyhash` (`keyed-diff.ts:56`);
   - `process.env` in `runtime-profiler/core/recorder.ts:1061,1303`, which `implement()` reaches;
   - `server-core/core` creates its runtime at module evaluation, so the router cannot live in
     that barrel.
5. **Client bug.** `NotificationsClient.getChannelStatuses()` (`notifications-client.ts:758`)
   reads the origin URL instead of `this.socketUrls[kind]`. Under a scoped transport it always
   says "connecting".
6. **No `HttpRoutes` type exists.** The real one is `Record<string, HttpHandler>`, and
   `implement()` returns a bare handler.
7. **`live-state/core` cannot enumerate descriptors.** Its `byKey` map is private.

## What is shared and what is per host

| Layer | Shared (one code path) | Per host |
|---|---|---|
| Declarations (`liveValue`, `liveCollection`, `defineEndpoint`) | all | none |
| Client (`useLive`, `NotificationsClient`) | all | none (the `Transport` hides the host) |
| Wire protocol | `createResourceRuntime` | runtime options (profiler, read-set, L2, `snapHash`, build graph) |
| Serving values | **`serveValueOn(rt, v, opts)`** | which runtime; Bun adds the `declare` contribution; central and browser are external-only |
| Serving collections | **`serveCollectionOn(rt, c, { source: "external", … })`** (new) | the DB arm (SQL) stays Bun-only until PGlite |
| HTTP routing | `http-router/core` | entry: `Bun.serve` vs `transport.fetch` |
| Endpoints | `implement()` | which handlers are mounted |
| Sockets | runtime `open` / `message` / `close` | Bun WebSocket vs in-memory pair |
| Error reporting | `onError` hook | `reportServerError` vs console |
| What is served | none | Bun: plugin boot graph. Browser: the `serve` list plus the `unserved` fallback |

## Design

### A. Host-agnostic runtime (`framework/plugins/resource-runtime/core`)

**New leaf `packages/plugins/string-hash/core`:**
- `hash53(str, seed?)`: cyrb53, moved out of `resource-protocol/core/internal/frames.ts`, which
  then imports it;
- `hashHex(str)`: 2 × cyrb53, 106 bits, as hex;
- `hash64(str): bigint`.

**Changes in the runtime:**
- `bootEpoch = globalThis.crypto.randomUUID()`.
- `normalizeEtag` uses `hashHex`. ETags change value once on deploy: a held ETag misses once
  and refetches, which self-heals.
- `import type { ServerWebSocket } from "bun"` → `export interface RuntimeSocket { send(data: string): void }`.
  - Only `send` is called, and the socket is used as a Map key.
  - `message(ws, msg: string | { toString(): string })`.
  - Bun's socket still satisfies it structurally.
- `ResourceRuntimeOptions.snapHash?: (json: string) => bigint`, defaulting to `hash64`.
  - server-core and central pass `Bun.hash.wyhash`, so the server hot path is unchanged.
  - `hashSnapEncoder` keeps its exported name (the portable default) for the existing tests.
- **The external keyed arm accepts a point set:** `membership: { kind: "point" }`.
  - Its ids come from the tuple's params through the point codec.
  - `notify(params)` re-reads the tuple and ships a keyed delta, exactly as the external window
    does.
  - Lifts the refusal at `:3200` for `point` only; aliases and `windowIdsOf` stay refused.
  - New runtime test: an external point tuple subscribes, notifies, and ships a delta.

**`infra/plugins/runtime-profiler/core/recorder.ts`:** one `profilingDisabled()` reading
`globalThis.process?.env?.SINGULARITY_PROFILING === "0"`.

### B. One serving code path (`network/live`)

**Move to `core/`** (it imports only core barrels, so it is browser-safe):
- `shared/compile-value.ts` → `core/internal/compile-value.ts`;
- `shared/key-order.ts` → `core/internal/key-order.ts`.

The server and central barrels re-export `sliceRange` from their own core. A re-export of an
own file is allowed.

**`LiveRuntime`** is the `ValueRuntime` plus `defineDeferredResource`. It is the host-facing
subset of `ResourceRuntime`, and each host passes its instance.

**`serveValueOn(rt, value, opts, { sources })`** (core):
- It is the body that is duplicated today: register, build the served object, the `notify`
  variants, paged meta.
- `sources: "db+external" | "external"` sets the host's allowed arms.
  - The types narrow `opts.source`, and a runtime throw guards against a cast.
  - This replaces central's hand-written "central has no change feed" throw.

The host wrappers then become thin:

```ts
// server/:  (v, o) => withDeclare(serveValueOn(serverRuntime, v, o, { sources: "db+external" }))
// central/: (v, o) => serveValueOn(centralRuntime, v, o, { sources: "external" })
// browser:  s.serveValue = (v, o) => serveValueOn(browserRuntime, v, o, { sources: "external" })
```

- `central/internal/serve-value.ts` shrinks to the wrapper plus its types.
- `server/internal/serve-value.ts` keeps `preloadParams` (Bun boot snapshot) and `declare`.
- Public `serveValue` signatures and the overload types are unchanged, so call sites do not
  change.

**External collections, `serveCollectionOn(rt, c, { source: "external", changes, … })`** (core):
- **A window collection.** It takes:
  - `window(q)`: `q` is the decoded `{ limit, where?, orderBy, after?, until? }`, and the
    loader returns rows;
  - `rows(ids)`;
  - `groups?(q)`;
  - `count?(q)`, only when the collection is declared `count: true`.
- **An `all` collection** takes `all()` and `rows(ids)`.
- **A lookup-only collection** takes `rows(ids)`.

What each one compiles to (all through `rt.defineExternalResource`):
- the window becomes the external keyed window, with `limitOf` and `familyOf` from the
  collection's codec;
- `:rows` becomes the external point (A);
- `all`, `:groups` and `:count` become plain external push values.

How answers are checked and changes signalled:
- Every answer is checked against the row schema.
- A scroll window's rows get `$key` minted (reusing `pageRowsOf` / `compareRowKeys`).
- `changes` works as it does for values:
  - `"notified"` returns `notify(query?)`, which re-reads the matching tuples;
  - `{ immutable | fixed }` returns no `notify`.

The Bun `serveCollection` gains a `source: "external"` overload that delegates to it, with
`declare`. The DB arm is untouched. Docs go in network/live's `CLAUDE.md` (*Serve*). The
"hand-written loaders are out of scope" line is replaced.

### C. Shared router (`framework/plugins/http-router/core`, new leaf)

The code moves out of `bin/index.ts`: `pathSegments`, `registerHttpRoute`, `matchSegments`,
`withDefaultCacheControl` and `safeHandle`.

```ts
export type RouteHandler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;
export function createRequestHandler(opts: {
  routes: Iterable<[key: string, handler: RouteHandler]>;      // "METHOD /path/:p"; a duplicate key throws
  onError: (err: Error, req: Request, pathname: string) => void;
  onUnmatched?: (req: Request, pathname: string) => Response;  // default 404 "Not found"
}): (req: Request) => Promise<Response>;
```

- `RESOURCE_HTTP_ROUTE = "GET /api/resources/:key"` is exported from `resource-protocol/core`.
  Both hosts mount `[RESOURCE_HTTP_ROUTE, runtime.handleResourceHttp]`.
- `bin/index.ts` changes:
  - `populateRoutes` collects pairs and calls `createRequestHandler`;
  - the `fetch` handler keeps only the WebSocket upgrade branch and delegates the rest;
  - `onError` does `console.error` plus `reportServerError`.
- server-core's `HttpHandler` stays declared, structurally identical (no cross-plugin
  re-export).

### D. `framework/plugins/browser-server` (new)

It knows nothing about demos.

**`core/`** has no DOM and no React, and runs in a page or a worker:

```ts
const server = createBrowserServer({
  serve: (s: BrowserServe) => Served[],        // s.serveValue / s.serveCollection = serveValueOn / serveCollectionOn on this runtime
  routes?: Iterable<[string, RouteHandler]>,   // e.g. [[ep.route, implement(ep, h)]]
  unserved: (key: string) => Error,            // the loader of every known descriptor nothing served
  onError?: (err, req, pathname) => void,      // default console.error
  onUnmatched?: (req, pathname) => Response,   // default: /api/* → 409 { reason: "unsupported" }; else 404 naming the path
});
server.id;                    // crypto.randomUUID()
server.request(req);          // the shared router
server.connect(peer);         // in-memory socket end → runtime.notificationsWsHandler
server.dispose();             // closes sockets (stops heartbeats)
```

- **The runtime** is `createResourceRuntime({})`. The default portable `snapHash` applies, and
  everything else is off: no read-set, L2 or profiler.
- **Unserved keys fail as `loader-failed`, never as version skew.**
  - Every descriptor `live-state/core` knows, from the new exports `allResourceDescriptors()`
    and `onResourceDescriptorRegistered(fn)`, that nothing served gets an external resource
    whose loader throws `unserved(key)`.
  - The client sees `loader-failed`, which `noteContractRefusal` ignores, so the page-global
    contract-mismatch store is never touched.
  - **Late (lazy) descriptors** are registered as they arrive. Check first that a post-boot
    `defineExternalResource` with open sockets works; otherwise use
    `defineDeferredResource` / `bindDeferredResources`.
- **The central channel is out of scope.** A `/api/central-resources/*` request goes to
  `onUnmatched`. The central socket is inert and publishes "closed".

**`web/`: `browserServerTransport(server): Transport`.** Make one per server, because the
scoped pipeline is keyed by Transport identity.
- `socketUrl(p)` → `browser:${server.id}:${p}`.
- `openSocket(url)` → a `TransportSocket` over `server.connect`:
  - `onopen` fires in a microtask, after `publishWsStatus({ url, status: "open" })`;
  - `send` → runtime `message`;
  - frames are delivered to `onmessage` via `queueMicrotask`, so a reply never re-enters `send`;
  - `close()` sends the stored last-will frame, closes the end and publishes "closed".
- `fetch(input, init)` → `server.request(new Request(new URL(input, "http://browser-server.invalid"), init))`.
- `assetUrl(p)` → `browser:${server.id}:${p}`. It is unloadable, and the target route needs no
  asset.

**Client fix:** `getChannelStatuses()` reads through `this.socketUrls[kind]`.
`networking/web/index.ts` publishes `TransportProvider`, which the demo scope and the test use.

## Example (what the next phase writes)

```ts
const server = createBrowserServer({
  serve: (s) => [
    s.serveValue(jsonlEvents, { source: "external", changes: { fixed: { reason: "demo pack" } },
      loader: ({ id }) => pack.transcript(id) }),
    s.serveCollection(conversationsActive, { source: "external", changes: { fixed: { reason: "demo pack" } },
      all: () => pack.conversations, rows: (ids) => pack.conversationsById(ids) }),
  ],
  routes: [[markViewed.route, implement(markViewed, () => undefined)]],
  unserved: (key) => new Error(`not in the demo pack: ${key}`),
});
<TransportProvider transport={browserServerTransport(server)}>…unchanged app…</TransportProvider>
```

## Files

- **New:**
  - `packages/plugins/string-hash/`
  - `framework/plugins/http-router/` (core plus tests)
  - `framework/plugins/browser-server/` (core, web, `web/__tests__`)
  - `network/plugins/live/core/internal/serve-on.ts` (`serveValueOn`, `serveCollectionOn`, `LiveRuntime`)
  - a `CLAUDE.md` for each new plugin
- **Moved:** `network/live/shared/{compile-value,key-order}.ts` and their tests → `core/internal/`.
- **Edited:**
  - `resource-runtime/core/{runtime.ts, keyed-diff.ts, index.ts}` (plus the external-point test)
  - `server-core/bin/index.ts`, and `server-core/core/resources.ts` (`snapHash`)
  - `central-core/core/resources.ts` (`snapHash`)
  - `network/live/{server,central}/internal/serve-value.ts` (thin wrappers)
  - `network/live/server/internal/serve-collection.ts` (external overload)
  - `network/live/CLAUDE.md`
  - `resource-protocol/core` (`RESOURCE_HTTP_ROUTE`, `hash53` import)
  - `runtime-profiler/core/recorder.ts`
  - `live-state/core/resource.ts` (enumerate, onRegistered)
  - `live-state/web/notifications-client.ts`
  - `networking/web/index.ts`

## Verification

1. **Unchanged suites pass:**
   `./singularity test plugins/framework/plugins/resource-runtime plugins/framework/plugins/server-core plugins/framework/plugins/central-core plugins/network/plugins/live plugins/packages/plugins/resource-protocol plugins/primitives/plugins/live-state`
   - `compile-value.test.ts` and `serve-paged-value-oracle.test.ts` pass unchanged after the move
     (only their import paths change).
2. **New unit tests:**
   - `http-router`: match, method filter, decoding, `no-store`, 500 plus `onError`,
     duplicate-key throw, `onUnmatched`.
   - The runtime's external point.
   - `serveCollectionOn` on a test runtime, for a window, `all`, lookup-only and scroll `$key`:
     a `notify` produces a keyed delta, a schema violation throws, and the silent arms have no
     `notify`.
3. **`browser-server/web/__tests__` (jsdom).** The real `NotificationsClient` runs through
   `TransportProvider` + `NotificationsProvider` against `createBrowserServer`:
   - **subscribe:** a value and an external collection (window and `:rows`) resolve, and the
     status reads "open";
   - **replay:** a reopened socket sends one `sub-batch`, and the values stay correct;
   - **unserved:** an unserved known descriptor gives `loader-failed` with the message, and the
     contract-mismatch store stays empty;
   - **routes:** an `implement()` route answers through `transport.fetch`, with args parsed by
     its schema;
   - **unmatched:** `POST /api/x` → 409 `{ reason: "unsupported" }`, and a non-API path → 404;
   - **notify:** `notify` on a `"notified"` external collection lands a keyed delta in the
     client cache.
4. **Build and checks.** Run `./singularity build`, then smoke `http://<worktree>.localhost:9000`
   (the Bun server on the shared router, and central values still live). `./singularity check`
   must be green: boundaries, plugin docs, `resource-runtime:compiled-routes`,
   `live/no-legacy-resource-spelling` (no new exemption), and type-check.

## Wrap-up

- **Update the Demos track card.** Tick the Browser-server sub-task and update Status: the
  browser server is a third host of the unified API, and external collections exist.
- **Note on the Resources track card** (an agent-inline card): the shared `serveValueOn` /
  `serveCollectionOn`, and the external collection arm.
- **File the next main task:** Phase 1 demo data (DemoScope, the pack served through
  `s.serveValue` / `s.serveCollection`, and contributed answers). Its context gets the page id
  and the track-instructions id.
