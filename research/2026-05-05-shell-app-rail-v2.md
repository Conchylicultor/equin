# App Switcher — v2

## Context

equin is evolving from a single-purpose agent manager into a multi-app platform. Each app should own its entire shell (layout, sidebar, toolbar), not just a pane inside a shared shell. A new **`apps` plugin** wraps the shell layer itself: it takes over `Core.Root`, renders a narrow icon rail, and displays whichever app's shell is active.

V1 scope: build the infrastructure + wire up the Agent Manager as the first (and only) app. No sidebar changes, no deploy changes — deploy contributes its own app shell in a follow-up.

## Architecture

```
Before:  Core.Root → ShellLayout

After:   Core.Root → AppsLayout
                      ├── AppRail (40px icon strip)
                      └── Active app's component
                          └── Apps.App slot
                              └── "agent-manager" → ShellLayout
```

Each app contributes `{ icon, tooltip, component, isActive, onClick }` to `Apps.App`. The `component` is the app's full shell — everything to the right of the rail. Switching apps swaps which component is displayed.

## Implementation

### 1. New plugin: `plugins/apps/`

```
plugins/apps/
  web/
    index.ts                    # plugin def → Core.Root({ component: AppsLayout })
    slots.ts                    # Apps.App slot definition
    components/
      apps-layout.tsx           # [AppRail | activeApp.component]
      app-rail.tsx              # narrow icon strip
```

#### `plugins/apps/web/slots.ts`

```ts
import { defineSlot } from "@core";
import { Reorder } from "@plugins/reorder/web";

export const Apps = {
  App: Reorder.area(
    defineSlot<{
      icon: ComponentType<{ className?: string }>;
      tooltip: string;
      component: ComponentType;
      isActive: (pathname: string) => boolean;
      onClick: () => void;
    }>("apps.app"),
  ),
};
```

Reorder.area adds `id: string` automatically. Users can reorder apps in the rail via the existing edit-mode toggle.

#### `plugins/apps/web/components/apps-layout.tsx`

```tsx
export function AppsLayout() {
  const appsArea = Reorder.useArea(Apps.App);
  const pathname = usePathname(); // useSyncExternalStore + popstate

  const activeApp = appsArea.items.find(a => a.isActive(pathname))
    ?? appsArea.items[0];

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0">
        <AppRail area={appsArea} activeAppId={activeApp?.id} />
        <div className="min-w-0 flex-1">
          {activeApp && <activeApp.component />}
        </div>
      </div>
    </TooltipProvider>
  );
}
```

Notes:
- `TooltipProvider` moves HERE from `shell-layout.tsx` (the apps layer now owns the outermost wrapper)
- Rail is outside `SidebarProvider` → unaffected by sidebar collapse
- Active app determined by `isActive(pathname)` with fallback to first item

#### `plugins/apps/web/components/app-rail.tsx`

```tsx
export function AppRail({ area, activeAppId }) {
  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r bg-sidebar pt-3">
      <area.DndWrapper>
        {area.items.map(app => (
          <area.ReorderItem key={app.id} item={app}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={app.onClick}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    app.id === activeAppId && "bg-sidebar-accent text-sidebar-accent-foreground",
                  )}
                >
                  <app.icon className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{app.tooltip}</TooltipContent>
            </Tooltip>
          </area.ReorderItem>
        ))}
      </area.DndWrapper>
    </div>
  );
}
```

40px rail, 32px icon buttons, sidebar-accent active state, right-side tooltips.

#### `plugins/apps/web/index.ts`

```ts
export { Apps } from "./slots";

export default {
  id: "apps",
  name: "Apps",
  description: "App switcher rail. Wraps per-app shells; plugins contribute via Apps.App.",
  loadBearing: true,
  contributions: [Core.Root({ component: AppsLayout })],
} satisfies PluginDefinition;
```

### 2. Shell becomes an app

**File: `plugins/shell/web/index.ts`**

```ts
// Before:
import { Core, type PluginDefinition } from "@core";
contributions: [Core.Root({ component: ShellLayout })]

// After:
import { type PluginDefinition } from "@core";
import { Apps } from "@plugins/apps/web";
import { MdDashboard } from "react-icons/md";
contributions: [
  Apps.App({
    id: "agent-manager",
    icon: MdDashboard,
    tooltip: "Agent Manager",
    component: ShellLayout,
    isActive: () => true,  // default/catch-all — always active for v1
    onClick: () => {
      history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
  }),
]
```

**File: `plugins/shell/web/components/shell-layout.tsx`**

Remove `<TooltipProvider>` wrapper (moved to AppsLayout). The return becomes:

```tsx
return (
  <>
    <SidebarProvider className="h-full min-h-0">
      {/* ... existing sidebar + inset unchanged ... */}
    </SidebarProvider>
    <Toaster />
  </>
);
```

No other changes to the shell. Sidebar, toolbar, System group, all sidebar contributions — untouched.

## Files

| File | Change |
|---|---|
| `plugins/apps/web/slots.ts` | **New** — `Apps.App` slot (Reorder.area wrapped) |
| `plugins/apps/web/components/app-rail.tsx` | **New** — rail component |
| `plugins/apps/web/components/apps-layout.tsx` | **New** — layout: rail + active app |
| `plugins/apps/web/index.ts` | **New** — plugin def, Core.Root contribution |
| `plugins/shell/web/index.ts` | Change `Core.Root` → `Apps.App` contribution |
| `plugins/shell/web/components/shell-layout.tsx` | Remove `TooltipProvider` wrapper |

No sidebar changes. No deploy changes. System group stays as-is.

## Follow-ups (not in scope)

- Deploy contributes `Apps.App({ component: DeployShell, ... })`, gets removed from `Shell.Sidebar`
- Deploy's sidebar button → removed (replaced by rail icon)
- Per-app sidebar scoping (sidebar shows only contributions relevant to active app)

## Verification

```bash
./equin build
# Visit http://<worktree>.localhost:9000
```

- 40px rail appears to the left of the sidebar with one icon (Agent Manager)
- Hover shows tooltip "Agent Manager"
- Icon is highlighted (active state)
- Sidebar is unchanged — System group with Tasks, Agents, Deploy all present
- Sidebar collapse/expand does not affect the rail
- All existing navigation (panes, URLs) works unchanged
- Edit mode (pen button) enables drag on the rail (no-op with one item, but infrastructure is there)
