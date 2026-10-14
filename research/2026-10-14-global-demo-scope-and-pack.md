# Demo scope and pack: fake data on top of the browser server (in-app demo Phase 1, step 2)

> Parent design: [`2026-10-13-global-in-app-demo-scope-v2.md`](./2026-10-13-global-in-app-demo-scope-v2.md) §2–§3.
> Built on: [`2026-10-13-framework-browser-server-host-v2.md`](./2026-10-13-framework-browser-server-host-v2.md)
> (`createBrowserServer`, `browserServerTransport`, `s.serveValue` / `s.serveCollection` external arm).
> Track: **Demos and client server** (`block-3e397e42-…`).

## Context

The browser server exists, but nothing feeds it fake data. This step adds:
- the **pack format**: typed recorded answers, served through the browser server's own
  `s.serveValue` / `s.serveCollection`;
- **`<DemoScope>`**: builds one browser server per mount and points its subtree at it through
  `TransportProvider`;
- **plugin-contributed answers** (`Demo.Resource`, `Demo.Route`). The first two contributors are
  config_v2 (config from code defaults) and hibernation (the `markViewed` handler);
- **loud failures**:
  - an unrecorded read fails as `loader-failed` (the browser server already does this);
  - an unsupported write shows one deduped "Not available in the demo" toast. It is never a
    "Request failed" toast, and never a report or notification filed on the real server.

Out of scope: AppEmbed, the Agent Manager pack, the website band, and the wider `fetchEndpoint`
migration. Those are the track's next tasks.

**What changed from the parent §2.** The browser server now serves through the unified API, so a
pack is not a set of `defineResource` loaders. It is a list of entries grouped per declaration,
each group becoming one `s.serveValue` / `s.serveCollection` call whose loader is a lookup of
exact recorded tuples.

## Design

### 1. `framework/browser-server/plugins/demo/core`: the pack

The demo plugins nest under `framework/plugins/browser-server/plugins/demo`, not a new
top-level umbrella. They extend the browser server, and their consumers include the website,
gallery screenshots and later ones. So generic contributors (config_v2, hibernation) depend on a
framework plugin, never on an app. `demo/core` imports only other plugins' `core` barrels
(browser-server, network/live, canonical-params).

```ts
export default definePack(({ ago }) => [
  packValue(configValues, { path: "x/y.jsonc" }, { … }),     // a liveValue tuple: exact params
  packAll(taskTracks, [...rows]),                              // an `all` collection (+ its :rows)
  packRows(conversationsById, [...rows]),                      // a lookup-only collection's :rows
  packWindow(conversationsGone, { /* query */ }, [...rows], { count: 12 }), // one window tuple (+ :rows from its rows)
]);
```

- **Typed against the declaration.** Each builder is generic over the `LiveValue` /
  `LiveCollection`. tsc checks params, value and rows, and the builder's overload picks the
  collection shape.
- **Parsed on load.** `definePack` evaluates the thunk with `ago(ms)` (an ISO string `ms` before
  load time) and parses every value or row with its declaration's schema. A failure throws
  `DemoPackError` naming the key and the tuple, so a stale pack cannot half-render.
- **Exact tuples.** Lookups are keyed by `canonicalJson(canonicalParams(…))`
  (`packages/canonical-params`), the spelling the client subscribes under.
  - A window entry's key is the canonical spelling of its decoded query with `limit` dropped.
    The loader answers the first `q.limit` recorded rows.
  - `:rows` answers any id subset from every row the declaration's entries list (absent ids are
    omitted). That is the server's own point semantics.
  - Anything else throws `DemoMissingError(key, params)`.
- **`servePack(pack)(s): BrowserServed[]`** groups entries by declaration. Each group becomes one
  serve call with `changes: { fixed: { reason: "demo pack" } }`. Two groups for one key is
  impossible by construction. A key served by both the pack and a contribution throws in the
  scope (§2).
- **`DemoScenario`**: `{ id: string; pack: () => Promise<{ default: DemoPack }> }`. The app and
  route fields arrive with AppEmbed; the scope only needs the pack.
- **Known limit, for the Agent Manager pack:** declarations with `exposes` / `arms` /
  `contributed` / `columnScope` have no external serve spelling (`serve-on.ts` throws), for
  example `conversations-active`. The builder types exclude them, so the limit is a type error
  in the pack rather than a boot throw. Lifting it is the next task's problem; it is recorded on
  the track card.

### 2. `framework/browser-server/plugins/demo/plugins/scope/web`: `<DemoScope>` and the two slots

```ts
export const Demo = {
  // A plugin answers its own keys. Called once per scope mount, inside the scope's React tree:
  // the hook gathers what it needs (registrations…) and returns the serve function.
  Resource: defineSlot<{ id: string; useServe: Hook<() => (s: BrowserServe) => readonly BrowserServed[]> }>(…),
  // A plugin's in-browser handler for one of its endpoints: [ep.route, implement(ep, h)].
  Route: defineSlot<{ route: readonly [string, RouteHandler] }>(…),
};
```

`<DemoScope scenario>`:
1. Loads `scenario.pack()` and renders the `primitives/loading` state until it has landed. A
   pack parse failure renders loudly through the error boundary, not as an empty app.
2. Calls every `Demo.Resource` contribution's `useServe` (the contribution list is static, so the
   hook order is stable), and reads `Demo.Route`.
3. Once per mount (`useState` initialiser after the pack lands) runs
   `createBrowserServer({ serve, routes, unserved, onUnmatched })`. It disposes on unmount.
   - `serve` = pack serves + contributed serves. A key served twice throws, naming both.
   - `unserved(key)` = `DemoMissingError`.
   - `onUnmatched` = the shared unsupported response (§3) plus the deduped toast.
4. Renders `<TransportProvider transport={browserServerTransport(server)}><NotificationsProvider>`.

- **Toast dedupe** is per scope. While a "Not available in the demo" toast from this scope is
  live (sonner's default duration), further refusals do not toast. A scope-local timestamp, not
  a timer loop.
- **`TransportProvider`** moves to `primitives/networking/web/index.ts`, and `web/testing` stops
  re-exporting it (its comment promised this). Update the test imports (browser-server,
  live-state's `scoped-pipeline.test.tsx`, …).

### 3. Unsupported writes: a typed refusal, not a generic failure

Today a 409 from the browser server reaches `fetchEndpoint` as a plain `EndpointError`, which:
- emits to `endpointErrorSink`, so a report is filed on the **real** server;
- with `useEndpointMutation` and no `onError`, makes `MutationErrorWatcher` show "Request failed",
  which also POSTs a notification to the real server.

The fix is to make the refusal a type:
- **`infra/endpoints/core`**: `unsupportedEndpointResponse(method, path)`, the one spelling of
  `409 { reason: "unsupported", method, path }`, plus `isUnsupportedEndpointBody(body)`.
  browser-server's default `onUnmatched` uses it instead of its inline literal.
- **`infra/endpoints/web` `fetchEndpoint`**: that body throws
  `EndpointUnsupportedError extends EndpointError`, and skips the error sink. The host that
  refused already told the user.
- **`reports/mutation-errors`**: `MutationErrorWatcher` skips `EndpointUnsupportedError`.

The scope's `onUnmatched` returns `unsupportedEndpointResponse` and shows the toast. So the user
sees exactly one message, and nothing reaches the real server.

### 4. Contributions

- **config_v2/web** → `Demo.Resource({ id: "config-v2", useServe })`:
  - It reads `useRawContributions(ConfigV2.WebRegister)` for the full descriptors (`defaults`
    included), and derives each storePath with `storePathOf`.
  - It serves `config-v2.scopes` as every storePath → `[]`.
  - It serves `config-v2.values` with `({ path, scopeId })`:
    - an empty or absent scopeId returns `{ ...descriptor.defaults }`;
    - an unknown path or a scopeId throws (the scopes map lists none).
  - Both use `changes: "notified"`. A lazy plugin's registration arriving later re-runs the hook,
    and an effect calls `notify()`. The serve function reads the registrations through a ref, so
    the server is not rebuilt.
  - `conflicts` and `tiers` stay unserved, so they fail loudly if anything reads them.
- **conversations/hibernation/web** → `Demo.Route({ route: [markViewed.route, implement(markViewed, () => ({ kind: "not-hibernated" }))] })`.
  - **Prerequisite (first leak-ledger entry):** `markConversationViewed` calls the bare
    `fetchEndpoint`, so it would bypass the scope and write to the real server. Replace it with
    `useMarkConversationViewed()`, which is bound through `useFetchEndpoint()`, and update its one
    caller, `conversation-view.tsx:46`. Record the entry in the parent doc's §7 ledger table.

### Files

- **New:**
  - `framework/browser-server/plugins/demo/{package.json,CLAUDE.md,core/index.ts,core/internal/pack.ts,core/internal/pack.test.ts}`
  - `framework/browser-server/plugins/demo/plugins/scope/{package.json,CLAUDE.md,web/index.ts,web/slots.ts,web/components/demo-scope.tsx,web/__tests__/demo-scope.test.tsx}`
- **Edited:**
  - `primitives/networking/web/{index.ts,testing/index.ts}` (+ test imports)
  - `infra/endpoints/{core,web}`
  - `framework/browser-server/core/internal/browser-server.ts` (default `onUnmatched`)
  - `reports/plugins/mutation-errors/web/components/mutation-error-watcher.tsx`
  - `config_v2/web` (contribution)
  - `conversations/plugins/hibernation/web` (route, hook) and `conversation-view.tsx`
  - the parent doc's §7 table

## Verification

- `./singularity test plugins/framework/plugins/browser-server plugins/infra/plugins/endpoints plugins/primitives/plugins/live-state plugins/config_v2`
  - **`pack.test.ts`:** each builder answers its exact tuple; window limit slicing; `:rows`
    subsets; an unrecorded tuple → `DemoMissingError`; a schema mismatch → `DemoPackError`
    naming the key; `ago`.
  - **`demo-scope.test.tsx`** (jsdom, the real `NotificationsClient`):
    - a pack value and a pack collection render through `useLive`;
    - `useConfig(someDescriptor)` inside the scope returns its code defaults;
    - an unrecorded known key → `loader-failed`, and the contract-mismatch store stays empty;
    - `useMarkConversationViewed()` resolves `not-hibernated` through the contributed route;
    - two unsupported POSTs → `EndpointUnsupportedError` twice, one toast, and the error sink is
      not called;
    - a key served twice throws;
    - a page-pipeline subscription beside the scope sees no crosstalk.
- `./singularity build`, then smoke `http://<worktree>.localhost:9000`: a conversation still marks
  viewed on the real server through the migrated hook.
- `./singularity check` (boundaries, plugin docs, registry sync, type-check).

## Wrap-up

- Update the track card: tick "Demo data on top of it", and update Status and the `exposes` limit
  note.
- File the next main task (AppEmbed + the Agent Manager scenario and pack), with the page id and
  the track-instructions id.
