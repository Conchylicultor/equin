# Plugin API Design v2 — Slot-Based

## Context

Every feature in equin is a plugin — including the app shell itself. The main app (`web/`) is a minimal bootstrap that collects plugins and renders the root.

Key change from v1: instead of the host defining fixed layout regions, **any plugin can define slots** (typed extension points) that other plugins contribute to. The shell is just a plugin that happens to define the top-level layout slots.

## Core Concepts

### Slots

A **slot** is a typed extension point that a plugin defines and renders. Other plugins contribute to it.

```typescript
// web/src/plugin-api/slots.ts

import type { ComponentType } from "react";

type Contribution = { _slotId: string; [key: string]: unknown };

interface Slot<P> {
  /** Create a contribution to this slot */
  (props: P): Contribution;
  /** Hook: get all contributions to this slot (used by the defining plugin to render them) */
  useContributions(): P[];
}

function defineSlot<P>(id: string): Slot<P> {
  const slot = ((props: P) => ({ _slotId: id, ...props })) as Slot<P>;
  slot.useContributions = () => {
    const ctx = useContext(PluginRuntimeContext);
    if (!ctx) throw new Error("useContributions must be used within PluginProvider");
    return ctx.contributions
      .filter((c) => c._slotId === id)
      .map(({ _slotId, ...rest }) => rest as P);
  };
  return slot;
}
```

A slot is both a **factory** (callable — creates typed contributions) and a **hook provider** (`.useContributions()` — returns all contributions targeting it).

### Plugin Definition

```typescript
// web/src/plugin-api/types.ts

type PluginId = string;

interface PluginDefinition {
  id: PluginId;
  name: string;
  dependencies?: PluginId[];

  /** Things this plugin contributes to other plugins' slots */
  contributions?: Contribution[];

  /** Root component mounted once — for plugins that define layout or run background effects */
  root?: ComponentType;
}
```

Two ways a plugin participates:

1. **`contributions`** — data injected into other plugins' slots (e.g., a sidebar entry, a toolbar button)
2. **`root`** — a React component mounted in the tree. This is how the shell plugin renders its layout, or how a background plugin runs effects. Roots are mounted in plugin order, nested.

### Why `root` instead of separate `background` arrays

A `root` component is the universal escape hatch. It can:
- Render layout (the shell plugin)
- Run background effects (return `null`, use hooks)
- Provide React context to downstream plugins
- Render overlays, modals, toasts

This replaces the need for separate `background`, `toolbar`, `statusBar` contribution types on the plugin definition itself. Those become slots defined by whichever plugin owns that UI.

## The Shell Plugin

The shell is a plugin that defines the standard layout slots and renders them:

```typescript
// plugins/shell/web/slots.ts
import { defineSlot } from "@/plugin-api/slots";
import type { ComponentType } from "react";

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
import { ShellLayout } from "./components/shell-layout";

const shellPlugin: PluginDefinition = {
  id: "shell",
  name: "Shell",
  root: ShellLayout,
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
      {/* Toolbar */}
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
        {/* Sidebar — collapsed if no contributions */}
        {sidebars.length > 0 && (
          <aside className="w-64 border-r overflow-y-auto">
            {sidebars.map((pane) => <pane.component key={pane.title} />)}
          </aside>
        )}

        {/* Main area */}
        <main className="flex-1 overflow-hidden">
          {mains.map((panel) => <panel.component key={panel.title} />)}
        </main>
      </div>

      {/* Status bar */}
      {statusBarItems.length > 0 && (
        <footer className="flex items-center border-t px-4 h-6 text-xs">
          {statusBarItems.map((item) => <item.component key={/* ... */} />)}
        </footer>
      )}
    </div>
  );
}
```

## Plugin Using the Shell Slots

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
  dependencies: ["shell"],
  contributions: [
    Shell.Sidebar({ title: "Tasks", icon: MdChecklist, component: TaskSidebar }),
    Shell.Main({ title: "Tasks", component: TaskPanel }),
  ],
};

export default tasksPlugin;
```

### Plugin Defining Its Own Slots

A plugin can define slots that other plugins extend:

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
```

```typescript
// plugins/some-other/web/index.ts
import { Conversation } from "@plugins/conversation/web/slots";

const otherPlugin: PluginDefinition = {
  id: "some-other",
  name: "Some Other",
  dependencies: ["conversation"],
  contributions: [
    Conversation.Actions({ label: "Do thing", icon: MdStar, onClick: () => { ... } }),
  ],
};
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
    // Collect all contributions from all plugins
    const contributions = plugins.flatMap((p) => p.contributions ?? []);
    return { plugins, contributions };
  }, [plugins]);

  // Mount all plugin roots (nested, in order)
  let tree = <>{children}</>;
  for (const plugin of [...plugins].reverse()) {
    if (plugin.root) {
      const Root = plugin.root;
      tree = <Root>{tree}</Root>;
    }
  }

  return (
    <PluginRuntimeContext.Provider value={runtime}>
      {tree}
    </PluginRuntimeContext.Provider>
  );
}
```

Wait — the root components need to receive `children` for the nesting to work. The shell's `ShellLayout` wouldn't pass `children` through though, since it renders its own layout. Let me reconsider.

Actually, the root nesting is for things like context providers. The shell plugin's root renders the actual layout — it doesn't need to wrap children. Background-only plugins don't render anything.

Simpler approach — just mount all roots as siblings:

```typescript
function PluginProvider({ plugins, children }: { plugins: PluginDefinition[]; children: ReactNode }) {
  const runtime = useMemo(() => {
    const contributions = plugins.flatMap((p) => p.contributions ?? []);
    return { plugins, contributions };
  }, [plugins]);

  return (
    <PluginRuntimeContext.Provider value={runtime}>
      {plugins.map((p) => p.root ? <p.root key={p.id} /> : null)}
      {children}
    </PluginRuntimeContext.Provider>
  );
}
```

And `App.tsx` becomes:

```typescript
function App() {
  return <PluginProvider plugins={plugins} />;
}
```

The shell plugin's root IS the app layout. No `children` needed in App.

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
│       ├── App.tsx                     # PluginProvider wrapping all plugins
│       ├── plugins.ts                  # Hardcoded plugin list
│       └── plugin-api/
│           ├── types.ts               # PluginDefinition, Contribution, PluginId
│           ├── slots.ts               # defineSlot, Slot type
│           └── context.tsx            # PluginProvider, PluginRuntimeContext
│
├── plugins/
│   ├── shell/
│   │   └── web/
│   │       ├── index.ts              # Shell plugin definition (root = ShellLayout)
│   │       ├── slots.ts              # Shell.Sidebar, Shell.Main, Shell.Toolbar, Shell.StatusBar
│   │       └── components/
│   │           └── shell-layout.tsx   # The actual layout component
│   │
│   └── {other-plugin}/
│       └── web/
│           ├── index.ts              # Plugin definition with contributions
│           ├── slots.ts              # Optional: slots this plugin defines
│           └── components/           # Plugin components
```

## Build Configuration

### Vite (`web/vite.config.ts`)

```typescript
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@plugins": path.resolve(__dirname, "../plugins"),
    },
  },
});
```

### TypeScript (`web/tsconfig.app.json`)

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

No changes needed — Tailwind v4 auto-scans imported files.

## Inter-Plugin Communication

Deferred. The slot system handles structural composition (plugin A contributes UI to plugin B's layout). For runtime communication (events, shared state), we'll design a solution when concrete use cases arise.

## Implementation Order

1. **Plugin API core** — `types.ts`, `slots.ts`, `context.tsx`
2. **Build config** — `vite.config.ts` + `tsconfig.app.json`
3. **Shell plugin** — `plugins/shell/web/` (slots + layout component)
4. **Plugin registry** — `web/src/plugins.ts`
5. **Update App.tsx** — Wire up PluginProvider
6. **Hello world plugin** — minimal plugin contributing to Shell.Sidebar to validate

## Verification

1. `bun dev` — app starts, shell layout renders
2. Hello world plugin's contribution appears in the sidebar
3. Removing a plugin from the registry makes its contributions disappear
4. Empty regions (e.g., no toolbar contributions) are not rendered
5. `bun build` — no type errors
