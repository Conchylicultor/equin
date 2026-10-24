# Plugin API Design v3 — Slots Only

## Context

Every feature in equin is a plugin — including the app shell. The main app (`web/`) is a minimal bootstrap: it collects plugins, provides context, and renders root contributions.

Key insight: **everything is a contribution to a slot**. No special `root` or `background` fields. No `dependencies` array (imports enforce that at build time). The plugin definition is minimal.

## Core Concepts

### Slots

A **slot** is a typed extension point. A plugin defines it; other plugins contribute to it.

A slot is callable (factory) and has a `.useContributions()` hook (for the defining plugin to render contributions).

```typescript
// web/src/plugin-api/slots.ts

type Contribution = { _slotId: string; [key: string]: unknown };

interface Slot<P> {
  (props: P): Contribution;
  useContributions(): P[];
}

function defineSlot<P>(id: string): Slot<P>;
```

Usage:

```typescript
// Defining a slot
export const Shell = {
  Sidebar: defineSlot<{ title: string; component: ComponentType }>("shell.sidebar"),
};

// Contributing to it (from another plugin)
contributions: [
  Shell.Sidebar({ title: "Tasks", component: TaskList }),
]

// Rendering contributions (from the defining plugin)
function ShellLayout() {
  const sidebars = Shell.Sidebar.useContributions();
  return sidebars.map((s) => <s.component key={s.title} />);
}
```

### Plugin Definition

```typescript
// web/src/plugin-api/types.ts

type PluginId = string;

interface PluginDefinition {
  id: PluginId;
  name: string;
  contributions?: Contribution[];
}
```

That's it. Three fields. Everything else is expressed through contributions to slots.

### The Bootstrap Slot

The host app defines one slot — the root. This is the only non-plugin slot:

```typescript
// web/src/plugin-api/slots.ts
export const Core = {
  Root: defineSlot<{ component: ComponentType }>("core.root"),
};
```

The shell plugin contributes its layout to `Core.Root`. Background-only plugins contribute a component that returns `null`. The host app renders all `Core.Root` contributions:

```typescript
// web/src/App.tsx
function App() {
  return (
    <PluginProvider plugins={plugins}>
      <RootRenderer />
    </PluginProvider>
  );
}

function RootRenderer() {
  const roots = Core.Root.useContributions();
  return <>{roots.map((r, i) => <r.component key={i} />)}</>;
}
```

## The Shell Plugin

Defines the standard layout slots and renders them:

```typescript
// plugins/shell/web/slots.ts
import { defineSlot } from "@/plugin-api/slots";

export const Shell = {
  Sidebar: defineSlot<{
    title: string;
    icon: ComponentType<{ className?: string }>;
    component: ComponentType;
  }>("shell.sidebar"),

  Main: defineSlot<{
    title: string;
    component: ComponentType;
  }>("shell.main"),

  Toolbar: defineSlot<{
    label: string;
    icon: ComponentType<{ className?: string }>;
    onClick: () => void;
  }>("shell.toolbar"),

  StatusBar: defineSlot<{
    component: ComponentType;
  }>("shell.statusbar"),
};
```

```typescript
// plugins/shell/web/index.ts
import type { PluginDefinition } from "@/plugin-api/types";
import { Core } from "@/plugin-api/slots";
import { ShellLayout } from "./components/shell-layout";

const shellPlugin: PluginDefinition = {
  id: "shell",
  name: "Shell",
  contributions: [
    Core.Root({ component: ShellLayout }),
  ],
};

export default shellPlugin;
```

```typescript
// plugins/shell/web/components/shell-layout.tsx
import { Shell } from "../slots";

export function ShellLayout() {
  const sidebars = Shell.Sidebar.useContributions();
  const mains = Shell.Main.useContributions();
  const toolbarItems = Shell.Toolbar.useContributions();
  const statusBarItems = Shell.StatusBar.useContributions();

  return (
    <div className="flex h-screen flex-col">
      {toolbarItems.length > 0 && (
        <header className="flex items-center border-b px-4 h-12">
          {toolbarItems.map((item) => (
            <button key={item.label} onClick={item.onClick}>
              <item.icon className="size-4" />
              {item.label}
            </button>
          ))}
        </header>
      )}

      <div className="flex flex-1 overflow-hidden">
        {sidebars.length > 0 && (
          <aside className="w-64 border-r overflow-y-auto">
            {sidebars.map((pane) => <pane.component key={pane.title} />)}
          </aside>
        )}

        <main className="flex-1 overflow-hidden">
          {mains.map((panel) => <panel.component key={panel.title} />)}
        </main>
      </div>

      {statusBarItems.length > 0 && (
        <footer className="flex items-center border-t px-4 h-6 text-xs">
          {statusBarItems.map((item, i) => <item.component key={i} />)}
        </footer>
      )}
    </div>
  );
}
```

## Example: Tasks Plugin

```typescript
// plugins/tasks/web/index.ts
import type { PluginDefinition } from "@/plugin-api/types";
import { Shell } from "@plugins/shell/web/slots";
import { MdChecklist } from "react-icons/md";
import { TaskSidebar } from "./components/task-sidebar";
import { TaskPanel } from "./components/task-panel";

const tasksPlugin: PluginDefinition = {
  id: "tasks",
  name: "Tasks",
  contributions: [
    Shell.Sidebar({ title: "Tasks", icon: MdChecklist, component: TaskSidebar }),
    Shell.Main({ title: "Tasks", component: TaskPanel }),
  ],
};

export default tasksPlugin;
```

## Example: Plugin Extending Another Plugin

```typescript
// plugins/conversation/web/slots.ts
import { defineSlot } from "@/plugin-api/slots";

export const Conversation = {
  Actions: defineSlot<{
    label: string;
    icon: ComponentType<{ className?: string }>;
    onClick: () => void;
  }>("conversation.actions"),
};

// plugins/some-tool/web/index.ts
import { Conversation } from "@plugins/conversation/web/slots";

const toolPlugin: PluginDefinition = {
  id: "some-tool",
  name: "Some Tool",
  contributions: [
    Conversation.Actions({ label: "Do thing", icon: MdStar, onClick: () => {} }),
  ],
};
```

## Example: Background Plugin

A plugin with no visible UI — just side effects:

```typescript
// plugins/sync/web/index.ts
import { Core } from "@/plugin-api/slots";
import { SyncBackground } from "./components/sync-background";

const syncPlugin: PluginDefinition = {
  id: "sync",
  name: "Sync",
  contributions: [
    Core.Root({ component: SyncBackground }),
  ],
};

// plugins/sync/web/components/sync-background.tsx
export function SyncBackground() {
  useEffect(() => {
    const interval = setInterval(() => { /* poll */ }, 5000);
    return () => clearInterval(interval);
  }, []);
  return null;
}
```

## React Integration

```typescript
// web/src/plugin-api/context.tsx

interface PluginRuntime {
  plugins: PluginDefinition[];
  contributions: Contribution[];
}

const PluginRuntimeContext = createContext<PluginRuntime | null>(null);

function PluginProvider({
  plugins,
  children,
}: {
  plugins: PluginDefinition[];
  children: ReactNode;
}) {
  const runtime = useMemo(() => {
    const contributions = plugins.flatMap((p) => p.contributions ?? []);
    return { plugins, contributions };
  }, [plugins]);

  return (
    <PluginRuntimeContext.Provider value={runtime}>
      {children}
    </PluginRuntimeContext.Provider>
  );
}
```

## Registration

```typescript
// web/src/plugins.ts
import shellPlugin from "@plugins/shell/web";
import tasksPlugin from "@plugins/tasks/web";

import type { PluginDefinition } from "@/plugin-api/types";

export const plugins: PluginDefinition[] = [
  shellPlugin,
  tasksPlugin,
];
```

## File Structure

```
singularity/
├── web/
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                     # PluginProvider + RootRenderer
│       ├── plugins.ts                  # Hardcoded plugin list
│       └── plugin-api/
│           ├── types.ts               # PluginDefinition, Contribution
│           ├── slots.ts               # defineSlot, Slot<P>, Core.Root
│           └── context.tsx            # PluginProvider, PluginRuntimeContext
│
├── plugins/
│   ├── shell/
│   │   └── web/
│   │       ├── index.ts              # Shell plugin (contributes to Core.Root)
│   │       ├── slots.ts              # Shell.Sidebar, Shell.Main, Shell.Toolbar, Shell.StatusBar
│   │       └── components/
│   │           └── shell-layout.tsx
│   │
│   └── {other-plugin}/
│       └── web/
│           ├── index.ts              # Plugin definition with contributions
│           ├── slots.ts              # Optional: slots this plugin defines
│           └── components/
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

Add path alias and include plugins:

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

No changes — Tailwind v4 auto-scans imported files.

## Inter-Plugin Communication

Deferred. The slot system handles structural composition. Runtime communication (events, shared state) will be designed when concrete use cases arise.

## Implementation Order

1. **Plugin API core** — `types.ts`, `slots.ts`, `context.tsx`
2. **Build config** — `vite.config.ts` + `tsconfig.app.json`
3. **Shell plugin** — `plugins/shell/web/`
4. **Plugin registry** — `web/src/plugins.ts`
5. **Update App.tsx** — PluginProvider + RootRenderer
6. **Hello world plugin** — minimal plugin contributing to Shell.Sidebar

## Verification

1. `bun dev` — app starts, shell layout renders
2. Hello world plugin's contribution appears in the sidebar
3. Removing a plugin from the registry removes its contributions
4. Empty regions (no toolbar contributions) are not rendered
5. `bun build` — no type errors
