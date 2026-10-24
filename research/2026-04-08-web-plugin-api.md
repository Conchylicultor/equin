# Plugin API Design

## Context

Every feature in equin is a plugin. The main app (`web/`) is a thin shell that collects plugin contributions and renders them. Plugins are hardcoded (static imports, known at build time) for simplicity and type-safety.

This design covers the frontend plugin API only. The server-side half (`plugins/{name}/server/`) will come later.

## Plugin Definition

A plugin is a plain object with an `id`, a `name`, and optional arrays of **contributions** — things it injects into the host app.

```typescript
// web/src/plugin-api/types.ts

type PluginId = string;

interface PluginDefinition {
  id: PluginId;
  name: string;
  dependencies?: PluginId[];

  // Contributions — all optional, a plugin provides whichever it needs
  panels?: PanelContribution[];
  toolbar?: ToolbarContribution[];
  contextMenu?: ContextMenuContribution[];
  statusBar?: StatusBarContribution[];
  background?: BackgroundContribution[];
}
```

## Entry Points

### Panels (extensible layout)

Instead of fixed sidebar/main slots, panels are the universal layout primitive. Each panel declares a **region** where it wants to appear. The host shell renders regions; plugins fill them.

```typescript
type PanelRegion = "sidebar" | "main" | "bottom" | "right" | string;

interface PanelContribution {
  id: string;
  title: string;
  icon?: ComponentType<{ className?: string }>;
  component: ComponentType;
  region: PanelRegion;
  /** "tab" (default) = tabbed within the region, "default" = initially active tab */
  role?: "tab" | "default";
  order?: number;  // Lower = higher priority. Default 100.
}
```

Well-known regions (`sidebar`, `main`, `bottom`, `right`) have built-in positioning in the shell. A plugin can use a custom string region — the shell renders unknown regions as floating/docked panels (future — for now we start with the well-known ones and ignore unknown regions with a console warning).

This means: sidebar panes, main content panels, bottom panels, and right panels are all the same `PanelContribution` type, just targeting different regions.

### Toolbar

```typescript
interface ToolbarContribution {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: (ctx: PluginContext) => void;
  order?: number;
}
```

### Context Menu

```typescript
interface ContextMenuContribution {
  id: string;
  label: string;
  /** Where this item appears, e.g. "sidebar", "main", "panel.tasks" */
  scope: string | string[];
  icon?: ComponentType<{ className?: string }>;
  onClick: (ctx: PluginContext, target: unknown) => void;
  order?: number;
}
```

### Status Bar

```typescript
interface StatusBarContribution {
  id: string;
  component: ComponentType;
  align?: "left" | "right";
  order?: number;
}
```

### Background Effects

Non-visual logic — headless React components that use hooks for side effects (useEffect, subscriptions, polling). Mounted once at app load.

```typescript
interface BackgroundContribution {
  id: string;
  component: ComponentType;  // Returns null, uses hooks
}
```

Why a React component and not a plain function? Because it can use hooks (useEffect, useContext, useEventBus) and participates in React's lifecycle naturally. No need for a custom teardown API.

## Inter-Plugin Communication: Typed Event Bus

Plugins communicate via a **typed event bus**. This is the primary cross-plugin mechanism.

### Why event bus

- **Decoupling**: plugins never import from each other. A notification plugin listens to `"task.created"` without knowing the tasks plugin exists.
- **Simplicity**: ~30 lines to implement, no dependencies.
- **Familiar**: pub/sub is a well-understood pattern.

### Why not shared state (zustand/signals)

Shared state creates coupling at the data-model level — plugin B would need to understand plugin A's store shape. Events are about **intent** ("task.created"), not data structure.

Each plugin manages its own internal state however it likes (useState, zustand, whatever). The bus is only for cross-plugin messages.

### Direct APIs (deferred)

Whether plugins should expose typed query APIs (e.g., `tasksPlugin.getTask(id)`) is left open. The event bus handles broadcast/notification well. If we find that request/response patterns are needed, we can add an `api` field to `PluginDefinition` later. The event bus design doesn't preclude this.

### Implementation

```typescript
// web/src/plugin-api/events.ts

/** 
 * Central event map. Empty by default.
 * Plugins add their events via TypeScript module augmentation.
 */
export interface EventMap {}

type Handler<T = unknown> = (payload: T) => void;

export function createEventBus() {
  const listeners = new Map<string, Set<Handler>>();

  return {
    on<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>) {
      if (!listeners.has(event as string)) {
        listeners.set(event as string, new Set());
      }
      listeners.get(event as string)!.add(handler as Handler);
      return () => { listeners.get(event as string)?.delete(handler as Handler); };
    },

    emit<K extends keyof EventMap>(event: K, payload: EventMap[K]) {
      listeners.get(event as string)?.forEach((h) => h(payload));
    },
  };
}

export type EventBus = ReturnType<typeof createEventBus>;
```

Plugins declare their events via **module augmentation** — no plugin imports types from another:

```typescript
// plugins/tasks/web/events.ts
declare module "@/plugin-api/events" {
  interface EventMap {
    "task.created": { id: string; title: string };
    "task.completed": { id: string };
  }
}
export {};
```

This gives full type safety across plugin boundaries. The same pattern TypeScript uses for `lib.dom.d.ts` and Express uses for `Request`.

## PluginContext

Passed to imperative callbacks (toolbar onClick, context menu onClick):

```typescript
interface PluginContext {
  bus: EventBus;
}
```

Kept minimal. Can be extended later with navigation, settings, etc.

## React Integration

```typescript
// web/src/plugin-api/context.tsx

const PluginRuntimeContext = createContext<{ plugins: PluginDefinition[]; bus: EventBus } | null>(null);

function PluginProvider({ plugins, children }: { plugins: PluginDefinition[]; children: ReactNode }) {
  const runtime = useMemo(() => {
    // Validate dependencies (console.error, not crash — it's a dev mistake)
    const ids = new Set(plugins.map((p) => p.id));
    for (const p of plugins) {
      for (const dep of p.dependencies ?? []) {
        if (!ids.has(dep)) console.error(`Plugin "${p.id}" depends on "${dep}" which is not registered.`);
      }
    }
    return { plugins, bus: createEventBus() };
  }, [plugins]);

  return <PluginRuntimeContext.Provider value={runtime}>{children}</PluginRuntimeContext.Provider>;
}

/** Hook for plugins to access the event bus */
function useEventBus(): EventBus { ... }

/** Hook for the shell to collect contributions of a given type */
function usePluginSlot<K extends keyof PluginDefinition>(slot: K): FlatArray<...> { ... }
```

## Registration

Single file, static imports, flat array:

```typescript
// web/src/plugins.ts
import tasksPlugin from "@plugins/tasks/web";
import notificationsPlugin from "@plugins/notifications/web";

export const plugins: PluginDefinition[] = [
  tasksPlugin,
  notificationsPlugin,
];
```

Adding a plugin = one import + one array entry. Removing = delete those two lines.

## Host App Shell

```typescript
// web/src/App.tsx
function App() {
  return (
    <PluginProvider plugins={plugins}>
      <Shell />
    </PluginProvider>
  );
}
```

The `Shell` component uses `usePluginSlot` to gather contributions and renders the layout:

```
┌─────────────────────────────────────────────┐
│ Toolbar                                     │
├──────────┬─────────────────────┬────────────┤
│ Sidebar  │ Main                │ Right      │
│ (panels) │ (panels, tabbed)    │ (panels)   │
│          │                     │            │
│          ├─────────────────────┤            │
│          │ Bottom (panels)     │            │
├──────────┴─────────────────────┴────────────┤
│ Status Bar                                  │
└─────────────────────────────────────────────┘
```

Regions that have no panels are not rendered (collapsed).

## File Structure

```
singularity/
├── web/
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                     # PluginProvider + Shell
│       ├── plugins.ts                  # Hardcoded plugin list
│       ├── plugin-api/
│       │   ├── types.ts               # PluginDefinition, contribution interfaces
│       │   ├── events.ts              # EventMap, createEventBus
│       │   └── context.tsx            # PluginProvider, useEventBus, usePluginSlot
│       └── components/
│           ├── shell.tsx              # Main layout rendering all regions
│           └── ui/                    # shadcn (existing)
│
├── plugins/
│   └── {name}/
│       └── web/
│           ├── index.ts              # default export: PluginDefinition
│           ├── events.ts             # Module augmentation for EventMap (if needed)
│           └── components/           # Plugin's React components
```

## Build Configuration

### Vite (`web/vite.config.ts`)

Add `@plugins` alias:

```typescript
resolve: {
  alias: {
    "@": path.resolve(__dirname, "./src"),
    "@plugins": path.resolve(__dirname, "../plugins"),
  },
},
```

### TypeScript (`web/tsconfig.app.json`)

Add path alias and include plugins in compilation:

```jsonc
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@plugins/*": ["../plugins/*"]
    }
  },
  "include": ["src", "../plugins/*/web"]
}
```

### Tailwind

No changes needed — Tailwind v4 with `@tailwindcss/vite` auto-scans files in Vite's module graph. Since plugin files are imported by the app, their classes are picked up automatically.

## Example: Tasks Plugin

```typescript
// plugins/tasks/web/events.ts
declare module "@/plugin-api/events" {
  interface EventMap {
    "task.created": { id: string; title: string };
    "task.completed": { id: string };
    "task.selected": { id: string };
  }
}
export {};

// plugins/tasks/web/index.ts
import type { PluginDefinition } from "@/plugin-api/types";
import { MdChecklist } from "react-icons/md";
import { TaskSidebar } from "./components/task-sidebar";
import { TaskPanel } from "./components/task-panel";
import { TaskStatus } from "./components/task-status";
import "./events";

const tasksPlugin: PluginDefinition = {
  id: "tasks",
  name: "Tasks",
  panels: [
    { id: "tasks.list", title: "Tasks", icon: MdChecklist, component: TaskSidebar, region: "sidebar", order: 10 },
    { id: "tasks.detail", title: "Tasks", icon: MdChecklist, component: TaskPanel, region: "main", role: "default" },
  ],
  statusBar: [
    { id: "tasks.count", component: TaskStatus, align: "left" },
  ],
};

export default tasksPlugin;
```

A component using the event bus:

```typescript
// plugins/tasks/web/components/task-sidebar.tsx
export function TaskSidebar() {
  const bus = useEventBus();

  function addTask(title: string) {
    const id = crypto.randomUUID();
    // ... internal state update ...
    bus.emit("task.created", { id, title });
  }

  // ...
}
```

## Example: Notifications Plugin (cross-plugin via events)

```typescript
// plugins/notifications/web/index.ts
const notificationsPlugin: PluginDefinition = {
  id: "notifications",
  name: "Notifications",
  background: [{ id: "notifications.toaster", component: ToastBackground }],
};

// plugins/notifications/web/components/toast-background.tsx
export function ToastBackground() {
  const bus = useEventBus();
  useEffect(() => {
    return bus.on("task.created", (payload) => {
      // Show toast — no import from tasks plugin needed
      showToast(`Task created: ${payload.title}`);
    });
  }, [bus]);
  return null;
}
```

## Implementation Order

1. **Plugin API types** — `web/src/plugin-api/types.ts`
2. **Event bus** — `web/src/plugin-api/events.ts`
3. **React context** — `web/src/plugin-api/context.tsx`
4. **Build config** — `vite.config.ts` + `tsconfig.app.json`
5. **Shell component** — `web/src/components/shell.tsx`
6. **Plugin registry** — `web/src/plugins.ts`
7. **Update App.tsx** — Wire up PluginProvider + Shell
8. **First plugin** — a minimal "hello world" plugin to validate the API

## Verification

1. `bun dev` — app starts without errors
2. The hello world plugin's panel appears in the correct region
3. The shell collapses empty regions
4. Event bus type-checks: emitting an unknown event or wrong payload is a TS error
5. `bun build` — production build succeeds with no type errors
