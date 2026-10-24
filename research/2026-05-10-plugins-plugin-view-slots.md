# Plugin-View Slot Refactor

## Context

The `plugin-view` detail pane currently hardcodes three sections (Runtimes, Sub-plugins, Source path) directly in `plugin-detail.tsx`. This makes it impossible for other plugins to extend the view with new displays. Converting to a slot mechanism follows the same proven pattern as `task-detail` — sub-plugins contribute sections via the slot system, making the view extensible.

## Design

### Slot definition

Create `plugins/plugin-meta/plugins/plugin-view/web/slots.ts`:

```ts
import { defineSlot } from "@core";
import type { ComponentType } from "react";
import type { PluginNode } from "../../shared/types";

export const PluginView = {
  Section: defineSlot<{
    id: string;
    order?: number;
    component: ComponentType<{ node: PluginNode }>;
  }>("plugin-view.section"),
};
```

The prop contract is `{ node: PluginNode }` — sections receive the full node since all data is already loaded by the pane host. This mirrors how task-detail passes `{ taskId }` except here the data is pre-fetched.

### Host component update

Refactor `plugin-detail.tsx` to render slot contributions:

```tsx
import { PluginView } from "../slots";

export function PluginDetail({ node }: { node: PluginNode | null }) {
  const sections = PluginView.Section.useContributions();
  const ordered = useMemo(
    () => [...sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [sections],
  );

  if (!node) return <EmptyState />;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-8">
        <Header node={node} />
        {ordered.map((s) => (
          <s.component key={s.id} node={node} />
        ))}
      </div>
    </div>
  );
}
```

The header (breadcrumb + description) stays in `plugin-detail.tsx` — it's structural chrome, not a section.

### Sub-plugins

Create three sub-plugins under `plugins/plugin-meta/plugins/plugin-view/plugins/`:

#### 1. `runtimes/` (order: 10)

```
plugins/plugin-meta/plugins/plugin-view/plugins/runtimes/
├── package.json     (@singularity/plugin-plugin-view-runtimes)
└── web/
    ├── index.ts
    └── components/
        └── runtimes-section.tsx
```

Moves the `RuntimePill` component and the "Runtimes" section.

#### 2. `sub-plugins/` (order: 20)

```
plugins/plugin-meta/plugins/plugin-view/plugins/sub-plugins/
├── package.json     (@singularity/plugin-plugin-view-sub-plugins)
└── web/
    ├── index.ts
    └── components/
        └── sub-plugins-section.tsx
```

Moves the children list with load-bearing indicators and `countDescendants`.

#### 3. `source-path/` (order: 30)

```
plugins/plugin-meta/plugins/plugin-view/plugins/source-path/
├── package.json     (@singularity/plugin-plugin-view-source-path)
└── web/
    ├── index.ts
    └── components/
        └── source-path-section.tsx
```

Moves the monospace path display.

### Shared `Section` wrapper

The `Section` UI component (title + optional count + children) is used by all three sub-plugins. Export it from the plugin-view web barrel so sub-plugins can import it:

```ts
// web/index.ts additions
export { Section } from "./components/section";
export { PluginView as PluginViewSlots } from "./slots";
```

Move the `Section` component from `plugin-detail.tsx` into its own file `web/components/section.tsx`.

### Barrel updates

`plugins/plugin-meta/plugins/plugin-view/web/index.ts`:
```ts
export { pluginViewPane } from "./panes";
export { PluginDetail } from "./components/plugin-detail";
export { Section } from "./components/section";
export { PluginView as PluginViewSlots } from "./slots";
export type { PluginNode, PluginTreePayload } from "../shared/types";
```

### Sub-plugin registration

Register all three new sub-plugins in `web/src/plugins.ts`.

## Files to create

| Path | Purpose |
|------|---------|
| `plugins/plugin-meta/plugins/plugin-view/web/slots.ts` | Slot definition |
| `plugins/plugin-meta/plugins/plugin-view/web/components/section.tsx` | Extracted Section wrapper |
| `plugins/plugin-meta/plugins/plugin-view/plugins/runtimes/package.json` | Workspace package |
| `plugins/plugin-meta/plugins/plugin-view/plugins/runtimes/web/index.ts` | Plugin def + contribution |
| `plugins/plugin-meta/plugins/plugin-view/plugins/runtimes/web/components/runtimes-section.tsx` | Runtime pills UI |
| `plugins/plugin-meta/plugins/plugin-view/plugins/sub-plugins/package.json` | Workspace package |
| `plugins/plugin-meta/plugins/plugin-view/plugins/sub-plugins/web/index.ts` | Plugin def + contribution |
| `plugins/plugin-meta/plugins/plugin-view/plugins/sub-plugins/web/components/sub-plugins-section.tsx` | Children list UI |
| `plugins/plugin-meta/plugins/plugin-view/plugins/source-path/package.json` | Workspace package |
| `plugins/plugin-meta/plugins/plugin-view/plugins/source-path/web/index.ts` | Plugin def + contribution |
| `plugins/plugin-meta/plugins/plugin-view/plugins/source-path/web/components/source-path-section.tsx` | Path display UI |

## Files to modify

| Path | Change |
|------|--------|
| `plugins/plugin-meta/plugins/plugin-view/web/index.ts` | Add exports for `PluginViewSlots` and `Section` |
| `plugins/plugin-meta/plugins/plugin-view/web/components/plugin-detail.tsx` | Replace hardcoded sections with slot rendering |
| `web/src/plugins.ts` | Register 3 new sub-plugins |
| `package.json` (root) | Add 3 new workspace entries |

## Verification

1. `bun install` from root (picks up new workspaces)
2. `./equin build` (builds + deploys)
3. Open `http://att-1778446028-8cdm.localhost:9000`, navigate to plugin-view for any plugin
4. Confirm all three sections still render correctly (runtimes, sub-plugins, source path)
5. `./equin check` passes
