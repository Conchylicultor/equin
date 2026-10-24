# RenderSlot — Typed Rendering Primitive with Middleware Pipeline

## Context

Rendering slot contributions requires manual composition of error boundaries and reorder. Every host repeats the same boilerplate — `Reorder.useArea()` + `DndWrapper` + `ReorderItem` + `PluginErrorBoundary`. 24+ render sites miss error boundaries entirely. The goal: a standard rendering primitive with auto-applied middleware.

**Before:**
```tsx
const { items, DndWrapper, ReorderItem } = Reorder.useArea(Shell.Sidebar);
return (
  <DndWrapper>
    {items.map(item => (
      <ReorderItem key={item.id} item={item}>
        <PluginErrorBoundary slot="shell.sidebar" label={item.title}>
          <item.component />
        </PluginErrorBoundary>
      </ReorderItem>
    ))}
  </DndWrapper>
);
```

**After:**
```tsx
<Shell.Sidebar.Render>
  {(item) => <item.component />}
</Shell.Sidebar.Render>
```

The rendering primitive knows nothing about error boundaries or reorder — both register themselves as middleware.

## Key design decisions

### `RenderSlot` as a separate type from `Slot`

`Slot<P>` stays as-is in `plugin-core` — a pure data primitive. A new `RenderSlot<P>` wraps `Slot` and adds rendering capabilities. The two types serve different purposes:

- **`Slot<P>`** — data extension point. Used by pattern matchers (`ActiveData.Tag`), config registries (`Config.Spec`), enhancer chains (`Markdown.Enhancer`), pane registrations (`Pane.Register`). Consumed via `useContributions()` for custom logic.
- **`RenderSlot<P>`** — visual extension point. Used by sidebars, toolbars, panels, action bars. Consumed via `<slot.Render>` with auto-applied middleware.

This keeps `plugin-core` untouched — the rendering infrastructure, middleware registration, and the `RenderSlot` type all live in a plugin (`plugins/primitives/plugins/slot-render/`). The split is type-level: a slot owner picks `defineRenderSlot` instead of `defineSlot` when the slot renders visual contributions.

`RenderSlot<P>` extends `Slot<P>` — it *is* a `Slot`, so it works everywhere a `Slot` does. `useContributions()` remains available as an escape hatch for hosts that need full control.

### Mandatory `id` on `RenderSlot` contributions (not all contributions)

`RenderSlot<P>` intersects `P` with `{ id: string }` — every contribution to a render slot must supply a stable identifier. This:

- Gives every render slot automatic reorder support (stable persistence key)
- Provides stable React keys everywhere (no more numeric index keys)
- Eliminates the fallback heuristic chain (`id ?? _pluginId ?? index`)
- Mirrors what `Reorder.area()` already does today — intersecting `{ id: string }` into the slot's type

Pure `Slot<P>` contributions are unchanged — data slots don't need `id`. This avoids the large mechanical migration of adding `id` to every contribution in the codebase. Only contributions to render slots need it, and those already have `id` today (enforced by `Reorder.area()`).

`_pluginId` (auto-injected by PluginProvider) remains separate — it identifies *which plugin* contributed the item, not *which contribution* it is. A plugin contributing 3 charts to `Stats.Chart` has one `_pluginId` but 3 distinct `id` values.

### All render slots are reorderable

A `RenderSlot` renders a list of visual contributions sequentially — sidebar entries, toolbar buttons, panel sections. Any such list benefits from user reorder. Slots where reorder doesn't make sense (type dispatchers like `JsonlViewer.EventRenderer`, pattern matchers like `ActiveData.Tag`) are data slots — they stay as plain `Slot<P>`, not `RenderSlot`.

The type choice encodes the distinction:
- **`Slot<P>`** → data/dispatch → no rendering, no reorder
- **`RenderSlot<P>`** → visual list → always reorderable

Reorder always activates on every `RenderSlot`. The optional `reorder` config on `defineRenderSlot` customizes behavior (`getGroup`, `getLabel`, `enableGroups`) but never toggles it on/off:

```ts
// Custom reorder config — grouping, labels
Shell.Sidebar = defineRenderSlot<SidebarProps>("shell.sidebar", {
  reorder: { getLabel: (item) => item.title, enableGroups: true },
});

// No config — reorder still active, just with defaults (no grouping, _pluginName as label)
Stats.Chart = defineRenderSlot<ChartProps>("stats.chart");
```

Suppression rules:
- **Singletons** (`items.length < 2`): DnD UI hidden (no drag handles, no RestoreButton), but the subscription and rank sort still run — negligible cost, and the UI auto-enables when a second contribution appears
- **Edit mode off**: no drag handles, just the persisted rank order applied silently

This replaces `Reorder.area()` entirely for render slots. `Reorder.area()` + `Reorder.useArea()` remain available as escape hatches for slots that need the full `UseAreaResult` (grouped entries, spacers, custom DnD zones).

### Middleware pipeline lives entirely in plugin space

The middleware types, registration, and chaining logic live in `plugins/primitives/plugins/slot-render/`. Nothing touches `plugin-core`.

```
plugins/primitives/plugins/slot-render/
  web/
    index.ts              # exports defineRenderSlot, registerSlotMiddleware, types
    internal/
      types.ts            # SlotItemMiddleware, SlotListMiddleware
      registry.ts         # registerSlotItemMiddleware, registerSlotListMiddleware
      render-slot.tsx      # defineRenderSlot implementation, <Render> component
```

The `register` phase (web) is used for the first time to register middleware — this is a justified expansion of the pattern since middleware must be installed before first render, which is exactly what `register` is for.

### Clean `P` in the render callback, full metadata for middleware

Middleware receives the raw contribution (including `_pluginId`, `_pluginName`, `_pluginDescription`). The user's `children` callback receives clean `P & { id: string }` — underscore metadata is stripped before reaching the render function.

```tsx
// Middleware sees full metadata:
registerSlotItemMiddleware({
  priority: 100,
  Component: ({ contribution, children }) => (
    // contribution._pluginName available here
    <PluginErrorBoundary label={contribution._pluginName}>
      {children}
    </PluginErrorBoundary>
  ),
});

// User render function sees clean props:
<Shell.Sidebar.Render>
  {(item) => /* item is SidebarProps & { id: string }, no _pluginId */}
</Shell.Sidebar.Render>
```

## Design

### Types — `slot-render/web/internal/types.ts`

Two middleware types, registered during the `register` phase (before first render).

```ts
import type { Contribution } from "@core";

interface SlotItemMiddleware {
  priority: number;
  Component: ComponentType<{
    slotId: string;
    contribution: Contribution;
    children: ReactNode;
  }>;
}

interface SlotListMiddleware {
  priority: number;
  Component: ComponentType<{
    slotId: string;
    contributions: Contribution[];
    renderItem: (contribution: Contribution) => ReactNode;
  }>;
}
```

**Priority**: lower = outermost. Produces this nesting:

```
<DndWrapper>              ← reorder list (prio 0, always on for RenderSlot)
  <ReorderItem>           ← reorder item (prio 0)
    <PluginErrorBoundary> ← error boundary item (prio 100)
      {children(item)}    ← user render function
    </PluginErrorBoundary>
  </ReorderItem>
</DndWrapper>
```

### Registry — `slot-render/web/internal/registry.ts`

```ts
const itemMiddlewares: SlotItemMiddleware[] = [];
const listMiddlewares: SlotListMiddleware[] = [];

export function registerSlotItemMiddleware(m: SlotItemMiddleware): void {
  itemMiddlewares.push(m);
  itemMiddlewares.sort((a, b) => a.priority - b.priority);
}

export function registerSlotListMiddleware(m: SlotListMiddleware): void {
  listMiddlewares.push(m);
  listMiddlewares.sort((a, b) => a.priority - b.priority);
}

export function getSlotItemMiddlewares(): readonly SlotItemMiddleware[] {
  return itemMiddlewares;
}

export function getSlotListMiddlewares(): readonly SlotListMiddleware[] {
  return listMiddlewares;
}
```

### `RenderSlot<P>` — `slot-render/web/internal/render-slot.tsx`

```ts
import { defineSlot, type Slot } from "@core";
import type { ComponentType, ReactNode } from "react";

/** Reorder customization — all fields optional, reorder itself is always active. */
interface ReorderConfig<P> {
  getGroup?: (item: P) => string | null;
  getLabel?: (item: P) => string;       // default: contribution._pluginName
  enableGroups?: boolean;                // default: false
}

/** Config passed to defineRenderSlot. */
interface RenderSlotConfig<P> {
  /** Reorder customization. Reorder always activates; this fine-tunes it. */
  reorder?: ReorderConfig<P & { id: string }>;
  /** Label extraction for defineSlot's docLabel */
  docLabel?: (props: P & { id: string }) => string | undefined;
}

/** A render slot — visual extension point with auto-applied middleware. */
interface RenderSlot<P> extends Slot<P & { id: string }> {
  Render: ComponentType<RenderProps<P & { id: string }>>;
  /** Reorder customization. Always present (defaults to {}). Read by the reorder middleware. */
  readonly reorderConfig: ReorderConfig<P & { id: string }>;
}

interface RenderProps<P> {
  children?: (item: P) => ReactNode;
  /** Sub-area key for independent reorder storage on the same slot. */
  subId?: string;
}
```

Implementation inside `defineRenderSlot<P>(id, config?)`:

1. Calls `defineSlot<P & { id: string }>(id, { docLabel: config?.docLabel })` — the underlying data slot
2. Attaches `reorderConfig` from the config arg (read by the reorder list middleware at render time)
3. Attaches a `Render` component that:
   a. Reads raw contributions via `useContributions()` — gets `P & { id: string }` (already stripped of `_slotId`)
   b. Reads the *raw* contributions from context too, preserving `_pluginId`/`_pluginName` — needed by item middlewares
   c. Chains list middlewares: outermost receives `contributions` + `renderItem` callback. Only list middlewares whose preconditions are met activate (reorder checks `slot.reorderConfig`; error boundary is item-only, always active)
   d. For each item, nests item middlewares around the `children` render function. The item middleware receives the full `Contribution`; the inner `children(item)` receives clean `P & { id: string }`
   e. Key: `item.id` (mandatory, always stable)
   f. Default render (no `children`): `<item.component />`

```ts
export function defineRenderSlot<P>(
  id: string,
  config?: RenderSlotConfig<P>,
): RenderSlot<P> {
  const slot = defineSlot<P & { id: string }>(id, {
    docLabel: config?.docLabel,
  });

  const renderSlot = slot as unknown as RenderSlot<P>;
  renderSlot.reorderConfig = config?.reorder ?? {};

  renderSlot.Render = function SlotRender({ children, subId }: RenderProps<P & { id: string }>) {
    const items = slot.useContributions();
    const rawContributions = useRawContributions(id); // reads ctx.bySlot.get(id)

    // Build raw→clean lookup for middleware→render-callback boundary
    const rawByKey = useMemo(
      () => new Map(rawContributions.map((c) => [c.id as string, c])),
      [rawContributions],
    );

    const renderItem = useCallback(
      (contribution: Contribution) => {
        const clean = items.find((i) => i.id === (contribution.id as string));
        if (!clean) return null;

        // Nest item middlewares (outermost first by priority)
        let node: ReactNode = children
          ? children(clean)
          : (clean as any).component
            ? createElement((clean as any).component)
            : null;

        const itemMws = getSlotItemMiddlewares();
        for (let i = itemMws.length - 1; i >= 0; i--) {
          const Mw = itemMws[i]!.Component;
          const captured = node;
          node = <Mw slotId={id} contribution={contribution}>{captured}</Mw>;
        }
        return <Fragment key={clean.id}>{node}</Fragment>;
      },
      [items, children, id],
    );

    // Nest list middlewares (outermost first by priority)
    const listMws = getSlotListMiddlewares();
    let result: ReactNode = <>{rawContributions.map(renderItem)}</>;
    for (let i = listMws.length - 1; i >= 0; i--) {
      const Mw = listMws[i]!.Component;
      const captured = result;
      result = (
        <Mw
          slotId={id}
          contributions={rawContributions}
          renderItem={renderItem}
        >
          {captured}
        </Mw>
      );
    }
    return result;
  };

  return renderSlot;
}
```

Note: `useRawContributions(id)` is a thin internal hook that reads `PluginRuntimeContext.bySlot.get(id)` without stripping metadata. This could be exported from `@core` as an internal-use hook, or the render-slot plugin reads the context directly (it already depends on `@core` for `Slot`/`Contribution` types).

### Error boundary middleware

Registered via the error-boundary plugin's `register` array:

```ts
import { registerSlotItemMiddleware } from "@plugins/primitives/plugins/slot-render/web";

// In register array:
{
  register() {
    registerSlotItemMiddleware({
      priority: 100,
      Component: ({ slotId, contribution, children }) => (
        <PluginErrorBoundary slot={slotId} label={contribution._pluginName}>
          {children}
        </PluginErrorBoundary>
      ),
    });
  },
}
```

### Reorder middleware

Registered via the reorder plugin's `register` array. Two middlewares:

**List middleware (priority 0):**
- Reads `reorderConfig` via a module-level `Map<slotId, ReorderConfig>` populated at `defineRenderSlot` time. Only activates for slots in this registry (i.e. render slots, not plain `Slot`)
- `useResource(reorderPrefsResource)` for persisted ranks, sorts by rank, filters hidden
- Wraps in `<DndContext>` + `<ReorderAreaContext.Provider>`
- Reads `reorderConfig.getGroup`/`getLabel`/`enableGroups` (all optional, sensible defaults)
- **Suppresses DnD UI** (RestoreButton, drag sensors) when `items.length < 2`
- Reads `subId` from `RenderProps` (threaded through as a React context set by `SlotRender`)
- Split into outer + inner component to avoid conditional hooks

**Item middleware (priority 0):**
- If edit mode off or `item.excludeFromReorder` or singleton list: passthrough
- If edit mode on: `<ReorderItemActive item={item}>{children}</ReorderItemActive>`

```ts
import { registerSlotListMiddleware, registerSlotItemMiddleware } from "@plugins/primitives/plugins/slot-render/web";

// In register array:
{
  register() {
    registerSlotListMiddleware({
      priority: 0,
      Component: ReorderListMiddleware,
    });
    registerSlotItemMiddleware({
      priority: 0,
      Component: ReorderItemMiddleware,
    });
  },
}
```

### Reorder config registry

`defineRenderSlot` stores its `reorderConfig` in a module-level `Map<string, ReorderConfig>` inside the slot-render plugin, keyed by slot id. Every render slot has an entry (defaulting to `{}`). The reorder list middleware reads this map at render time — presence in the map means "this is a render slot, activate reorder"; the config values customize behavior.

This replaces the current `area.ts` registry (`Map<slotId, ReorderConfig>`). The difference: the config is declared at slot definition time (in `defineRenderSlot`), not as a separate `Reorder.area()` wrapper call. One declaration site instead of two.

### Hooks safety

The list middleware's `Component` uses hooks (`useResource`, `useEditMode`, `useState`). This works because:
- Each `Component` is a real React component rendered via JSX (`<Mw .../>`) — hooks are called during React's reconciliation
- The render function in `SlotRender` creates JSX elements, not hook calls
- Middleware count is stable (registered once during `register` phase before first render)

### Dependency graph

```
plugin-core (unchanged)
  ↑
slot-render (defineRenderSlot, middleware registry)
  ↑                    ↑
error-boundary         reorder
(item middleware)       (list + item middleware)
```

`slot-render` depends on `@core` for `Slot`, `Contribution`, `PluginRuntimeContext`. `error-boundary` and `reorder` depend on `slot-render` for `registerSlotItemMiddleware`/`registerSlotListMiddleware`. This is a clean DAG with no cycles.

Slot owners (shell, conversations, etc.) import `defineRenderSlot` from `@plugins/primitives/plugins/slot-render/web` instead of `defineSlot` from `@core`. They also import `Reorder.area` less — the reorder config moves into `defineRenderSlot`.

## Migration path

### Phase 1: Ship the primitive (no migrations)

Steps 1–5 below. `defineRenderSlot` exists alongside `defineSlot`. No existing code changes. Middleware registered but no slots use `RenderSlot` yet.

### Phase 2: Migrate slot by slot

Each slot migration is independent and can be a separate commit:
1. Change `defineSlot` → `defineRenderSlot` in the slot owner
2. Remove `Reorder.area()` wrapper, move config into `defineRenderSlot({ reorder: ... })`
3. Replace `useArea()` + manual render with `<Slot.Render>`
4. Remove `PluginErrorBoundary` wrapper at the render site
5. Verify the slot renders correctly

This avoids the "add `id` to all contributions at once" big-bang. Each render slot already has `id` (from `Reorder.area()`). New render slots get `id` automatically from the type.

### Phase 3: Clean up legacy API

Once all visual slots are migrated:
- `Reorder.area()` becomes dead code for render slots (may stay for non-render custom reorder)
- `Reorder.useArea()` stays as escape hatch for complex hosts (grouped entries, spacers, multi-zone DnD)

## Implementation steps

### Step 1: Create `plugins/primitives/plugins/slot-render/web/`

New plugin with:
- `internal/types.ts` — `SlotItemMiddleware`, `SlotListMiddleware`
- `internal/registry.ts` — `registerSlotItemMiddleware`, `registerSlotListMiddleware`, getters
- `internal/render-slot.tsx` — `defineRenderSlot`, the `<Render>` component, reorder config registry
- `internal/use-raw-contributions.ts` — thin hook reading `PluginRuntimeContext.bySlot.get(id)` without stripping metadata
- `index.ts` — barrel exporting `defineRenderSlot`, `registerSlotItemMiddleware`, `registerSlotListMiddleware`, `RenderSlot`, `RenderSlotConfig`

### Step 2: Error boundary middleware registration

Add a `Registration` to the error-boundary plugin's `register` array. The registration calls `registerSlotItemMiddleware` with the `PluginErrorBoundary` wrapper. Add `dependsOn: [slotRenderPlugin]` so the middleware registry exists before the error-boundary's `register` fires.

### Step 3: Reorder middleware

New file `plugins/reorder/web/internal/render-middleware.tsx` — list + item middleware components. Extract sorting/filtering/DnD logic from `use-area.tsx` into shared utilities both `render-middleware.tsx` and `use-area.tsx` can use.

Add `Registration` to reorder plugin's `register` array. Add `dependsOn: [slotRenderPlugin]`.

### Step 4: Pilot migration — `Core.Root`

Migrate `Core.Root` from `defineSlot` to `defineRenderSlot` (no reorder config — it's a single-item slot). Migrate `web/src/App.tsx`:

```tsx
// Before
const roots = Core.Root.useContributions();
return roots.map((r, i) => (
  <PluginErrorBoundary key={i} slot="core.root">
    <r.component />
  </PluginErrorBoundary>
));

// After
return <Core.Root.Render />;
```

### Step 5: Migrate visual slots incrementally

One slot per commit. Priority order:
1. `Shell.Sidebar`, `Shell.Toolbar` — highest usage, biggest boilerplate wins
2. `Conversation.PromptBar`, `Conversation.AbovePromptInput`, `Conversation.ActionBar`
3. `Apps.App`
4. `Stats.Chart`, `Debug.Item`, `Auth.Provider`
5. Remaining visual slots

### Step 6: Unit tests

Test the middleware pipeline in isolation:
- Priority ordering (lower = outermost)
- List middleware chaining (multiple list middlewares compose)
- Item middleware nesting
- Passthrough when no middleware registered
- Reorder middleware activates only for slots with reorder config
- Error boundary catches per-item (one crash doesn't take down siblings)

## Files

| File | Change |
|------|--------|
| `plugins/primitives/plugins/slot-render/web/internal/types.ts` | **New** — middleware types |
| `plugins/primitives/plugins/slot-render/web/internal/registry.ts` | **New** — middleware registration |
| `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` | **New** — `defineRenderSlot`, `<Render>`, reorder config registry |
| `plugins/primitives/plugins/slot-render/web/internal/use-raw-contributions.ts` | **New** — raw context read hook |
| `plugins/primitives/plugins/slot-render/web/index.ts` | **New** — barrel |
| `plugins/primitives/plugins/slot-render/package.json` | **New** — plugin manifest |
| `plugins/primitives/plugins/error-boundary/web/index.ts` | Add `register` with item middleware |
| `plugins/reorder/web/internal/render-middleware.tsx` | **New** — list + item middleware components |
| `plugins/reorder/web/index.ts` | Add `register` with both middlewares |
| `plugin-core/slots.ts` | Move `Core.Root` to `defineRenderSlot` (step 4) |
| `web/src/App.tsx` | Migrate to `<Core.Root.Render />` (step 4) |
| Per-slot files | Incremental migration (step 5) |

## What stays unchanged

- **`plugin-core/`** — no changes to types, slots, commands, or context
- **`Slot<P>`** — stays as pure data primitive, no `id` requirement added
- **`useContributions()`** — unchanged, still available on both `Slot` and `RenderSlot`
- **`Reorder.area()` + `Reorder.useArea()`** — stay as escape hatches for complex hosts needing full `UseAreaResult` (grouped entries, spacers, custom DnD zones)

## Open questions

1. **`useRawContributions` access**: The render-slot plugin needs to read `PluginRuntimeContext.bySlot.get(id)` without stripping metadata. Options: (a) export a `useRawContributions(slotId)` hook from `@core`, (b) the plugin reads the context directly via `useContext(PluginRuntimeContext)`. Option (b) is simpler but couples to the context shape; (a) is cleaner but adds to `@core`'s surface. Leaning toward (b) since `PluginRuntimeContext` is already exported from `@core`.

2. **`subId` threading**: The reorder list middleware needs `subId` from `<Slot.Render subId="foo">`. The current design threads it via React context set by the `SlotRender` component. Alternative: the list middleware reads it from props if `SlotRender` passes it through. Either works; context is simpler since it doesn't require changing the list middleware's `Component` props per-consumer.

## Verification

1. `./equin build` succeeds (TypeScript catches type mismatches)
2. App renders at `http://<worktree>.localhost:9000`
3. Crash a Core.Root contribution → error banner with Fix button appears (middleware active)
4. Edit mode → drag handles appear on multi-item render slots, not on singletons
5. Reorder, hide, restore all work on migrated slots
7. `./equin check` passes
8. Screenshot comparison before/after for each migrated slot
