# Shell App Rail

## Context

Singularity is evolving from a single-purpose agent manager into a multi-app platform (agent manager + deploy platform, more to come). We need a narrow icon rail on the far left to switch between apps — minimal, small icons only, no labels.

## Approach

### New `Shell.App` slot

Add to `plugins/shell/web/slots.ts`:

```ts
App: defineSlot<{
  id: string;
  icon: ComponentType<{ className?: string }>;
  tooltip: string;
  isActive: (pathname: string) => boolean;
  onClick: () => void;
}>("shell.app"),
```

No `Reorder.area` — app order is stable, not user-reorderable.

### Rail component

**New file: `plugins/shell/web/components/app-rail.tsx`**

- Renders `Shell.App.useContributions()` as icon buttons in a 40px-wide vertical strip
- Active state via `useSyncExternalStore` + `popstate` listener (matches existing nav pattern)
- Active indicator: `bg-sidebar-accent` (same token as `SidebarMenuButton`)
- Tooltip on hover (`side="right"`)
- Styling: `bg-sidebar border-r`, `size-8` buttons with `size-4` icons

### Shell layout change

**File: `plugins/shell/web/components/shell-layout.tsx`**

Wrap existing layout with the rail, outside `SidebarProvider` (unaffected by sidebar collapse):

```tsx
<TooltipProvider>
  <div className="flex h-full min-h-0">
    <AppRail />
    <SidebarProvider className="h-full min-h-0 flex-1">
      {/* existing sidebar + inset unchanged */}
    </SidebarProvider>
  </div>
</TooltipProvider>
```

Clear `SIDEBAR_GROUPS` (remove `System` entry) since the group is replaced by the rail.

### App contributions

**Agent Manager** — contributed by `plugins/shell/web/index.ts`:
- Icon: `MdDashboard` (or the singularity logo `/icon.svg`)
- `isActive: (path) => !path.startsWith("/deploy")` — catch-all default
- `onClick`: navigate to `/`

**Deploy** — contributed by `plugins/deploy/plugins/servers/web/index.ts`:
- Icon: `MdCloud` (existing)
- `isActive: (path) => path.startsWith("/deploy")`
- `onClick`: `serversRootPane.open({})`
- **Replaces** the existing `Shell.Sidebar` contribution (removed from sidebar)

### Sidebar cleanup

- **Tasks** (`plugins/tasks/plugins/task-detail/web/index.ts`): remove `group: "System"` → becomes ungrouped button
- **Agents** (`plugins/agents/web/index.ts`): remove `group: "System"` → becomes ungrouped button
- **Deploy**: remove `Shell.Sidebar` entirely (replaced by `Shell.App`)

## Files

| File | Change |
|---|---|
| `plugins/shell/web/slots.ts` | Add `Shell.App` slot |
| `plugins/shell/web/components/app-rail.tsx` | **New** — rail component |
| `plugins/shell/web/components/shell-layout.tsx` | Wrap with rail, clear `SIDEBAR_GROUPS` |
| `plugins/shell/web/index.ts` | Add `Shell.App` contribution (Agent Manager) |
| `plugins/deploy/plugins/servers/web/index.ts` | Replace `Shell.Sidebar` → `Shell.App` |
| `plugins/tasks/plugins/task-detail/web/index.ts` | Remove `group: "System"` |
| `plugins/agents/web/index.ts` | Remove `group: "System"` |

## Verification

```bash
./equin build
# Visit http://<worktree>.localhost:9000
```

- 40px rail appears left of sidebar with two icons
- Hover shows tooltip ("Agent Manager", "Deploy")
- At `/`, `/tasks/*`, `/agents/*`: agent manager icon highlighted
- At `/deploy/*`: cloud icon highlighted
- Click navigates to the app's root
- Sidebar no longer has "System" header; Tasks/Agents are plain buttons
- Rail unaffected by sidebar collapse
