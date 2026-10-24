# Extract detail-sections primitive

## Context

5+ detail views (PluginView, TaskDetail, Agents, Deploy, Config) each define section slots using `defineSlot`, then roll their own `useContributions() → sort by order → map` rendering. The pattern is structurally identical but reimplemented with slight variations each time:

- PluginView: `Section` slot with `order?: number`, contributors own chrome
- TaskDetail: `Above` + `Section` (two separate slots), both with `order?: number`
- Agents: `View` slot with no order field, host wraps in card
- Deploy: `Section` slot with required `order` and `title`, host wraps in card
- Config: groups by contributing plugin metadata — fundamentally different, excluded

The `order?: number` field is a hardcoded hack. The `Reorder` plugin already provides persistent user-controlled ordering for slot contributions, but none of these detail views use it. TaskDetail's `Above` slot is just a section rendered differently — unnecessary duplication.

**Goal:** A `defineDetailSections<EntityProps>(id)` factory that creates a reorder-integrated section slot + Host component, replacing the per-view boilerplate.

## Design

### API

```ts
import { defineDetailSections } from "@plugins/primitives/plugins/detail-sections/web";

// Define (in slots.ts)
const PluginView = defineDetailSections<{ node: PluginNode }>("plugin-view");

// Contribute (in sub-plugin index.ts)
PluginView.Section({ id: "runtimes", label: "Runtimes", component: RuntimesSection })

// Render (in host component)
<PluginView.Host node={node} />
```

### Types

```ts
interface DetailSections<EntityProps> {
  Section: ReorderableSlot<{
    id: string;
    label: string;
    component: ComponentType<EntityProps>;
  }>;
  Host: ComponentType<EntityProps>;
}
```

- `label` — required, used by Reorder's restore popover ("1 hidden" → click to restore)
- No `order` field — ordering is fully controlled by Reorder (persisted user preference, fractional-index ranks). Initial order follows plugin registration order (topo-sort). Users drag to customize via the pen-button edit mode.
- `excludeFromReorder?: boolean` — inherited from `Reorder.area`, lets pinned sections (e.g. a header) opt out of dragging/hiding

### Implementation

```
plugins/primitives/plugins/detail-sections/
├── package.json
└── web/
    ├── index.ts                              # barrel
    └── internal/
        └── define-detail-sections.tsx        # factory
```

The factory:
1. Calls `defineSlot<{ id, label, component }>(\`${id}.section\`)` 
2. Wraps with `Reorder.area(slot, { getLabel: c => c.label })`
3. Creates a `Host` component that calls `Reorder.useArea(slot)` and renders `DndWrapper > ReorderItem > component`

Key detail: `ReorderItem` takes `{ item: P; children: ReactNode }` (not `{ id; children }`). The Host passes the full contribution object as `item`.

The Host renders no layout opinions (no padding, no gap, no cards). Section components own their own chrome. This avoids the "some sections need full-width" problem.

## Migration

### Phase 1: PluginView (proof of concept)

**`plugins/plugin-meta/plugins/plugin-view/web/slots.ts`** — replace `defineSlot` with `defineDetailSections`:
```ts
// Before
export const PluginView = {
  Section: defineSlot<{ id: string; order?: number; component: ... }>("plugin-view.section"),
};

// After
export const PluginView = defineDetailSections<{ node: PluginNode }>("plugin-view");
```

The generated slot id is `"plugin-view.section"` (from `${id}.section`), matching the old id. Any future persisted reorder ranks are keyed to the same string.

**`web/components/plugin-detail.tsx`** — delete the `useContributions + useMemo + sort` block, replace with `<PluginView.Host node={node} />`. The header (breadcrumb, description, load-bearing badge) stays hardcoded above the Host.

**3 sub-plugins** (runtimes, sub-plugins, source-path) — drop `order`, add `label`:
```ts
// Before
PluginViewSlots.Section({ id: "runtimes", order: 10, component: RuntimesSection })
// After  
PluginViewSlots.Section({ id: "runtimes", label: "Runtimes", component: RuntimesSection })
```

**`web/index.ts`** barrel — `PluginViewSlots` export continues to work since `PluginView` now has `.Section` (the slot). The `Section` component export (visual helper) stays unchanged.

### Phase 2: TaskDetail

**`plugins/tasks/plugins/task-detail/web/slots.ts`** — merge `Above` + `Section` into one:
```ts
// Before
export const TaskDetail = {
  Above: defineSlot<...>("task-detail.above"),
  Section: defineSlot<...>("task-detail.section"),
};

// After
export const TaskDetail = defineDetailSections<{ taskId: string }>("task-detail");
```

**`web/components/task-detail.tsx`** — simplify to:
```tsx
import { TaskDetail as TaskDetailSlots } from "../slots";

export function TaskDetail({ taskId }: { taskId: string }) {
  return <TaskDetailSlots.Host taskId={taskId} />;
}
```

This thin wrapper preserves the internal import contract for `panes.tsx` (line 78) and `task-tree-detail.tsx` (line 30), both of which use `<TaskDetail taskId={...} />`. No changes needed in those files.

**`web/index.ts`** barrel — `TaskDetailSlots` continues to work. Remove the `Above` from the description/CLAUDE.md.

**6 sub-plugin migrations** — drop `order`, add `label`:

| Sub-plugin | Before | After |
|---|---|---|
| `task-graph` | `TaskDetailSlots.Above({ id: "graph", order: 0, ... })` | `TaskDetailSlots.Section({ id: "graph", label: "Graph", ... })` |
| `task-header` | `TaskDetailSlots.Section({ id: "header", order: 10, ... })` | `TaskDetailSlots.Section({ id: "header", label: "Header", ... })` |
| `task-description` | `TaskDetailSlots.Section({ id: "description", order: 20, ... })` | `TaskDetailSlots.Section({ id: "description", label: "Description", ... })` |
| `task-dependencies` | `TaskDetailSlots.Section({ id: "dependencies", order: 30, ... })` | `TaskDetailSlots.Section({ id: "dependencies", label: "Dependencies", ... })` |
| `task-attachments` | `TaskDetailSlots.Section({ id: "attachments", order: 40, ... })` | `TaskDetailSlots.Section({ id: "attachments", label: "Attachments", ... })` |
| `task-events` | `TaskDetailSlots.Section({ id: "events", order: 50, ... })` | `TaskDetailSlots.Section({ id: "events", label: "Events", ... })` |

**Initial order guarantee:** With no persisted ranks, Reorder falls back to natural registration order (plugin topo-sort → array position in `web/src/plugins.ts`). The current numeric order (graph=0, header=10, description=20, dependencies=30, attachments=40, events=50) must match the plugin registration order. Verify the plugins array; reorder entries if needed.

**TaskDetailFlushProvider** stays in `panes.tsx` wrapping `<PaneChrome>` — unaffected by this change.

### Not migrated (no urgency)

- **Agents.View** — 0 current contributors. Migrate when someone adds a section.
- **Deploy.Section** — 0 current contributors. Same.
- **Config.Section** — fundamentally different pattern (groups by `_pluginId` metadata, no entity props). Not a fit for this primitive.

## Files

### New
- `plugins/primitives/plugins/detail-sections/package.json`
- `plugins/primitives/plugins/detail-sections/web/index.ts`
- `plugins/primitives/plugins/detail-sections/web/internal/define-detail-sections.tsx`

### Modified (PluginView)
- `plugins/plugin-meta/plugins/plugin-view/web/slots.ts`
- `plugins/plugin-meta/plugins/plugin-view/web/components/plugin-detail.tsx`
- `plugins/plugin-meta/plugins/plugin-view/plugins/runtimes/web/index.ts`
- `plugins/plugin-meta/plugins/plugin-view/plugins/sub-plugins/web/index.ts`
- `plugins/plugin-meta/plugins/plugin-view/plugins/source-path/web/index.ts`

### Modified (TaskDetail)
- `plugins/tasks/plugins/task-detail/web/slots.ts`
- `plugins/tasks/plugins/task-detail/web/components/task-detail.tsx`
- `plugins/tasks/plugins/task-graph/web/index.ts`
- `plugins/tasks/plugins/task-header/web/index.ts`
- `plugins/tasks/plugins/task-description/web/index.ts`
- `plugins/tasks/plugins/task-dependencies/web/index.ts`
- `plugins/tasks/plugins/task-attachments/web/index.ts`
- `plugins/tasks/plugins/task-events/web/index.ts`

## Verification

1. `./equin build` succeeds
2. Open a plugin detail pane → sections render in expected order (runtimes → sub-plugins → source-path)
3. Open a task detail pane → sections render in expected order (graph → header → description → dependencies → attachments → events)
4. Click the pen button (edit mode) → sections in both views become draggable with wiggle animation
5. Drag a section to reorder → order persists across page reload
6. Click × to hide a section → restore popover shows the hidden section's `label`
7. Verify the `TaskDetailFlushProvider` still works (edit a task description, navigate away, confirm auto-save)
