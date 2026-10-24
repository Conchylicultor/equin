# Migrate Visual Slots to RenderSlot.Render

## Context

`defineRenderSlot` was introduced in `plugins/primitives/plugins/slot-render/` (design doc: `research/2026-05-11-plugin-core-slot-render.md`). It wraps `defineSlot` and produces a `RenderSlot<P>` with an auto-rendering `.Render` component that applies middleware (error boundary, reorder) without manual boilerplate. `Conversation.ActionBar` was the pilot migration.

Five candidate slots were evaluated. Two are direct migrations, one (`AppShellLayout` sidebar) requires a design fix first, and two remain excluded.

## Migration 1: `Stats.Chart`

**Files:**
- `plugins/stats/web/slots.ts` — slot definition
- `plugins/stats/web/components/stats-panel.tsx` — host

**Slot definition** — replace `defineSlot` with `defineRenderSlot`. Drop explicit `id: string` from the type (injected by `RenderSlot<P & { id: string }>`):

```ts
// Before
import { defineSlot } from "@core";
Chart: defineSlot<{ id: string; title: string; component: ComponentType }>("stats.chart", ...)

// After
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
Chart: defineRenderSlot<{ title: string; component: ComponentType }>("stats.chart", ...)
```

**Host** — keep `useContributions()` for the empty-state guard; replace `charts.map(...)` with `<Render>`:

```tsx
// Before
charts.map((c) => (
  <section key={c.id} className="bg-card rounded-lg border p-4">
    <h2 className="mb-4 text-sm font-medium">{c.title}</h2>
    <c.component />
  </section>
))

// After
<Stats.Chart.Render>
  {(item) => (
    <section className="bg-card rounded-lg border p-4">
      <h2 className="mb-4 text-sm font-medium">{item.title}</h2>
      <item.component />
    </section>
  )}
</Stats.Chart.Render>
```

**Contributors** — no changes. All 8 already pass `{ id, title, component }`.

**Gains:** per-chart error boundaries (none today), reorder capability.

## Migration 2: `Conversation.AbovePromptInput`

**Files:**
- `plugins/conversations/plugins/conversation-view/web/slots.ts` — slot definition
- `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx` — host

**Slot definition** — replace `Reorder.area(defineSlot(...))` with `defineRenderSlot(...)`:

```ts
// Before (line 20-24)
AbovePromptInput: Reorder.area(
  defineSlot<{ component: ComponentType<{ conversation: ConversationRecord }> }>(
    "conversation.above-prompt-input"),
),

// After
AbovePromptInput: defineRenderSlot<{
  component: ComponentType<{ conversation: ConversationRecord }>;
}>("conversation.above-prompt-input"),
```

Keep `Reorder` import because `PromptBar` still uses `Reorder.area` in the same file.

**Host** — replace `Reorder.useArea` + `DndWrapper` + `ReorderItem` + `PluginErrorBoundary`:

```tsx
// Before (line 74, lines 107-118)
const abovePromptInput = Reorder.useArea(Conversation.AbovePromptInput);
// ... showBottomBar uses abovePromptInput.items.length ...
<abovePromptInput.DndWrapper>
  {abovePromptInput.items.map((item) => (
    <abovePromptInput.ReorderItem key={item.id} item={item}>
      <PluginErrorBoundary slot={Conversation.AbovePromptInput.id}>
        <Cmp conversation={conversation} />
      </PluginErrorBoundary>
    </abovePromptInput.ReorderItem>
  ))}
</abovePromptInput.DndWrapper>

// After
const abovePromptInputItems = Conversation.AbovePromptInput.useContributions();
// ... showBottomBar uses abovePromptInputItems.length ...
<Conversation.AbovePromptInput.Render>
  {(item) => <item.component conversation={conversation} />}
</Conversation.AbovePromptInput.Render>
```

Remove `PluginErrorBoundary` import (now auto-applied by middleware).

**Contributors** — no changes. All 4 already pass `{ id, component }`.

## Migration 3: AppShellLayout Sidebar Redesign

### Problem

`AppShellLayout` renders sidebar contributions with a 3-way filter (`!!onClick && !component`, `!!component && !scroll`, `!!component && scroll`), three separate `Reorder.useArea` calls, and host-driven rendering of `SidebarMenuButton`/`SidebarGroupLabel`. This complexity exists to accommodate a polymorphic contribution type where the host inspects optional fields to decide what to render.

**In practice:** Shell.Sidebar has 7 onClick-only buttons + 1 component+scroll section (conversations-view). DebugApp.Sidebar has 8 onClick-only buttons, zero use `component`/`scroll`. FileExplorer.Sidebar has zero contributors. The entire 3-way split serves one contributor.

### Design: each contribution renders itself

New contribution type — contributions provide a `component` instead of data fields for the host to interpret:

```ts
// plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx
export type AppShellSidebarItem = {
  title: string;                                    // for reorder getLabel + docLabel
  icon: ComponentType<{ className?: string }>;       // for reorder label display
  component: ComponentType;                          // fully self-rendering
};
```

The host becomes:

```tsx
<SidebarContent>
  <SidebarMenu>
    <sidebarSlot.Render>
      {(item) => <item.component />}
    </sidebarSlot.Render>
  </SidebarMenu>
</SidebarContent>
```

No filtering, no shape inspection, no 3 separate `DndWrapper` contexts. The `defaultCollapsed` and `sidebarGroupIcons` props are dropped — each contribution owns its own visual behavior.

### Building blocks exported from `app-shell`

**`SidebarNavItem`** — for the common "click to open a pane" pattern (7/8 Shell.Sidebar + 8/8 DebugApp.Sidebar contributors):

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

**`sidebarNavItem()`** — factory that returns `{ title, icon, component }` with zero duplication:

```ts
// plugins/primitives/plugins/app-shell/web/components/sidebar-nav-item.tsx
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

**`SidebarPaneSection`** — for collapsible embedded content (used by conversations-view):

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
      <SidebarGroupLabel className="..." onClick={() => setIsOpen(!isOpen)}>
        <Icon className="size-4 mr-2" />
        {title}
        {labelExtra && <labelExtra />}
        <MdChevronRight className={`... ${isOpen ? "rotate-90" : ""}`} />
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
// After
Sidebar: defineRenderSlot<AppShellSidebarItem>("debug-app.sidebar", {
  docLabel: (p) => p.title,
  reorder: { getLabel: (item) => item.title },
}),
```

**`FileExplorer.Sidebar`** (`plugins/apps/plugins/file-explorer/plugins/shell/web/slots.ts`):

```ts
// After
Sidebar: defineRenderSlot<AppShellSidebarItem>("file-explorer.sidebar", {
  docLabel: (p) => p.title,
  reorder: { getLabel: (item) => item.title },
}),
```

### AppShellLayout simplification

**File:** `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx`

The sidebar rendering (lines 109-298, ~190 lines) collapses to:

```tsx
export function AppShellLayout({
  sidebarSlot,
  toolbarSlot,
  header,
}: {
  sidebarSlot: RenderSlot<AppShellSidebarItem>;
  toolbarSlot: ReorderableSlot<AppShellToolbarItem>;  // toolbar stays legacy for now
  header?: ReactNode;
}) {
  // ... toolbar rendering stays as-is ...

  return (
    <SidebarProvider className="h-full min-h-0">
      <Sidebar>
        {header && <SidebarHeader className="h-12 justify-center border-b px-4 py-0">{header}</SidebarHeader>}
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
      <SidebarInset>
        {/* toolbar + main content unchanged */}
      </SidebarInset>
    </SidebarProvider>
  );
}
```

**Removed:** 3 `Reorder.useArea` calls, `buttonGroups` memo, `collapsed` state, `toggleSection`, `visibleScrollPanes`, all filtering logic, `DndWrapper`/`ReorderItem`/`PluginErrorBoundary` manual loops. Also removed props: `defaultCollapsed`, `sidebarGroupIcons`.

**Imports removed from AppShellLayout:** `Reorder`, `isGroupEntry`, `isSpacer`, `PluginErrorBoundary` (for sidebar — toolbar still uses some of these).
**Import added:** `RenderSlot` type from `@plugins/primitives/plugins/slot-render/web`.

### Contributor updates

**Shell.Sidebar — 7 onClick contributors** (mechanical, use `sidebarNavItem` factory):

| Plugin | File | Before | After |
|--------|------|--------|-------|
| auth | `plugins/auth/web/index.ts` | `{ id, title, icon, group, onClick }` | `{ id, ...sidebarNavItem({ title, icon, onClick }) }` |
| config | `plugins/config/web/index.ts` | same | same |
| stats | `plugins/stats/web/index.ts` | same | same |
| agents | `plugins/agents/web/index.ts` | same | same |
| task-detail | `plugins/tasks/plugins/task-detail/web/index.ts` | same | same |
| code-explorer | `plugins/code-explorer/web/index.ts` | same | same |
| publish | `plugins/plugin-meta/plugins/publish/web/index.ts` | same | same |

Each drops `group: "System"` (no longer in type) and wraps in the factory.

Example (stats):
```ts
// Before
Shell.Sidebar({ id: "stats", title: "Stats", icon: MdInsights, group: "System", onClick: () => statsPane.open({}) })

// After
import { sidebarNavItem } from "@plugins/primitives/plugins/app-shell/web";
Shell.Sidebar({ id: "stats", ...sidebarNavItem({ title: "Stats", icon: MdInsights, onClick: () => statsPane.open({}) }) })
```

**Shell.Sidebar — conversations-view** (`plugins/conversations/plugins/conversations-view/web/index.ts`):

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

Where `ConversationsSidebar` is a new component in the same plugin:
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

**DebugApp.Sidebar — 8 onClick contributors** (same mechanical change, `sidebarNavItem` factory):

| Plugin | File |
|--------|------|
| logs | `plugins/debug/plugins/logs/web/index.ts` |
| queue | `plugins/debug/plugins/queue/web/index.ts` |
| memory | `plugins/debug/plugins/memory/web/index.ts` |
| profiling | `plugins/debug/plugins/profiling/web/index.ts` |
| broadcasts | `plugins/debug/plugins/broadcasts/web/index.ts` |
| conversations-recover | `plugins/conversations-recover/web/index.ts` |
| events-test | `plugins/events-test/web/index.ts` |
| worktree-cleanup | `plugins/debug/plugins/worktree-cleanup/web/index.ts` |
| db-backup | `plugins/debug/plugins/db-backup/web/index.ts` |
| claude-cli-calls | `plugins/debug/plugins/claude-cli-calls/web/index.ts` |

**AgentManagerLayout** (`plugins/apps/plugins/agent-manager/plugins/shell/web/components/agent-manager-layout.tsx`):

Remove `defaultCollapsed` and `sidebarGroupIcons` props (no longer accepted by `AppShellLayout`).

## Excluded Slots

### Pane `.Actions` — position filter + overflow measurement

Two rendering paths filter by `position` and the overflow path does ResizeObserver-based DOM measurement. Incompatible with `<Render>`'s opaque middleware wrapping.

### `Auth.Provider` — data-dispatch, not visual list

Contributions carry rich config; the host selects `rowComponent ?? DefaultProviderRow`. Data registry pattern, not a visual extension point.

## Toolbar (flagged, not in scope)

`Shell.Toolbar` and `DebugApp.Toolbar` have the same `onClick`/`component` polymorphism as the sidebar did. Migrating them follows the same pattern (export a `toolbarButton()` factory from app-shell, flatten AppShellLayout's toolbar rendering). Deferred to a follow-up — this plan focuses on the sidebar.

## Execution Order

1. `Stats.Chart` — simplest, no entanglements
2. `Conversation.AbovePromptInput` — simple Reorder.area swap
3. AppShellLayout sidebar redesign:
   a. Add building blocks (`SidebarNavItem`, `sidebarNavItem`, `SidebarPaneSection`) to app-shell
   b. Simplify `AppShellLayout` sidebar rendering to use `<Render>`
   c. Migrate `Shell.Sidebar`, `DebugApp.Sidebar`, `FileExplorer.Sidebar` slot definitions
   d. Update all 15+ sidebar contributors
   e. Clean up `AgentManagerLayout` props

## Verification

1. `./equin build` — TypeScript catches type mismatches
2. App renders at `http://<worktree>.localhost:9000`
3. **Stats pane:** all 8 charts render with headings; force-throw in one chart → only that chart shows error fallback
4. **Conversation view:** above-prompt area renders; enter edit mode → items are draggable
5. **Agent manager sidebar:** all 7 buttons + conversations section render; buttons open their panes; conversations list scrolls
6. **Debug sidebar:** all 8 buttons render and open their panes
7. **Edit mode:** pen button → sidebar items are draggable, reorder persists
8. `./equin check` passes
