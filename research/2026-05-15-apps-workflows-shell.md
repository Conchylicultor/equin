# Workflows App Shell

## Context

The Workflows app (see `research/2026-05-14-plugins-workflows.md` and `research/2026-05-15-workflows-vision.md`) is a new top-level app in the app switcher rail. It hosts a durable workflow engine that chains user interactions, agent actions, and logic steps into guided experiences.

The shell plugin is the load-bearing foundation that all other workflow plugins contribute into. Without it, there is no app entry in the rail, no sidebar, and no toolbar for sub-plugins to populate. This task creates the shell and the umbrella namespace plugin that groups it.

## What to Create

Two new plugins:

```
plugins/apps/plugins/workflows/              # Umbrella namespace (empty, no logic)
  package.json
  plugins/
    shell/                                   # App shell
      package.json
      web/
        index.ts                             # PluginDefinition + re-exports WorkflowsApp
        slots.ts                             # WorkflowsApp.Sidebar + WorkflowsApp.Toolbar
        components/
          workflows-layout.tsx               # AppShellLayout wired to both slots
```

## Implementation

### 1. `plugins/apps/plugins/workflows/package.json`

```json
{
  "name": "@singularity/plugin-apps-workflows",
  "description": "Workflows app.",
  "private": true,
  "version": "0.0.1"
}
```

No `web/`, `server/`, or `core/` directories. Empty namespace only.

---

### 2. `plugins/apps/plugins/workflows/plugins/shell/package.json`

```json
{
  "name": "@singularity/plugin-apps-workflows-shell",
  "description": "App shell for the workflows app. Registers the /workflows app entry and defines WorkflowsApp.Sidebar/Toolbar slots.",
  "private": true,
  "version": "0.0.1"
}
```

---

### 3. `plugins/apps/plugins/workflows/plugins/shell/web/slots.ts`

Mirror `plugins/apps/plugins/debug/plugins/shell/web/slots.ts` exactly, substituting `WorkflowsApp` / `"workflows-app"`:

```ts
import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { AppShellSidebarItem } from "@plugins/primitives/plugins/app-shell/web";

export const WorkflowsApp = {
  Sidebar: defineRenderSlot<AppShellSidebarItem>("workflows-app.sidebar", {
    docLabel: (p) => p.title,
  }),

  Toolbar: defineRenderSlot<{
    label?: string;
    icon?: ComponentType<{ className?: string }>;
    onClick?: () => void;
    component?: ComponentType;
    group?: string;
  }>("workflows-app.toolbar", {
    docLabel: (p) => p.label,
  }),
};
```

---

### 4. `plugins/apps/plugins/workflows/plugins/shell/web/components/workflows-layout.tsx`

```tsx
import { AppShellLayout } from "@plugins/primitives/plugins/app-shell/web";
import { WorkflowsApp } from "../slots";

export function WorkflowsLayout() {
  return (
    <AppShellLayout
      sidebarSlot={WorkflowsApp.Sidebar}
      toolbarSlot={WorkflowsApp.Toolbar}
    />
  );
}
```

---

### 5. `plugins/apps/plugins/workflows/plugins/shell/web/index.ts`

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/web";
import { Apps } from "@plugins/apps/web";
import { MdSchema } from "react-icons/md";
import { WorkflowsLayout } from "./components/workflows-layout";

export { WorkflowsApp } from "./slots";

export default {
  id: "workflows-shell",
  name: "Workflows: Shell",
  description:
    "App shell for the workflows app. Registers the /workflows app entry and defines WorkflowsApp.Sidebar/Toolbar slots.",
  contributions: [
    Apps.App({
      id: "workflows",
      icon: MdSchema,
      tooltip: "Workflows",
      component: WorkflowsLayout,
      path: "/workflows",
    }),
  ],
} satisfies PluginDefinition;
```

`MdSchema` is chosen for its "structured pipeline" connotation (vs `MdBugReport` for debug, `MdFolder` for files). Can be swapped if a better match is preferred.

## Reference Files (patterns to mirror)

| File | Purpose |
|------|---------|
| `plugins/apps/plugins/debug/plugins/shell/web/slots.ts` | Slot definition pattern |
| `plugins/apps/plugins/debug/plugins/shell/web/index.ts` | PluginDefinition + Apps.App pattern |
| `plugins/apps/plugins/debug/plugins/shell/web/components/debug-layout.tsx` | Layout component pattern |
| `plugins/apps/plugins/debug/package.json` | Umbrella package.json pattern |
| `plugins/apps/plugins/debug/plugins/shell/package.json` | Shell package.json pattern |

## Verification

1. Run `./equin build` — should complete without errors.
2. Open `http://att-1778799370-vo95.localhost:9000` — a new icon should appear in the left app-switcher rail.
3. Click the icon — navigates to `/workflows`, renders an empty `AppShellLayout` (no sidebar items yet — that's expected).
4. Run `./equin check --plugin-boundaries` — no boundary violations.
