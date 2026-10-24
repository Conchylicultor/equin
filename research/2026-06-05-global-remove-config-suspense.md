# Remove React Suspense from config reads

## Context

Navigating the app flashes a full-screen loading spinner. The cause is commit
`210a49ef6` (2026-06-04, "suspend useConfig until config loads"), which made
`useConfig` suspend via `useSuspenseResource` so components stop flashing
**default** config values during boot (chiefly wrong color mode / model).

The fix traded a flash-of-defaults for a worse one. `useSuspenseResource`
deliberately omits `initialData`, so it throws on every uncached
`(path, scopeId)` query key (`live-state/web/use-resource.ts:176-181`).
`ThemeInjector` (a `Core.Root` component, **not** slot-rendered) reads config
with `scopeId = "app:<currentAppId>"`. On navigation the scopeId changes → new
uncached key → throw → bubbles past the per-slot Suspense boundaries to the
**app-level** `<Suspense fallback={<AppLoading/>}>` (`web-core/web/App.tsx:62`)
→ the whole screen blanks.

### Why we can remove suspense cleanly

Two structural facts (both verified in code):

1. **An unforked scope resolves to the global value.** `getConfig(descriptor,
   scopeId)` returns the *same* `base.values` object for any scope without an
   override (`config_v2/server/internal/registry.ts:303-317`). So the global
   value is the *correct* fallback during a scoped load — not
   `descriptor.defaults`, which was the original flash-of-defaults bug.
2. **Scoped config is read only by theme-engine** (ThemeInjector, the token
   sub-plugins, theme-customizer, theme-toggle — ~14 sites). Everything else
   reads global config (no scopeId).
3. **`useConfig` is the only suspender in the codebase** — no `React.lazy`, no
   other `useSuspenseResource` consumer. Removing it removes *all* suspense.

So: hydrate global config into the cache **before first paint** (kills the
flash-of-defaults that suspense was added for), and make `useConfig`
**non-suspending** with a global-value fallback (kills the navigation flash).

## Approach

### 1. Boot-hydrate global config before first paint

`configV2Resource.initialData` is `{}`, so an un-seeded `useResource` read
returns `{}` → fields destructure to `undefined` → the exact flash. Seeding is
therefore **load-bearing**, not an optimization.

- **Snapshot endpoint (config_v2).** Add `GET /api/config-v2/snapshot` returning
  `{ [path]: ConfigV2Values }` for every descriptor (global, no scopeId).
  Server is authoritative on the descriptor set → zero client/server path drift.
  - `config_v2/server/internal/resource.ts`: extract the resolve+redact block
    (lines 47-54) into `resolveRedactedConfig(descriptor, scopeId?)`; reuse it in
    the existing per-key loader. Add `getConfigSnapshot()` → `await registryReady`,
    map `getAllDescriptors()` through `resolveRedactedConfig` (global).
  - `config_v2/core/endpoints.ts` (new): `defineEndpoint` for the snapshot,
    `response: z.record(configV2ValuesSchema)` (response schema is required for
    `fetchEndpoint` to return data — see memory `fetchEndpoint needs response schema`).
  - `config_v2/server/internal/`: `implement(snapshotEndpoint, getConfigSnapshot)`;
    wire into `server/index.ts` `httpRoutes` (mirror existing fork/delete routes —
    see memory `Server plugin wiring`: live resources via `Resource.Declare`,
    endpoints via `implement` + route).

- **`hydrateResource` helper (live-state).** Add to
  `primitives/plugins/live-state/web/use-resource.ts` and export from the barrel:
  ```ts
  export function hydrateResource<T, P>(resource, params, value): void {
    getDefaultQueryClient().setQueryData(
      queryKeyFor(resource.key, params ?? {}),
      resource.schema.parse(value),
    );
  }
  ```
  Seeds the **same** private singleton client that `NotificationsProvider`
  (no `queryClient` prop) uses, via the **same** `queryKeyFor` consumers use.
  A pre-seeded `setQueryData` gives the entry a real `dataUpdatedAt`, so
  `useResource`'s `pending = (dataUpdatedAt === 0)` is immediately `false`
  (`initialData`/`initialDataUpdatedAt:0` are ignored once data exists). No
  schema-registry pitfall: seeding doesn't touch `NotificationsClient.schemas`
  (only `applyUpdate` reads it, and that only fires after a mounted
  `useResource` calls `observe`, which registers the schema first).

### 2. `Core.Boot` — async pre-paint readiness slot (framework)

App must hydrate config before render without `web-core` importing `config_v2`
(framework must not depend on a feature plugin). web-sdk's "No lifecycle hooks"
rule targets *per-phase reactive callbacks*; a one-shot pre-render readiness
task is `register`'s async sibling, not a lifecycle hook. We honor the rule's
intent by constraining the slot (see Risks).

- `web-sdk/core/slots.ts`: `Core.Boot = defineSlot<{ run: () => Promise<void> }>("core.boot")`.
- `web-core/web/App.tsx`: after `loadPlugins`, **before** `setState`/PluginProvider,
  enumerate boot contributions from the loaded plugins (mirror PluginProvider's
  `_slotId` flatMap in `context.tsx:53-69` — `useContributions` is unavailable
  pre-mount), and `await Promise.allSettled(tasks.map(t => t.run()))`. Log and
  skip failures (degrade to the non-suspending fallback); never let one task
  brick boot. Then `setState`.
- `config_v2/web/index.ts`: contribute one `Core.Boot` task that
  `fetchEndpoint(snapshot)` then `hydrateResource(configV2Resource, { path }, values)`
  per entry. Boot-task component/logic in `config_v2/web/internal/` (see memory
  `Components folder`).

### 3. Revert `useConfig` to non-suspending

`config_v2/web/internal/use-config.ts` — call all hooks unconditionally; branch
only on the returned value:
```ts
const forked = useScopeForked(opts?.scopeId);
const globalRes = useResource(configV2Resource, { path });          // pre-seeded → not pending
const scopedRes = useResource(
  configV2Resource,
  opts?.scopeId && forked ? { path, scopeId: opts.scopeId } : { path },
);
if (opts?.scopeId && forked && !scopedRes.pending) return scopedRes.data;
if (!globalRes.pending) return globalRes.data;   // correct value, no flash
return descriptor.defaults;                       // unreachable post-boot
```
Gating the scoped params on `forked` avoids a wasted scoped subscription for
unforked scopes (server would just return `base.values` anyway, and `notifyValues`
already fans base changes to unforked scopes). Drop the `useSuspenseResource` import.

### 4. Remove suspense entirely

- `web-core/web/App.tsx`: delete `Suspense` import, `AppLoading`, and the
  `<Suspense>` wrapper around `<RootRenderer/>`.
- Delete the `primitives/plugins/suspense-boundary/` plugin entirely
  (`web/index.ts`, `web/internal/suspense-middleware.tsx`, `package.json`,
  `CLAUDE.md`). slot-render still works — its middleware list is optional and the
  error-boundary middleware remains.
- Remove `useSuspenseResource` (+ `useSuspenseQuery` import) from
  `live-state/web/use-resource.ts` and the barrel; note in live-state CLAUDE.md
  that no Suspense boundary exists anymore, so a future suspending read needs its
  own boundary.

## Critical files

- `plugins/config_v2/web/internal/use-config.ts` — revert to non-suspending
- `plugins/config_v2/web/index.ts` — add `Core.Boot` contribution
- `plugins/config_v2/web/internal/` — boot task (fetch snapshot + hydrate)
- `plugins/config_v2/core/endpoints.ts` (new) — snapshot endpoint contract
- `plugins/config_v2/server/internal/resource.ts` — `resolveRedactedConfig`, `getConfigSnapshot`
- `plugins/config_v2/server/internal/` + `server/index.ts` — implement + route
- `plugins/primitives/plugins/live-state/web/use-resource.ts` + barrel — `hydrateResource`; drop `useSuspenseResource`
- `plugins/framework/plugins/web-sdk/core/slots.ts` — `Core.Boot` slot
- `plugins/framework/plugins/web-core/web/App.tsx` — await boot tasks; remove Suspense
- delete `plugins/primitives/plugins/suspense-boundary/`

## Reused utilities

- `getConfig` / `getAllDescriptors` / `isScopeForked` — `config_v2/server/internal/registry.ts`
- `useScopeForked` — `config_v2/web/internal/use-scope-forked.ts`
- `useResource` / `queryKeyFor` / `getDefaultQueryClient` — `live-state/web`
- `fetchEndpoint` / `defineEndpoint` / `implement` — `infra/plugins/endpoints`
- `configV2ValuesSchema`, `configV2Resource` — `config_v2/core`

## Risks / tradeoffs

- **Core.Boot brushes the "no lifecycle hooks" rule.** Mitigated by scope: one-shot,
  topo-ordered, pre-render, readiness-only; `allSettled` + log-and-skip so a failing
  or hung task degrades to the fallback instead of bricking boot. Documented as a
  sibling to `register`, not a general lifecycle.
- **Forked-scope hard reload shows one frame of global theme.** Snapshot is
  global-only; on hard reload of an app with a *forked* theme, `useConfig` shows
  the global value for ~1 frame until `useScopeForked` + the scoped value resolve.
  Strictly better than today's full blank, and only affects hard reload of forked
  apps. Accepted; an optional `?scopeId=` on the snapshot could remove it later.
- **Boot-seed failure → flash returns** for that boot. Self-heals within one WS
  round-trip; acceptable.

## Verification

1. `./equin build` — must pass `plugins-doc-in-sync` (deleted plugin, changed
   live-state exports, new endpoint, config_v2 `Core.Boot`), `plugin-boundaries`,
   eslint (`rules-of-hooks` on the unconditional hooks in `useConfig`;
   `no-bare-catch` on boot-task error handling), type-check. Confirm
   `web.generated.ts` no longer lists `suspense-boundary`.
2. **Cold boot**: one `GET /api/config-v2/snapshot` before first paint; ThemeInjector
   applies the correct theme immediately; no default flash, no `AppLoading` spinner.
3. **Navigate between (unforked) apps**: no full-screen blank — the headline fix.
   Verify with `e2e/screenshot.mjs` capturing before/after a nav click.
4. **Forked per-app theme**: fork a theme via the customizer, navigate (soft) — at
   most one frame of global then forked values; **hard reload** — same, never a blank.
5. **Liveness intact**: edit a config value (settings UI / disk) with the app open;
   confirm it updates live (WS `observe` path unchanged in `useResource`).
6. **Boot-task failure path**: force the snapshot endpoint to 500; app still boots
   (degraded: brief flash, then WS resolves), does not hang on null render.
