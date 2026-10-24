# Implementation Plan: RenderSlot Primitive

## Context

Rendering slot contributions requires manual composition of error boundaries and reorder. Every host repeats `Reorder.useArea()` + `DndWrapper` + `ReorderItem` + `PluginErrorBoundary`. 24+ render sites miss error boundaries entirely. The design doc (`research/2026-05-11-plugin-core-slot-render.md`) introduces a `RenderSlot<P>` type with a middleware pipeline. This plan implements it.

## Approach

Ship the `slot-render` plugin with `defineRenderSlot`, register error-boundary and a **dummy reorder middleware** (sort + hidden filter only — no DnD UI), then pilot-migrate `Conversation.ActionBar`. The existing `Reorder.useArea()` stays fully functional for consumers that need DnD interaction. The full reorder middleware (DnD, groups, spacers) is a future phase.

Core.Root is deferred — it would require moving out of `plugin-core` (circular import) and adding `id` to 8 contribution sites. Not worth it for the pilot.

## Step 1: Create `plugins/primitives/plugins/slot-render/`

### `package.json`
```json
{
  "name": "@singularity/plugin-primitives-slot-render",
  "private": true,
  "version": "0.0.1"
}
```

### `web/internal/types.ts`

```ts
import type { Contribution } from "@core";
import type { ComponentType, ReactNode } from "react";

export interface ReorderConfig<P> {
  getGroup?: (item: P) => string | null;
  getLabel?: (item: P) => string;
  enableGroups?: boolean;
}

export interface SlotItemMiddleware {
  priority: number;
  Component: ComponentType<{
    slotId: string;
    contribution: Contribution;
    children: ReactNode;
  }>;
}

export interface SlotListMiddleware {
  priority: number;
  Component: ComponentType<{
    slotId: string;
    contributions: Contribution[];
    renderItem: (contribution: Contribution) => ReactNode;
    children: ReactNode;
  }>;
}
```

### `web/internal/registry.ts`

Module-level arrays for middlewares (sorted by priority on insert) and a `Map<slotId, ReorderConfig>` for render-slot configs.

```ts
// Middleware registration
export function registerSlotItemMiddleware(m: SlotItemMiddleware): void
export function registerSlotListMiddleware(m: SlotListMiddleware): void
export function getSlotItemMiddlewares(): readonly SlotItemMiddleware[]
export function getSlotListMiddlewares(): readonly SlotListMiddleware[]

// Render slot config registry (populated by defineRenderSlot, read by reorder middleware)
export function registerRenderSlotConfig(slotId: string, config: ReorderConfig<unknown>): void
export function getRenderSlotConfig(slotId: string): ReorderConfig<unknown> | undefined
export function isRenderSlot(slotId: string): boolean  // checks if slotId is in the config map
```

Every `defineRenderSlot` call registers its config (even `{}` by default). Presence in the map = "this is a render slot."

### `web/internal/render-slot.tsx`

Core implementation: `defineRenderSlot` + the `<Render>` component.

```ts
export interface RenderSlot<P> extends Slot<P & { id: string }> {
  Render: ComponentType<RenderProps<P & { id: string }>>;
  readonly reorderConfig: ReorderConfig<P & { id: string }>;
}

interface RenderProps<P> {
  children?: (item: P) => ReactNode;
  subId?: string;
}
```

`defineRenderSlot<P>(id, config?)`:
1. Calls `defineSlot<P & { id: string }>(id, { docLabel: config?.docLabel })`
2. Sets `renderSlot.reorderConfig = config?.reorder ?? {}`
3. Calls `registerRenderSlotConfig(id, renderSlot.reorderConfig)`
4. Creates the `Render` component

**`<Render>` implementation**:
- Reads raw contributions via `useContext(PluginRuntimeContext)` → `ctx.bySlot.get(id)` (preserving `_pluginId`, `_pluginName`, `_pluginDescription`)
- Reads clean contributions via `slot.useContributions()` (stripped of `_slotId`)
- Builds `Map<string, CleanItem>` from clean items keyed by `id` for O(1) lookup
- Sets `subId` into `RenderSlotSubIdContext` (React context, exported)
- Defines `renderItem(contribution: Contribution) → ReactNode`:
  - Looks up clean `P & { id }` from the map
  - Nests item middlewares (outermost first by priority):
    ```
    for (let i = mws.length - 1; i >= 0; i--)
      node = <Mw slotId={id} contribution={raw}>{node}</Mw>
    ```
  - Innermost: `children ? children(clean) : <clean.component />`
  - Returns `<Fragment key={clean.id}>{wrapped}</Fragment>`
- Chains list middlewares (outermost first by priority):
  - Default (innermost): `<>{rawContributions.map(renderItem)}</>`
  - Each middleware wraps this, receiving `contributions`, `renderItem`, and `children` (the default output)

**`RenderSlotSubIdContext`**: `createContext<string | undefined>(undefined)`. Exported. The reorder middleware reads it to namespace the storage key.

### `web/index.ts` — Barrel + PluginDefinition

```ts
export { defineRenderSlot, RenderSlotSubIdContext } from "./internal/render-slot";
export type { RenderSlot } from "./internal/render-slot";
export type { ReorderConfig, SlotItemMiddleware, SlotListMiddleware } from "./internal/types";
export { registerSlotItemMiddleware, registerSlotListMiddleware, isRenderSlot, getRenderSlotConfig } from "./internal/registry";

export default {
  id: "slot-render",
  name: "Slot Render",
  description: "Typed rendering primitive for visual slots with auto-applied middleware (error boundaries, reorder).",
  loadBearing: true,
  contributions: [],
} satisfies PluginDefinition;
```

No `register` array — this plugin provides the infrastructure, consumers register middleware.

## Step 2: Error boundary middleware

**New file: `plugins/primitives/plugins/error-boundary/web/internal/error-boundary-middleware.tsx`**

Stable component reference (not inline arrow) to prevent React remounts:

```tsx
export function ErrorBoundaryMiddleware({ slotId, contribution, children }: {
  slotId: string; contribution: Contribution; children: ReactNode;
}) {
  return (
    <PluginErrorBoundary slot={slotId} label={contribution._pluginName}>
      {children}
    </PluginErrorBoundary>
  );
}
```

**Modified: `plugins/primitives/plugins/error-boundary/web/index.ts`**

Add `dependsOn` and `register`:

```ts
import slotRenderPlugin, { registerSlotItemMiddleware } from "@plugins/primitives/plugins/slot-render/web";
import { ErrorBoundaryMiddleware } from "./internal/error-boundary-middleware";

export default {
  id: "error-boundary",
  // ... existing fields ...
  dependsOn: [slotRenderPlugin],
  register: [{
    register() {
      registerSlotItemMiddleware({
        priority: 100,
        Component: ErrorBoundaryMiddleware,
      });
    },
  }],
  contributions: [],
} satisfies PluginDefinition;
```

First web plugin to use `register` + `dependsOn`. The existing `runRegisterPhase` in `context.tsx` topo-sorts by `dependsOn` — ensures `slot-render` module is loaded before error-boundary's `register()` fires.

## Step 3: Dummy reorder middleware

**New file: `plugins/reorder/web/internal/render-middleware.tsx`**

A **sort-and-filter-only** list middleware. No DnD UI, no drag handles, no RestoreButton. Reads persisted ranks from `reorderPrefsResource` and applies them. Items hidden via the existing edit-mode UI stay hidden.

```tsx
export function ReorderSortMiddleware({ slotId, contributions, renderItem, children }: Props) {
  // Only activate for render slots
  if (!isRenderSlot(slotId)) return <>{children}</>;

  const subId = useContext(RenderSlotSubIdContext);
  const storageId = subId ? `${slotId}:${subId}` : slotId;
  const { data: rankMap } = useResource(reorderPrefsResource, { slotId: storageId });

  const sorted = useMemo(() => {
    const visible: Contribution[] = [];
    for (const c of contributions) {
      const id = c.id as string;
      if (rankMap[id]?.hidden) continue; // skip hidden
      visible.push(c);
    }
    // Sort by rank (ranked items first, then natural order)
    return visible
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        const ar = rankMap[a.c.id as string]?.rank ?? null;
        const br = rankMap[b.c.id as string]?.rank ?? null;
        if (ar && br) return Rank.compare(ar, br);
        if (ar) return -1;
        if (br) return 1;
        return a.i - b.i;
      })
      .map(r => r.c);
  }, [contributions, rankMap]);

  return <>{sorted.map(c => renderItem(c))}</>;
}
```

~40 lines. No DnD, no groups, no spacers, no RestoreButton. Users can still reorder via the existing `Reorder.useArea()` path in edit mode — the persisted ranks from that flow will be picked up by this middleware automatically.

**Modified: `plugins/reorder/web/index.ts`**

Add `dependsOn` and `register`:

```ts
import slotRenderPlugin, { registerSlotListMiddleware } from "@plugins/primitives/plugins/slot-render/web";
import { ReorderSortMiddleware } from "./internal/render-middleware";

// ... existing exports ...

dependsOn: [slotRenderPlugin],
register: [{
  register() {
    registerSlotListMiddleware({
      priority: 0,
      Component: ReorderSortMiddleware,
    });
  },
}],
```

No item middleware needed yet — item middleware would add drag handles, which is deferred.

## Step 4: Pilot migration — `Conversation.ActionBar`

**`plugins/conversations/plugins/conversation-view/plugins/action-bar/web/slots.ts`**

Before:
```ts
import { defineSlot } from "@core";
import { Reorder } from "@plugins/reorder/web";
export const Conversation = {
  ActionBar: Reorder.area(defineSlot<{ component: ComponentType }>("conversation.action-bar")),
};
```

After:
```ts
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
export const Conversation = {
  ActionBar: defineRenderSlot<{ component: ComponentType }>("conversation.action-bar"),
};
```

Type: contributors pass `{ id: string, component: ComponentType }` — same as before (`Reorder.area` already required `id`).

**`plugins/conversations/plugins/conversation-view/plugins/action-bar/web/components/action-bar.tsx`**

Before (26 lines with Reorder + PluginErrorBoundary boilerplate):
```tsx
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { Reorder } from "@plugins/reorder/web";
import { Conversation } from "../slots";

export function ActionBarView() {
  const { items, DndWrapper, ReorderItem } = Reorder.useArea(Conversation.ActionBar);
  if (items.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      <DndWrapper>
        {items.map((item) => {
          const Component = item.component;
          return (
            <ReorderItem key={item.id} item={item}>
              <PluginErrorBoundary slot={Conversation.ActionBar.id}>
                <Component />
              </PluginErrorBoundary>
            </ReorderItem>
          );
        })}
      </DndWrapper>
    </div>
  );
}
```

After:
```tsx
import { Conversation } from "../slots";

export function ActionBarView() {
  const items = Conversation.ActionBar.useContributions();
  if (items.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      <Conversation.ActionBar.Render>
        {(item) => <item.component />}
      </Conversation.ActionBar.Render>
    </div>
  );
}
```

`useContributions()` kept for the empty check. Imports of `PluginErrorBoundary` and `Reorder` removed.

**Note**: DnD interaction is temporarily lost on this slot (dummy middleware). Acceptable — ActionBar rarely needs reorder. When the full reorder middleware lands, it'll work automatically.

## What stays unchanged

- **`plugin-core/`** — zero changes
- **`Slot<P>`** — untouched, no `id` requirement
- **`Reorder.area()` + `Reorder.useArea()`** — fully functional, used by all non-migrated slots
- **`Core.Root`** — stays as `defineSlot` in `plugin-core/slots.ts`, `App.tsx` unchanged
- All complex consumers (`app-shell-layout.tsx`, `conversation-view.tsx` prompt bar, `apps-layout.tsx`)

## Files

| File | Change |
|------|--------|
| `plugins/primitives/plugins/slot-render/package.json` | **New** |
| `plugins/primitives/plugins/slot-render/web/internal/types.ts` | **New** — middleware + config types |
| `plugins/primitives/plugins/slot-render/web/internal/registry.ts` | **New** — middleware + config registration |
| `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` | **New** — `defineRenderSlot`, `<Render>`, `RenderSlotSubIdContext` |
| `plugins/primitives/plugins/slot-render/web/index.ts` | **New** — barrel + PluginDefinition |
| `plugins/primitives/plugins/error-boundary/web/internal/error-boundary-middleware.tsx` | **New** — stable component ref |
| `plugins/primitives/plugins/error-boundary/web/index.ts` | Add `dependsOn`, `register` |
| `plugins/reorder/web/internal/render-middleware.tsx` | **New** — sort-only list middleware (~40 lines) |
| `plugins/reorder/web/index.ts` | Add `dependsOn`, `register` |
| `plugins/conversations/plugins/conversation-view/plugins/action-bar/web/slots.ts` | `Reorder.area(defineSlot(...))` → `defineRenderSlot(...)` |
| `plugins/conversations/plugins/conversation-view/plugins/action-bar/web/components/action-bar.tsx` | Remove boilerplate |

## Verification

1. `./equin build` succeeds
2. App renders at `http://att-1778491794-dh7c.localhost:9000`
3. Open a conversation → action bar buttons render correctly
4. Crash an ActionBar contribution → error banner with Fix button appears, siblings still render
5. Existing reorder (edit mode, drag handles) still works on non-migrated slots (Shell.Sidebar, etc.)
6. ActionBar respects any previously persisted rank order (from prior reorder sessions)
7. `./equin check` passes
8. Screenshot before/after comparison
