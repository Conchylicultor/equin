# AppShellLayout Sidebar Redesign

## Context

`AppShellLayout` is a reusable sidebar + toolbar + miller-columns layout used by three apps (AgentManager, Debug, FileExplorer). Its sidebar rendering has a design problem: the host inspects optional fields on a polymorphic contribution type (`onClick?`, `component?`, `scroll?`) to decide what to render, splitting contributions into three filtered sub-areas with separate `Reorder.useArea` calls, `DndWrapper` contexts, and manual `PluginErrorBoundary` wrapping.

**In practice, the polymorphism is barely used:**
- `Shell.Sidebar`: 7 onClick-only buttons + 1 `component+scroll` (conversations-view)
- `DebugApp.Sidebar`: 8 onClick-only buttons, zero use `component`/`scroll`/`group`
- `FileExplorer.Sidebar`: zero contributors

The 3-way filter, ~190 lines of host rendering, and three separate DnD contexts exist to serve **one** contributor.

The fix: each contribution provides a self-rendering `component`. The host becomes `<slot.Render>{item => <item.component />}</slot.Render>`. The sidebar migrates to `defineRenderSlot`, gaining auto-applied error boundaries and reorder middleware.

## Design

### New contribution type

```ts
export type AppShellSidebarItem = {
  title: string;                                    // for reorder getLabel + docLabel
  icon: ComponentType<{ className?: string }>;       // for reorder label display
  component: ComponentType;                          // fully self-rendering
};
```

Dropped fields: `onClick`, `group`, `labelExtra`, `scroll`. All behavior moves into the `component`.

### Host rendering

`AppShellLayout` sidebar collapses from ~190 lines to:

```tsx
<Sidebar>
  {header && <SidebarHeader>...</SidebarHeader>}
  <SidebarContent>
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <sidebarSlot.Render>
            {(item) => <item.component />}
          </sidebarSlot.Render>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  </SidebarContent>
</Sidebar>
```

Removed: 3 `Reorder.useArea` calls, `buttonGroups` memo, `collapsed` state, `toggleSection`, `visibleScrollPanes`, all filtering logic, `DndWrapper`/`ReorderItem`/`PluginErrorBoundary` manual loops.

Removed props: `defaultCollapsed`, `sidebarGroupIcons` — each contribution owns its own visual behavior.

### Building blocks from `app-shell`

**`SidebarNavItem`** — the common "click to open a pane" pattern:

```tsx
// plugins/primitives/plugins/app-shell/web/components/sidebar-nav-item.tsx
export function SidebarNavItem({ icon: Icon, title, onClick }: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={onClick}>
        <Icon className="size-4" />
        <span>{title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
```

**`sidebarNavItem()`** — factory returning `{ title, icon, component }` with zero duplication:

```ts
export function sidebarNavItem(opts: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
}): Omit<AppShellSidebarItem, 'id'> {
  return {
    title: opts.title,
    icon: opts.icon,
    component: () => <SidebarNavItem icon={opts.icon} title={opts.title} onClick={opts.onClick} />,
  };
}
```

**`SidebarPaneSection`** — collapsible embedded content:

```tsx
// plugins/primitives/plugins/app-shell/web/components/sidebar-pane-section.tsx
export function SidebarPaneSection({ icon: Icon, title, labelExtra, defaultOpen = true, children }: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  labelExtra?: ComponentType;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <SidebarGroup>
      <SidebarGroupLabel
        className="group/label cursor-pointer select-none hover:text-sidebar-foreground"
        onClick={() => setIsOpen(!isOpen)}
      >
        <Icon className="size-4 mr-2" />
        {title}
        {labelExtra && <labelExtra />}
        <MdChevronRight
          className={`ml-auto size-4 transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}
        />
      </SidebarGroupLabel>
      {isOpen && <SidebarGroupContent>{children}</SidebarGroupContent>}
    </SidebarGroup>
  );
}
```

### Slot definitions → `defineRenderSlot`

**`Shell.Sidebar`** (`plugins/shell/web/slots.ts`):

```ts
// Before
Sidebar: Reorder.area(
  defineSlot<{title, icon, onClick?, component?, group?, labelExtra?, scroll?}>("shell.sidebar", ...),
  { getGroup: ..., getLabel: ..., enableGroups: true },
),

// After
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { AppShellSidebarItem } from "@plugins/primitives/plugins/app-shell/web";

Sidebar: defineRenderSlot<AppShellSidebarItem>("shell.sidebar", {
  docLabel: (p) => p.title,
  reorder: { getLabel: (item) => item.title, enableGroups: true },
}),
```

**`DebugApp.Sidebar`** (`plugins/apps/plugins/debug/plugins/shell/web/slots.ts`):

```ts
Sidebar: defineRenderSlot<AppShellSidebarItem>("debug-app.sidebar", {
  docLabel: (p) => p.title,
  reorder: { getLabel: (item) => item.title },
}),
```

**`FileExplorer.Sidebar`** (`plugins/apps/plugins/file-explorer/plugins/shell/web/slots.ts`):

```ts
Sidebar: defineRenderSlot<AppShellSidebarItem>("file-explorer.sidebar", {
  docLabel: (p) => p.title,
  reorder: { getLabel: (item) => item.title },
}),
```

### AppShellLayout prop changes

```ts
// Before
export function AppShellLayout({
  sidebarSlot,
  toolbarSlot,
  header,
  defaultCollapsed,
  sidebarGroupIcons,
}: {
  sidebarSlot: ReorderableSlot<AppShellSidebarItem>;
  toolbarSlot: ReorderableSlot<AppShellToolbarItem>;
  header?: ReactNode;
  defaultCollapsed?: Set<string>;
  sidebarGroupIcons?: Record<string, ComponentType<{ className?: string }>>;
})

// After
export function AppShellLayout({
  sidebarSlot,
  toolbarSlot,
  header,
}: {
  sidebarSlot: RenderSlot<AppShellSidebarItem>;
  toolbarSlot: ReorderableSlot<AppShellToolbarItem>;  // toolbar stays legacy for now
  header?: ReactNode;
})
```

### Contributor updates

**Shell.Sidebar — 7 onClick contributors** (mechanical, use `sidebarNavItem` factory):

```ts
// Before (e.g. stats)
Shell.Sidebar({ id: "stats", title: "Stats", icon: MdInsights, group: "System", onClick: () => statsPane.open({}) })

// After
import { sidebarNavItem } from "@plugins/primitives/plugins/app-shell/web";
Shell.Sidebar({ id: "stats", ...sidebarNavItem({ title: "Stats", icon: MdInsights, onClick: () => statsPane.open({}) }) })
```

All 7: auth, config, stats, agents, task-detail, code-explorer, publish.

**Shell.Sidebar — conversations-view** — custom component wrapping `SidebarPaneSection`:

```ts
// Before
Shell.Sidebar({
  id: "conversations", title: "Conversations", icon: MdForum,
  component: ConversationList, labelExtra: ConvCountLabel, scroll: true,
})

// After
Shell.Sidebar({
  id: "conversations", title: "Conversations", icon: MdForum,
  component: ConversationsSidebar,
})
```

Where `ConversationsSidebar` is a new component:
```tsx
import { SidebarPaneSection } from "@plugins/primitives/plugins/app-shell/web";
function ConversationsSidebar() {
  return (
    <SidebarPaneSection title="Conversations" icon={MdForum} labelExtra={ConvCountLabel}>
      <ConversationList />
    </SidebarPaneSection>
  );
}
```

**DebugApp.Sidebar — 8 onClick contributors** — same `sidebarNavItem` factory:

logs, queue, memory, profiling, broadcasts, conversations-recover, events-test, worktree-cleanup, db-backup, claude-cli-calls.

**AgentManagerLayout** — remove `defaultCollapsed` and `sidebarGroupIcons` props.

### Toolbar (not in scope)

`Shell.Toolbar` and `DebugApp.Toolbar` have the same `onClick`/`component` polymorphism. Deferred to a follow-up — this plan focuses on the sidebar.

## Files changed

| File | Change |
|------|--------|
| `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` | Simplify sidebar rendering |
| `plugins/primitives/plugins/app-shell/web/components/sidebar-nav-item.tsx` | **New** — `SidebarNavItem` + `sidebarNavItem()` |
| `plugins/primitives/plugins/app-shell/web/components/sidebar-pane-section.tsx` | **New** — `SidebarPaneSection` |
| `plugins/primitives/plugins/app-shell/web/index.ts` | Export new components + types |
| `plugins/shell/web/slots.ts` | `Reorder.area(defineSlot)` → `defineRenderSlot` |
| `plugins/apps/plugins/debug/plugins/shell/web/slots.ts` | Same |
| `plugins/apps/plugins/file-explorer/plugins/shell/web/slots.ts` | Same |
| `plugins/apps/plugins/agent-manager/plugins/shell/web/components/agent-manager-layout.tsx` | Remove `defaultCollapsed`, `sidebarGroupIcons` |
| `plugins/auth/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/config/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/stats/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/agents/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/tasks/plugins/task-detail/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/code-explorer/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/plugin-meta/plugins/publish/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/conversations/plugins/conversations-view/web/index.ts` | Use custom `ConversationsSidebar` |
| `plugins/debug/plugins/logs/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/debug/plugins/queue/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/debug/plugins/memory/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/debug/plugins/profiling/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/debug/plugins/broadcasts/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/debug/plugins/worktree-cleanup/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/debug/plugins/db-backup/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/debug/plugins/claude-cli-calls/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/conversations-recover/web/index.ts` | Use `sidebarNavItem()` |
| `plugins/events-test/web/index.ts` | Use `sidebarNavItem()` |

## Verification

1. `./equin build` — TypeScript catches type mismatches
2. App renders at `http://<worktree>.localhost:9000`
3. **Agent manager sidebar:** all 7 buttons + conversations section render; buttons open their panes; conversations list scrolls and collapses
4. **Debug sidebar:** all buttons render and open their panes
5. **Edit mode:** pen button → sidebar items are draggable, reorder persists
6. `./equin check` passes
