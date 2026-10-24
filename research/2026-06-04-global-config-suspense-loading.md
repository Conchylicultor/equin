# config_v2: surface loading via Suspense instead of default values

## Context

A `react-boundary` crash was reported on worktrees (but effectively never on `main`):

```
TypeError: Cannot read properties of undefined (reading 'opus-4-8')
  at useVisibleModels → SELECTABLE_MODELS.filter((id) => visibleModels[id] !== false)
  slot: shell.sidebar (Conversations)
```

Root cause is a **config-registry boot race**, not stale builds (the report's 3 hits land in one ~8 ms window — a transient, not a persistent broken bundle):

- The server binds its socket and serves `/ws/notifications` + `/api/resources/*` **before** `onReady` runs (intentional, so the gateway detects readiness — `server-core/bin/index.ts:179` vs `:233`).
- `config_v2`'s `initRegistry()` (registers descriptor paths + sets `configGetter`) runs inside `onReady` (`config_v2/server/index.ts:25-28`).
- A client that subscribes during that window hits the resource loader's `if (!descriptor || !configGetter) return {}` (`config_v2/server/internal/resource.ts:26-27`) and receives an **empty config object**. Nothing ever re-notifies it (no post-init notify; `notify()` only fires on file-change/`setConfig`), so `{}` sticks.
- `useConfig` returns `result.data` once non-pending (`config_v2/web/internal/use-config.ts:35`), so consumers destructure `visibleModels`/`defaultModel`/`templates`/… → `undefined` → first dereference crashes the slot.

The current `useConfig` masks the *pending* phase by returning `descriptor.defaults` (`use-config.ts:34`). Decision (confirmed with user): **while config is not loaded we should not fall back to defaults — we should indicate the app is loading, via React Suspense.** Consumers keep destructuring values unchanged.

## Design

Two complementary fixes. Neither alone is sufficient:

- **Server** makes "pending" always resolve to *valid* data (never `{}`), so suspense can't resolve into a broken payload.
- **Client** suspends while pending (shows loading) instead of returning defaults.

### 1. Server — make the config loader ready-aware (eliminates the `{}` class)

The structural defect is that the loader emits a structurally-invalid sentinel (`{}`) that is indistinguishable from real data. Fix: the loader **awaits registry readiness** before resolving. Both delivery paths run the same loader via `timedLoad` (WS sub-ack `resources.ts:449`, HTTP GET `resources.ts:516`), so awaiting blocks both and the first push/response is already correct.

`plugins/config_v2/server/internal/registry.ts`:
```ts
let resolveRegistryReady!: () => void;
const registryReady = new Promise<void>((r) => { resolveRegistryReady = r; });
export const whenRegistryReady = () => registryReady;

export async function initRegistry(): Promise<void> {
  // ... existing setConfigGetter / registerDescriptorPath / buildEntry loop ...
  resolveRegistryReady();   // last line
}
```

`plugins/config_v2/server/internal/resource.ts` (`configV2ServerResource.loader`, make `async`):
```ts
loader: async ({ path, scopeId }) => {
  await whenRegistryReady();
  const descriptor = descriptorByPath.get(path);
  if (!descriptor || !configGetter) {
    // After readiness this is a genuine bug (unknown path) — fail loudly.
    throw new Error(`[config-v2] no descriptor registered for "${path}"`);
  }
  // ... unchanged redaction logic ...
}
```

Effect: early subscribers simply wait (sub-ack delayed sub-second until `initRegistry` completes), then get fully-valid config. No `{}` is ever cached, so no post-init `notify()` is needed and no client-side schema re-validation is needed. (Optionally apply the same `await whenRegistryReady()` to the `tiers` loader at `resource.ts:124` for consistency; lower priority — only the settings UI reads it.)

### 2. Client — a suspending resource hook used by `useConfig`

Key constraint discovered: a component that suspends never commits its `useEffect`, so the WS `observe()` subscription wouldn't fire — a naive "throw while pending" hangs forever. The fix is to drive the initial fetch *imperatively* during suspense via TanStack Query's suspense path (which runs `queryFn` = the HTTP GET, now ready-aware) while keeping the WS `observe()` effect for live updates after mount.

`useResource` today seeds `initialData: {}` + `initialDataUpdatedAt: 0` (`use-resource.ts:116-118`), which forces `isPending: false`, so `useSuspenseQuery` would *not* suspend. Therefore add a **separate** suspending hook (additive — leaves all 88 `useResource` callers untouched) in `plugins/primitives/plugins/live-state/web/use-resource.ts`:

```ts
export function useSuspenseResource<T, P extends ResourceParams = ResourceParams>(
  resource: ResourceDescriptor<T, P>,
  params?: P,
): T {
  const notifications = useContext(NotificationsContext);
  if (!notifications) throw new Error("useSuspenseResource must be inside NotificationsProvider");
  const p = (params ?? {}) as ResourceParams;

  // Same refcount observe/unobserve as useResource — commits after suspense resolves,
  // then keeps the cache live via WS setQueryData.
  useEffect(() => {
    notifications.observe(resource.key, p, resource.origin, resource.schema);
    return () => notifications.unobserve(resource.key, p, resource.origin);
  }, [notifications, resource.key, resource.origin, resource.schema, JSON.stringify(p)]);

  const q = useSuspenseQuery({
    queryKey: queryKeyFor(resource.key, p),
    queryFn: async (): Promise<T> => { /* identical HTTP GET + schema.parse to useResource */ },
    // NO initialData → suspends until queryFn (ready-aware HTTP GET) or WS sub-ack provides data.
  });
  return q.data;
}
```

`useSuspenseQuery` is available (`@tanstack/react-query@5.99.0`) and unused elsewhere — this is the first Suspense in the runtime. The global `staleTime: Infinity` default satisfies the suspense-timer clamp.

`plugins/config_v2/web/internal/use-config.ts` — drop the pending/defaults branch, keep the existing missing-web-registration throw (dev error, line 27):
```ts
const data = useSuspenseResource(
  configV2Resource,
  opts?.scopeId ? { path, scopeId: opts.scopeId } : { path },
);
return data as ConfigValues<F>;
```
All ~30 `useConfig` call sites are unchanged — they suspend transparently and destructure guaranteed-complete values.

### 3. Suspense boundaries

- **App-level (primary — "the app is loading"):** wrap `<RootRenderer />` in `plugins/framework/plugins/web-core/web/App.tsx:51` with `<Suspense fallback={<AppLoading/>}>`. On first boot, config consumers across the tree suspend together → one clean loading screen until `initRegistry` resolves. After first load, base-scope config is cached → no re-suspend. Fallback = a centered `Spinner` (`@plugins/primitives/plugins/spinner/web`); a tiny local `AppLoading` component in web-core.
- **Slot-level (containment):** add a Suspense item-middleware mirroring the existing error-boundary middleware, so a slot that mounts later with not-yet-cached (e.g. app-scoped theme) config shows a local spinner instead of re-blanking the whole app. Register the same way as `error-boundary/web/index.ts:17-22` via `registerSlotItemMiddleware` (priority just inside the error boundary), wrapping `children` in `<Suspense fallback={<Spinner/>}>`. This reuses the single canonical wrap site `applyItemMiddlewares` (`slot-render/web/internal/render-slot.tsx:37-53`).

## Critical files

| File | Change |
|---|---|
| `plugins/config_v2/server/internal/registry.ts` | add `registryReady` promise + `whenRegistryReady()`; resolve at end of `initRegistry()` |
| `plugins/config_v2/server/internal/resource.ts` | `configV2ServerResource.loader` → `async`, `await whenRegistryReady()`, throw on unknown path post-readiness (optionally tiers loader too) |
| `plugins/primitives/plugins/live-state/web/use-resource.ts` | add additive `useSuspenseResource` (uses `useSuspenseQuery`, no `initialData`, keeps observe effect) |
| `plugins/primitives/plugins/live-state/web/index.ts` | export `useSuspenseResource` |
| `plugins/config_v2/web/internal/use-config.ts` | use `useSuspenseResource`; remove pending→defaults fallback; keep registration throw |
| `plugins/framework/plugins/web-core/web/App.tsx` | wrap `RootRenderer` in app-level `<Suspense>` + small `AppLoading` fallback |
| `plugins/primitives/plugins/slot-render/web` (+ a small middleware module) | register a Suspense item-middleware reusing `applyItemMiddlewares` |

## Reuse

- `Spinner` — `@plugins/primitives/plugins/spinner/web`.
- `registerSlotItemMiddleware` + `SlotItemMiddleware` — `slot-render` (same pattern as `error-boundary/web/index.ts:17-22`).
- Existing HTTP-GET + `schema.parse` queryFn body — copy from `use-resource.ts:105-113`.
- `descriptor.schema` (`buildFieldsSchema`) — already validates field presence if ever needed for defense.

## Verification

1. `./equin build` from the worktree; open `http://<worktree>.localhost:9000`.
2. **Boot race repro:** restart the server (`./equin build`) and immediately reload the page. Before: intermittent `opus-4-8` crash in the Conversations sidebar / blank slot. After: brief app-level loading spinner, then the sidebar + LaunchControl render with the model dropdown populated — no crash.
3. Scripted check with `e2e/screenshot.mjs --url http://<worktree>.localhost:9000/ --click "Conversations"` to confirm the launch dropdown lists models and the slot renders.
4. Confirm no regression for other config consumers: open Settings (config_v2 settings pane), theme toggle, stats/commits filters — all read their config and render.
5. `./equin check` (eslint: `no-floating-promises` on the new async loader; boundary checker for the new export).
6. Confirm `useResource`'s 88 existing callers are untouched (only additive `useSuspenseResource` added).
