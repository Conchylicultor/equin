# In-app demo scope: render any app on fake data, in-process

## Context

The website (`apps/website`) should show the real apps (Agent Manager, Mail,
Pages, …) on fake data, for its pages, screenshots and an online demo. This must
be **integrated in the app**: the website renders the real component tree
in-process. No separate build, no static bundle, no iframe.

Decided with the user:
- The public website is served by a **real Singularity instance**. Only the
  embedded demo is fake; the rest of the page boots against the real server.
- Visitors get **row-level writes**: checking a task or typing in a page works,
  and each visitor's changes are thrown away when they leave.

The shape: `<DemoScope scenario>` swaps the **transport** (socket and fetch) for
a subtree to an in-browser `DemoBackend`. That backend speaks the real wire
protocol, answering from a recorded **pack**. `<AppEmbed app route>` renders one
app's surface inside that scope.

Faking at the transport rather than at the hooks is deliberate. It keeps the
real `NotificationsClient`: version guard, schema parse, keyed-delta merge,
watermarks and acks all run unchanged. Faking hooks would mean rewriting window,
filter, sort and group semantics for each resource.

## Inventory: what bypasses a React-context scope today

### Data path

| Area | Where | Today | Fix |
|---|---|---|---|
| Live reads (`useLive`, `useResource`, config) | `live-state/web/use-resource.ts` | Hooks read `NotificationsContext` and `useQueryClient()`, so they are scoped. But `NotificationsProvider` returns a **module singleton** (`singleton`, `:94-97`) bound to the first QueryClient. | Build one client per provider. `NotificationsClient` already takes `makeSocket` and `fetchImpl` (`notifications-client.ts:701-715`). |
| Default client | `getDefaultQueryClient` (5 sites, all in `use-resource.ts`), `ensureNotificationsClient` (`web-core/web/App.tsx:233`), `getNotificationsClient` (`infra/health/.../wedge-watchdog.tsx:131`) | global | These stay the host's root backend. Nothing inside a scope may reach them. |
| Registries | `watermark-registry.ts:21`, `tx-ack-registry.ts:40`, `resource-contract-store.ts:27`, `pending-mount-tracker.ts:27`; read by `optimistic-mutation/.../use-optimistic-resource.ts:8-10` and `send-lane.ts:31` | module-global, keyed by `(key, params)` | Move onto the client instance and read them through context. Otherwise a demo tuple and a real tuple with the same key collide. |
| Boot hydration | `infra/boot-snapshot/web/internal/boot.ts:25,58` → `hydrateResource`/`hydrateQuery` → default client; `hydrateEndpoint` used by saved-themes and tweakcn | global | Hydrate into a client that the caller passes in. The demo scope hydrates synchronously from the pack. |
| Endpoints | `infra/endpoints/web/internal/fetch-endpoint.ts:120` (global `fetch`, or `networking/web/fetch-with-retry.ts:33`) | Hooks (213 sites) take the cache from context but fetch globally. **Imperative `fetchEndpoint` has 195 sites in 125 files and no context.** | Hooks read the transport from context. Imperative calls move to `useEndpoints()` (see Phase 0). |
| Config | `config_v2/web/internal/use-config.ts` reads through `useLive`, so it is scoped. `pageBootPaths` is a module `let`. | mixed | Key `pageBootPaths` per backend. |
| Asset URLs | `<img src="/api/…">`: wallpaper, task attachments, code-api image URL, url-paste | global origin | Add `useAssetUrl(path)` from the transport (a blob URL from the pack in a demo). About 4 sites. |
| Debug streams | `readNdjson` (timeline, slow-ops cluster, worktree cleanup), log `ReconnectingEventSource` | global | Out of scope. Debug isn't demoed. |

### UI and runtime state

| Area | Where | Today | Fix |
|---|---|---|---|
| Pane routing | `createPaneStore({live:false})` (`primitives/pane/web/pane.ts:767`) never touches `window.history`; `seedPending(route)` | **already works** | — |
| Imperative pane API | `openPane`/`peekRoute`/`restoreRoute`/`clearRoute`/`setBasePath` target `liveStoreSink` (`pane.ts:1156,1392+`), about 15 sites; `pane.back/forward` use `window.history` (`:2356`) | global | Use context-store variants. Only sites the demoed routes reach need it first; the rest are listed as exempt debt. |
| Cross-app navigation | `navigate()` = module `tabsNavigator` (`tabs/use-tabs.tsx:117-138`), `appNavSink`, `appLinkProps`, Expand/promote | global (the host website would navigate) | Add an `AppNavContext` override. AppEmbed intercepts and either stays inside the embed (same app) or refuses (other app). About 3 sites. |
| Theme | `<Theme name={appThemeScope(id)} surface="canvas">` scopes the tokens; `AppScopeThemes` already emits `[data-theme-scope="app:<id>"]`; `useAppSettingsScope` reads the nearest boundary | **already works** | Light/dark stays global (`<html>.dark`), as already known. |
| Shortcuts | `useSurfaceShortcuts` gated on `surfaceId`; `UndoRedoKeys` registers mod+z globally | mostly scoped | AppEmbed doesn't mount `UndoRedoKeys`. |
| Toasts, edit mode | `toast/live-toasts.ts:25`, `edit-mode-store.ts:4` | global | Accepted: a demo toast showing on the host page is fine. |
| Tab bookkeeping | `TabSurface` → `useTabs().setTabTitle`; the tab set persists to sessionStorage | global | AppEmbed doesn't use `TabSurface`. It shares a factored `SurfaceCore` with it. |
| Already inert | document title, focused-app store, app-usage, analytics, Core.Root collectors | — | — |

**Sizing.** The data seam is about 15–20 real edits inside live-state, endpoints,
boot-snapshot and optimistic-mutation. The 195 imperative `fetchEndpoint` call
sites are mechanical churn. UI scoping is about 20 sites. Everything else already
scopes.

## Design

### 1. Transport seam (`primitives/networking`, web)

```ts
interface Transport {
  makeSocket(url: string): SharedWebSocketLike; // "/ws/notifications", "/ws/central-notifications"
  fetch: typeof fetch;                          // /api/resources/*, endpoints, assets
}
<TransportProvider transport={…}>               // default: the real origin
useTransport()
```

`live-state`'s `NotificationsProvider` becomes a real boundary, renamed
`LiveBackendProvider`. It creates its own `QueryClient` and `NotificationsClient`
(through `transport.makeSocket` and `transport.fetch`) plus that client's
registries, all exposed through context. The root mount in `web-core/App.tsx`
stays the host's backend. `optimistic-mutation` reads the watermark and tx-ack
registries from the client in context.

Endpoints: `useEndpoint` and `useEndpointMutation` fetch through
`useTransport()`. Imperative calls become `const api = useEndpoints();
api.fetch(endpoint, args)`. A lint rule (`endpoints/no-contextless-fetch`) bans
bare `fetchEndpoint` in web code. Each plugin not yet migrated carries a
`kind: "debt"` exemption with a task, so the migration can be gradual and is
tracked by `./singularity exempt list --debt`. Code that genuinely runs outside
React, such as boot tasks and module stores, is host-level by nature and keeps an
explicit `fetchEndpointAtRoot`. The name says what it reaches.

### 2. `DemoBackend` (new umbrella `plugins/demo/`, `backend` sub-plugin, web)

`DemoBackend` is an in-browser `Transport`. It builds on
`networking/web/testing/transport-fakes.ts`, but it's a production module, not
test code.

- **Socket.** It answers `sub`/`sub-batch` with `sub-ack` from the pack, `unsub`
  with nothing, and pings on schedule. It emits a consistent `epoch` and
  `version`, and accepts the client's `build`.
- **Collections.** The backend merges every recorded row of a collection by pk
  into one row store. Windows, points, groups and counts are computed from it:
  - filtering with `matchesFilter` (`network/live/plugins/filter/core`);
  - ordering with a new shared `compareRows(orderBy)` in `network/live/shared`,
    built on `compareScalars` and `key-order.ts`, with the pk as tiebreak, so it
    is also reusable server-side;
  - paging with `sliceRange`;
  - `$key` minted exactly as the server does.

  So visitors can filter and sort freely over the recorded rows.
- **Values.** Recorded per `(key, params)`. A tuple that wasn't recorded answers
  `sub-error` with a typed `demo-missing` refusal, which renders the loud error
  state, never an empty list. Bytes values are served through `fetch` with the
  `parseResourceBytesHeaders` headers.
- **Writes** go through `fetch` to an endpoint.
  - Default (generic): the transport advertises `adoptsPredictions: true`. For an
    optimistic write, `useOptimisticResource` sends the overlay's predicted value
    for the tuple to the backend after `mutate` resolves. The backend commits it
    to the row store or value, recomputes the affected subscribed tuples, and
    pushes `delta`/`update` with `version+1`, `watermark` above the write's
    token, and `ackTx:[token]`. Any other tuple gets a bare `ack`. Pending ops
    confirm through the normal path, and other views of the same rows update.
  - Non-optimistic writes answer 409 `demo-unsupported`, surfaced as a
    "Not available in the demo" toast through the existing mutation-error path.
    A plugin can contribute a `demo/` write handler later for a flow worth
    showing.
- **Time.** The pack records `recordedAt`. At load, every date field (found by
  walking the descriptor's zod schema) shifts by `now − recordedAt`, so
  "3 min ago" stays true.

### 3. `DemoScope` (`demo/scope`, web)

```tsx
<DemoScope scenario="agent-manager">   // loads the pack lazily; loading state until parsed
  …                                    // TransportProvider(DemoBackend) > LiveBackendProvider
</DemoScope>
```

When a pack loads, every value is parsed with its client descriptor's schema.
A mismatch fails loudly, naming the key, so a stale pack can't half-render.

### 4. `AppEmbed` (`apps-core/plugins/app-embed`, web)

`AppEmbed` mirrors `TabSurface` minus the tab bookkeeping, through a factored
`SurfaceCore`:

```
<Theme name={appThemeScope(app)} surface="canvas" className="relative isolate transform-gpu">
  <AppNavProvider onNavigate={stay-in-embed | refuse}>
    <PaneSurfaceProvider store={createPaneStore({live:false}) seeded with route}
        surfaceId={`embed:${useId()}`} basePath loadScopePrefix appId>
      <SyncStatusProvider><UndoRedoProvider><SurfaceOverlayHost>
        {renderIsolated(Apps.App, entry)}
```

All of it sits in a `PluginErrorBoundary`. `AppEmbed` knows nothing about demos:
it also works on real data, without a `DemoScope`.

### 5. Seeds and the recorder (`demo/recorder`: cli + e2e, `demo/seed`: core)

- A new folder kind, `demo/` (vocabulary entry and boundary-table row): a
  plugin's `demo/index.ts` default-exports
  `defineDemoSeed({ scenarios, seed(db, ctx) })`. `ctx.id(kind)` mints
  deterministic ids and `ctx.now` is the pinned recording clock.
- A scenario is declared by its owner, for example
  `apps/agent-manager/demo/scenarios.ts`: `{ id, app, routes[] }`.
- `./singularity demo record <scenario>` does the following:
  1. creates a throwaway database and migrates it;
  2. runs every seed for that scenario;
  3. boots a backend on it;
  4. drives each route with `withBrowser` and `tapSharedSocket`
     (`networking/e2e/support/socket-tap.ts`), recording every subscribed tuple;
  5. reads each tuple with `GET /api/resources/<key>` (bytes as binary);
  6. writes `pack.json` next to the scenario (committed and reviewable);
  7. drops the database.

  **The recorder only accepts a database it created**, so real data can never
  reach a pack.
- A check, `demo:packs-parse`, parses every committed pack against the current
  descriptors. It is static and cheap, and catches a pack gone stale after a
  contract change at `check` time, not when a visitor loads it.

### 6. Website band (`website/plugins/landing/plugins/demo`)

A `Website.Section` that renders
`<DemoScope scenario="agent-manager"><AppEmbed app="agent-manager" route="/tasks"/></DemoScope>`
inside a `WebsiteBand`, with its key added to
`config/apps/website/shell/section.jsonc`. The same pair serves e2e and
screenshots through a route such as `/website/demo/<scenario>`.

## Phases

0. **Transport seam, no behaviour change.**
   - `TransportProvider`; per-provider live client and registries; endpoints
     hooks on the transport; boot hydration into a passed client; `useAssetUrl`.
   - `useEndpoints()`, the lint rule, and debt exemptions for unmigrated plugins.
   - Migrate the plugins the agent-manager `/tasks` route reaches.
1. **Read-only demo of one app.** `DemoBackend` (reads only), `DemoScope`, a
   small hand-written pack, `AppEmbed` (including `AppNavContext`), and the
   website band.
2. **Recorder and seeds.** The `demo/` folder kind, `demo record`, and
   `demo:packs-parse`.
3. **Writes.** `adoptsPredictions`, commit-and-push in the backend, and the
   `demo-unsupported` toast.
4. **Breadth.** Time rebasing, the remaining imperative-pane and `fetchEndpoint`
   migrations, and more scenarios (Mail, Pages).

## Limitations (accepted)

- Light/dark mode is global.
- Toasts and edit mode are shared with the host page.
- Server-only effects (agent launches, triggers, rollups) don't run, so a value
  the server derives from rows isn't recomputed after a demo write unless it is a
  collection window the backend computes itself.
- External integrations (Gmail, Maps) show their normal "not set up" state unless
  a scenario stubs them.
- Agent transcripts are static.
- The website bundle carries the embedded app's plugins (they're lazy-loaded).

## Open questions

- How does `demo record` boot a backend on a throwaway database? It could use a
  worktree backend pointed at a named database, or a dedicated `demo-<scenario>`
  namespace. Check how `createTestDb` (`database/db-test-fixture`) and migrations
  run, before Phase 2.
- Is the website a separate composition (`composition-set.ts` mentions
  `website`)? If so, it must include the embedded app's plugins.

## Verification

- **Phase 0:** `./singularity check` and `./singularity test` for live-state,
  endpoints and optimistic-mutation. The existing live e2e scripts
  (`network/live/e2e/reconnect-after-gap.ts`,
  `tasks-core/e2e/tree-live-verify.ts`) must pass unchanged, and the app must
  behave the same.
- **Phase 1:** a jsdom test mounts a `DemoScope` next to a real
  `LiveBackendProvider` with the same key and asserts there's no crosstalk. Then
  `./singularity build` and `screenshot.ts --path /website` show agent-manager
  `/tasks` with pack data, and the host page still shows real data.
- **Phase 3:** an e2e script checks a task in the demo, asserts the row updates
  and no op stays pending, reloads, and asserts the change is gone.
- **Phase 2:** recording the same scenario twice produces a byte-identical pack
  (deterministic ids and clock).
