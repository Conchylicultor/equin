# In-app demo scope v2 — Phase 1: one Agent Manager conversation, in-process, on fake data

> Supersedes the phasing of [`2026-10-12-global-in-app-demo-scope.md`](./2026-10-12-global-in-app-demo-scope.md)
> (its inventory stays valid; Phase 0 — the Transport seam — landed in `ea5cc8da26`).
> The vision, mental model and long-term phases live in the wiki track
> **Demos and client server** (`block-3e397e42-8412-4895-b854-e620a1b4f789`); this doc is the
> Phase 1 implementation design only.

## Context

The website should show real apps running on fake data, rendered in-process: no iframe, no
separate build. Phase 0 made every server touch of a subtree resolve through `useTransport()`
(live sockets, the live client's HTTP reads, the endpoints hooks, `useFetchEndpoint()`, asset
URLs). Nothing uses it in production yet.

Phase 1 ships the first real caller: the website's homepage gets a band showing the
**Agent Manager at `/agents/c/<id>`**, so the sidebar (launch item, Queue, done list) and one
conversation (header chips, transcript, prompt bar) are on screen. It is **read-only**, running
on today's full instance.

What changed from v1, decided with the user:
- **Target:** a conversation, not `/tasks`. It is the compelling demo and about the same size:
  roughly 20 tuples on mount, the transcript being one static live value (`jsonl-events {id}`).
- **Config comes from the demo backend, never read through from the host.** In the end state
  the website composition will not carry the embedded app's server halves, so the host cannot
  answer that app's config (`config-v2.scopes` would not list its paths). Phase 1 answers config
  from code defaults; a later phase bakes in the committed git layer.
- **Endpoint model.** Every request inside the scope is matched against its `defineEndpoint`
  declaration. A row edit is committed from the optimistic prediction (later phase). An effect
  runs a handler its owning plugin contributes, and otherwise gets a refusal plus a toast.
- **No lint guard in Phase 1.** It is replaced by an explicit leak ledger and ship gate (below).
- **The backend is a browser-server running the real server machinery** (resource runtime,
  router, `implement`), not a hand-written fake of the protocol. Only the data source is
  faked (§1).
- **Pack = exact tuple answers, not an in-memory query engine.** The wiki track's long-term
  direction runs the real server code in the browser (PGlite plus a browser server-core), which
  makes a hand-built row store with filter/sort/window semantics throwaway work. Phase 1 packs
  answer recorded `(key, params)` tuples, built with the collection's own codec, and every
  unrecorded tuple fails loudly.

## Design

### 1. Architecture: a browser-server running the real server machinery

The demo "backend" is **not** a hand-written fake of the wire protocol. It is a small
in-browser server-core: the real resource runtime and the real request router, with only the
**source of the data** faked. A Phase 1 resource is registered with the same call the server
uses, `defineResource(descriptor, { loader })`; only its loader is "look the tuple up in the
pack". Moving to real server code later (plugins' own `server/` barrels on PGlite) swaps who
registers the loaders. Protocol, routing, transport and app code do not change.

```
App code (unchanged)  ── useLive / useFetchEndpoint ──▶ Transport (useTransport)
                                                          │
                       ┌──────────────── BrowserServer ───┴──────────────────────────┐
                       │  socket pair (in-memory; MessagePort when moved to a worker)│
                       │       ▼                                     fetch(Request)  │
                       │  resource runtime  ◀── GET /api/resources/:key ── router ◀──┘
                       │  (createResourceRuntime,                    (server-core's   │
                       │   the real one)                              route matcher)  │
                       │       ▲ defineResource(descriptor, {loader})      ▲ routes   │
                       └───────┼──────────────────────────────────────────┼──────────┘
              Phase 1 resources: pack lookups +          Phase 1 routes: implement(endpoint, handler)
              plugin-contributed (config)                 contributed by the owning plugin
              Target: the plugins' own server barrels on PGlite (serveCollection SQL, real handlers)
```

**What is reused, and when**

| Piece | Server code reused | When |
|---|---|---|
| The wire protocol: sub / sub-batch replay, versions, epoch, up-to-date, keyed deltas, acks, the HTTP read | **`createResourceRuntime`** (`framework/resource-runtime/core`), the real runtime. Its bun:test suites already drive it on fake sockets. | Phase 1 |
| Endpoint contract: args parsed with the endpoint's zod schema, typed result, error bodies | **`implement(endpoint, handler)`** (`infra/endpoints/core`) | Phase 1 |
| Request routing | **server-core's route table and matcher**, extracted from `bin/index.ts` | Phase 1 |
| Params, codecs, `$key`, keyOf | the descriptors' own codecs (`network/live/core`) | Phase 1 |
| Loaders (SQL reads) and handler bodies (writes) | plugins' own `server/` code on PGlite (`drizzle-orm/pglite`) | browser-server spike, then demos backed by it |
| Change propagation after a write | runtime `notify`, driven by the change feed through a `pglite.listen` adapter | same |

#### 1a. Server code made host-agnostic (prerequisites, small)

- **`framework/resource-runtime/core`:**
  - `node:crypto` (`createHash`, `randomUUID`) becomes a portable hash plus
    `globalThis.crypto.randomUUID`;
  - the `bun` `ServerWebSocket<WsData>` type becomes a structural `RuntimeSocket`
    (`send`, `data`; whatever `open`/`message`/`close` actually use);
  - the Bun server keeps passing its real sockets.
- **`framework/server-core/core` (new barrel export) `createRequestHandler(routes, runtime)`:**
  - the dispatcher currently inlined in `bin/index.ts` (`populateRoutes`, `matchSegments`,
    `safeHandle`, the `/api/resources/:key` route) moves here as a pure
    `(Request) => Promise<Response>`;
  - `bin/index.ts` calls it from `Bun.serve`'s `fetch`, so both hosts run one router;
  - error reporting is injected (`onError`), since `reportServerError` is server-only.

#### 1b. `framework/browser-server` (new plugin)

A second **host** for server code, beside `server-core`. It knows nothing about demos: a
client-only Sonata or Pages uses it directly.

```ts
// core/: no DOM, no React. The same code runs in a page or a worker.
const server = createBrowserServer({
  resources: ServedResource[],  // { descriptor, loader, … } → runtime.defineResource
  routes: HttpRoutes,           // the shape server plugins' httpRoutes already have
  fallbackLoader?: (key) => never, // every web-known descriptor with no resource (see below)
});
server.request(req: Request): Promise<Response>  // createRequestHandler(routes, runtime)
server.connect(): ServerSocketEnd                // one in-memory socket into runtime.open/message/close
server.notify(key, params?)                      // unused in Phase 1 (no writes)

// web/
browserServerTransport(server): Transport
```

- `socketUrl(path)` → `browser:<serverId>:<path>`, unique per server instance (the
  ws-status bus is keyed by URL).
- `openSocket` → the client half of `server.connect()`. It fires `onopen` in a microtask and
  publishes `publishWsStatus({ url, status: "open" })`, so the client is "ready" and skips the
  cold-start HTTP prime.
- `fetch` → `server.request`. `assetUrl` → a URL the server's asset map resolves to a
  blob/`data:` URL, else an unloadable `browser:` URL (no asset on the conversation route needs
  one).
- **Unrecorded reads fail loudly, and never as skew.**
  - Every descriptor the web side knows (`resourceDescriptorByKey`; add an enumeration export
    to `live-state/core`) gets a resource whose loader throws `demo-missing`. The read renders
    `loader-failed` with that message.
  - A bare unknown key must never reach the runtime. Its `unknown-key` answer would be read as
    version skew and show "App updated — reload" in the host's page-global
    contract-mismatch store.
  - Descriptors registered after boot (lazy plugins) are bound through the runtime's existing
    `defineDeferredResource` / `bindDeferredResources` path.
- **Unmatched endpoint requests** (`/api/…`, any method) → 409 `{ reason: "demo-unsupported" }`.
  The scope shows one deduped toast, "Not available in the demo". Any other path is a 404
  naming it.
- **Thread:** the page thread in Phase 1. The worker move (MessagePort socket pair) comes with
  the PGlite spike; the transport hides the difference.
- **Risk to verify first:** whether `defineResource` accepts a window or point descriptor
  without the `windowQueryResource` compile (membership routing). If not, the pack serves those
  tuples as plain keyed resources per exact params, which is enough with no notifies.

### 2. Pack format (`demo/core`)

The pack is a typed TypeScript module, not JSON (the recorder will emit JSON later), so tsc
checks every row against its descriptor's type:

```ts
export default definePack(({ ago }) => [
  packValue(jsonlEvents, { id: CONV }, [...events]),        // a liveValue tuple
  packRows(conversationsById, [conv]),                      // point reads (:rows), any id subset
  packAll(taskRows, [...tasks]),                            // an `all` collection's one tuple
  packWindow(conversationsGone, { /* default query */ }, [...rows]), // a window, params via the codec
  packCount(conversationsGone, {}, 12),
]);
```

- Params are always produced by the descriptor's own codec (`window.encode`, `point.encode`,
  `canonicalParams`), never hand-written, so a pack tuple and the hook's subscription name the
  same tuple.
- `packRows` answers any `:rows` id subset from the listed rows (unknown ids absent). That is
  the server's own point semantics, so it is not a query engine.
- Scroll windows need `$key` on each row. `packWindow` mints it with the server's rule,
  exposed from `network/live/core` (today `pageRowsOf` in `shared/compile-value.ts`, which is
  private: move the row-key minting into `core/` rather than copying it).
- `ago(ms)` gives timestamps relative to load time, so "3 min ago" stays true without the
  later time-rebase machinery.
- On load, every tuple is parsed with `resourceDescriptorByKey(key).schema`. A mismatch throws,
  naming the key, so a stale pack cannot half-render.

### 3. `demo` umbrella: pack + `demo/scope` (web)

`demo/` adds only where the data comes from, on top of `browser-server`.

```tsx
<DemoScope scenario={agentManagerDemo}>   // loading state until the pack module and its parse land
  …   // createBrowserServer(pack + contributions) → TransportProvider(browserServerTransport) → NotificationsProvider
</DemoScope>
```

- `demo/core`: `definePack`, the `pack*` builders, `packResources(pack): ServedResource[]`,
  and the `DemoScenario` type.
- `demo/plugins/scope/web` owns two slots, so the demo plugins never name a contributor:
  - `Demo.Resource({ resources: ServedResource[] })`: a plugin answers its own keys. Phase 1
    contributor: **config_v2**, which answers `config-v2.scopes` (every web-registered storePath
    → `[]`) and `config-v2.values` (that descriptor's code defaults) from its own
    `ConfigV2.WebRegister` registrations.
  - `Demo.Route({ route })`, with `route` built by `implement(endpoint, handler)`: a plugin's
    in-browser handler for one of its endpoints. Phase 1 contributor:
    **conversations/hibernation** for `markViewed` (it fires when a conversation mounts),
    returning its not-blocked outcome.
- The scope builds the server once per mount and publishes `TransportProvider` from
  `networking/web`'s public barrel (moved out of `web/testing`, as Phase 0 promised for its
  first production caller).
- No boot hydration into the scoped pipeline: the runtime answers in a microtask, so the embed
  shows its loading state for one frame.

### 4. `apps-core/plugins/app-embed` (web)

`<AppEmbed app="agent-manager" route="c/<id>" />` renders one app surface in-process. It knows
nothing about demos: it works on real data with no `DemoScope` around it.

- **`SurfaceCore`**, factored out of `TabSurface` (`apps-core/plugins/tab-surface/web/components/tab-surface.tsx:44-73`):
  `PaneSurfaceProvider` → `SyncStatusProvider` → `UndoRedoProvider` → `SurfaceOverlayHost` →
  `renderIsolated(Apps.App, app)` + `SyncStatusIndicator`. `TabSurface` keeps `TabTitleReporter`
  and `UndoRedoKeys` around it; `AppEmbed` mounts neither.
- `AppEmbed` adds:
  - `<Theme name={appThemeScope(app)} surface="canvas" className="relative isolate transform-gpu">`
    (the transform makes `position: fixed` descendants resolve against the embed);
  - a `createPaneStore({ live: false })` seeded with `seedPending(route)`;
  - `surfaceId={`embed:${useId()}`}`;
  - `basePath` from `appPathFor`, `loadScopePrefix` from `loadScopePrefixFor`;
  - a `PluginErrorBoundary`.
- **Navigation boundary (`AppNav`).** Cross-app navigation reads module globals today:
  `tabsNavigator`/`navigate()` (`tabs/web/internal/use-tabs.tsx:117`), `appNavSink` (Expand via
  `usePromote`, `pane.ts:2431`), `appLinkProps`, and `useActivateApp`.
  - Add an `AppNav` context at the lowest layer that needs it (`primitives/pane`, beside
    `appNavSink`), read first by `usePromote`, and by hook forms of `navigate`/`appLinkProps`/
    `useActivateApp` in `apps-core/tabs`.
  - `AppEmbed` provides it: a same-app URL is pushed into the embed's own pane store, and
    another app is refused (toast).
  - Migrate the call sites the route reaches: the app brand's home button (`app-brand.tsx:32`),
    the launcher grid (`app-launcher.tsx:128`), and pane Expand.
- Accepted: modifier-click hrefs still open `/agents/…` on the host origin. DataView view state
  in `localStorage` (`tasks-list:view-state`, …) is shared with the real app on the same origin.

### 5. Scenario + pack (`apps/agent-manager/plugins/demo`, web)

- Exports `agentManagerDemo: DemoScenario = { app: "agent-manager", route: "c/<CONV>", pack: () => import("./pack") }`.
  The owner of the app declares its scenario, so `demo/*` never names it.
- The pack covers every tuple the route subscribes to on mount (from exploration):
  - **rows:** `conversations.by-id`, `jsonl-events {id}`, `tasks`, `attempts`, `task-tracks.all`,
    `agents.roster`, `agent-launches`, `conversation-preprompts`, `conversation-progress`,
    `turn-summaries`, `conversation-notes`, `conversations-active`, `task-source-url.by-attempt`;
  - **host values with fixed answers:** `allow-files`, `attempt-work` (fixed ahead/behind),
    `op-store.in-flight`/`.history` (empty), `machine.sleep`, `subagent-activity` (none),
    `model-provider.catalog`;
  - **sidebar:** `conversations-gone` default window + `GONE_COUNT` count,
    `queue-ranks:rows` for the live ids.
- The authoritative list is whatever `demo-missing` reports in the running embed. Iterate until
  none remain; the transcript and rows should tell one believable story (an agent fixing a bug).

### 6. Website band (`apps/website/plugins/landing/plugins/demo`, web)

- A `Website.Section({ id: "demo", label: "Live demo", component })` rendering
  `<WebsiteBand rhythm="section">` → caption + a fixed-height frame →
  `<DemoScope scenario={agentManagerDemo}><AppEmbed …/></DemoScope>`.
- Its key goes into `config/apps/website/shell/section.jsonc` **after `screenshot`**.
- Template: `landing/plugins/story-link`.

### 7. Leak ledger and ship gate (replaces the lint guard for now)

A bare `fetchEndpoint(…)` inside the scope bypasses the transport and hits the page's server.
On today's full instance that is a **real write**. On the end-state website composition it
would be a loud 404.

- Phase 1 migrates every bare `fetchEndpoint` reachable from the embedded route (sidebar
  included) to `useFetchEndpoint()`. Module-level API helpers (`tasks/web/client.ts`, the
  `api.ts` files of task-track/notes/…) take the bound fetch as an argument instead of calling
  the global. The list is produced with `rg "fetchEndpoint\(" <reached plugins>` and recorded
  below as it is migrated. Known so far:
  - `hibernation/mark-viewed.ts`, `pending-turn/delivery.ts`, `notes/api.ts`,
    `task-track/api.ts`;
  - `dependencies-button.tsx`, `launch-prompts-button.tsx`, the exit-menu items;
  - `conversation-list.tsx`, `queue-item-actions.tsx`, `use-queue-rows.ts`;
  - `launch-control.tsx`, `use-task-launch.ts`.
- **Ship gate:** the demo band must not be enabled on a publicly reachable instance while any
  plugin the demo reaches still has a bare `fetchEndpoint`. The remaining ~180 sites are one
  tracked task. The lint rule (`endpoints/no-contextless-fetch` + debt exemptions) is
  reconsidered when a second scenario lands.

| Plugin | Status |
|---|---|
| `conversations/hibernation` (`markConversationViewed` → `useMarkConversationViewed()`, bound through `useFetchEndpoint()`; its demo answer is the `Demo.Route` for `markViewed`) | migrated |

## Where it lives

```
plugins/
├── framework/plugins/
│   ├── server-core/core/        createRequestHandler (moved out of bin/index.ts; the Bun host uses it too)
│   ├── resource-runtime/core/   made host-agnostic (no node:crypto, no bun ws type)
│   └── browser-server/          NEW: the in-browser host
│       ├── core/                createBrowserServer: runtime + router + socket pair; page- or worker-runnable
│       └── web/                 browserServerTransport(server): Transport
├── infra/plugins/endpoints/core/  implement(): both hosts mount routes made with it (unchanged)
├── demo/                        NEW umbrella: fake data on top of browser-server
│   ├── core/                    pack format, packResources, DemoScenario
│   └── plugins/scope/web/       <DemoScope>, the Demo.Resource / Demo.Route slots
├── apps-core/plugins/app-embed/ NEW: <AppEmbed>, independent of demos and of browser-server
├── apps/plugins/agent-manager/plugins/demo/web/                scenario + pack (the app owns its demo)
├── apps/plugins/website/plugins/landing/plugins/demo/web/      the band
└── config_v2/web, conversations/plugins/hibernation/web        Demo.Resource / Demo.Route contributions
```

- **Shared server machinery moves into its owner's `core/`; it is never copied.**
  `browser-server/core` imports only other plugins' `core`, which the import table allows.
- **No new folder kind in Phase 1.** Demo contributions are small web contributions. A
  `demo/` folder kind returns with seeds, also to keep them out of the full app's bundle.
- **Other changes:**
  - `primitives/networking/web/index.ts` (publish `TransportProvider`);
  - `live-state/core` (enumerate descriptors);
  - `apps-core/plugins/tab-surface` (factor `SurfaceCore`);
  - `primitives/pane/web` (`AppNav` context), `apps-core/plugins/tabs` (hook forms);
  - `network/live/core` (row-key minting moved out of `shared/`);
  - the migrated `fetchEndpoint` sites;
  - `config/apps/website/shell/section.jsonc`.
- **Later, running real `server/` barrels in the browser.** `browser-server` boots them through
  the shared boot stages, which move from `server-core/shared` (private) to `server-core/core`.
  The open question for that phase is substrate selection per host: the same code imports `db`
  and `defineJob`, which are node-postgres and graphile-worker on Bun but PGlite and an
  in-worker scheduler in the browser. The likely shape is a host target on the composition
  (`bun | browser`) selecting substrate plugins. Nothing in Phase 1 depends on it.

## Verification

- `./singularity test plugins/framework/plugins/resource-runtime plugins/framework/plugins/server-core`:
  the existing suites pass unchanged after the host-agnostic edits and the router extraction.
- `./singularity test plugins/framework/plugins/browser-server plugins/demo plugins/primitives/plugins/live-state`:
  - a jsdom test mounts a `DemoScope` next to the page pipeline subscribing the same key and
    asserts no crosstalk;
  - a browser-server test drives the real `NotificationsClient` against `createBrowserServer`
    through `browserServerTransport`. It covers subscribe, `sub-batch` replay after a socket
    reopen, `demo-missing` → `loader-failed` (and never a contract mismatch), a contributed
    `implement` route answering, an unmatched POST → 409, and pack parse failure naming the
    key.
- `./singularity build`, then
  `screenshot.ts --path /website --viewport 1440x2400` shows the band with the conversation and
  sidebar from the pack, and no `demo-missing` error.
  - The host page around it still renders real data.
  - Clicking a row in the embed's sidebar changes the embed's route, not the host URL.
  - Clicking another app in the launcher is refused.
- Check `logs/live-state.jsonl`: no subscription from the demo pipeline reached the real
  socket.
- Click a write affordance (Close conversation in the sidebar): toast, and no request to the
  real server (gateway access log).
- `./singularity check`.
