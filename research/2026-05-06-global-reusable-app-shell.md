# Reusable App Shell + File Explorer App

## Context

The project is evolving toward multiple top-level apps (agent manager, deploy, file explorer, ...). Today, each app builds its own layout from scratch — the agent-manager's `ShellLayout` is 200+ lines of sidebar/toolbar/miller-columns chrome that can't be reused, while the deploy app opted for a bare `<MillerColumns />` with no sidebar at all.

We want a **shared layout primitive** that any app can instantiate with its own slot set, getting the full sidebar + toolbar + miller-columns chrome without duplicating the implementation. The file-explorer app is the first consumer beyond the agent manager.

## End-User Experience

**Plugin author creating a new app with full sidebar+toolbar chrome:**

```tsx
// 1. Define your app's slots (slots.ts)
export const FileExplorer = {
  Sidebar: Reorder.area(defineSlot<SidebarItem>("file-explorer.sidebar"), ...),
  Toolbar: Reorder.area(defineSlot<ToolbarItem>("file-explorer.toolbar"), ...),
};

// 2. Create your layout (one component, ~10 lines)
// Slots and layout both live in the shell sub-plugin — the namespace plugin is empty.
import { AppShellLayout } from "@plugins/primitives/plugins/app-shell/web";
import { FileExplorer } from "@plugins/apps/file-explorer/plugins/shell/web";

export function FileExplorerLayout() {
  return (
    <AppShellLayout
      sidebarSlot={FileExplorer.Sidebar}
      toolbarSlot={FileExplorer.Toolbar}
    />
  );
}

// 3. Register the app
Apps.App({
  id: "file-explorer",
  icon: MdFolder,
  tooltip: "File Explorer",
  component: FileExplorerLayout,
  path: "/files",
})
```

**End user:** A new folder icon appears in the app rail. Clicking it navigates to `/files` and renders a sidebar + toolbar + miller-columns layout — same chrome as the agent manager, but empty (no contributions yet).

## Implementation

### Step 1: `app-shell` primitive

Extract `ShellLayout`'s layout chrome into a parameterized component.

**New files:**
- `plugins/primitives/plugins/app-shell/package.json` — `@singularity/plugin-primitives-app-shell`
- `plugins/primitives/plugins/app-shell/web/index.ts` — barrel: exports `AppShellLayout` + item types
- `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` — the component

**Component API:**

```tsx
import type { ReorderableSlot } from "@plugins/reorder/web";

type AppShellSidebarItem = {
  id: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  onClick?: () => void;
  component?: ComponentType;
  group?: string;
  labelExtra?: ComponentType;
  scroll?: boolean;
  excludeFromReorder?: boolean;
};

type AppShellToolbarItem = {
  id: string;
  label?: string;
  icon?: ComponentType<{ className?: string }>;
  onClick?: () => void;
  component?: ComponentType;
  group?: string;
  excludeFromReorder?: boolean;
};

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
```

The body is a direct lift of `shell-layout.tsx` with these substitutions:
- `Shell.Sidebar` → `sidebarSlot` prop
- `Shell.Toolbar` → `toolbarSlot` prop
- `DEFAULT_COLLAPSED` → `defaultCollapsed ?? new Set()` prop
- `SIDEBAR_GROUPS` → `sidebarGroupIcons` prop
- Hardcoded `<SidebarHeader>` with equin logo → `{header && <SidebarHeader ...>{header}</SidebarHeader>}`
- `slot="shell.sidebar"` / `slot="shell.toolbar"` on `PluginErrorBoundary` → dynamic `slot={sidebarSlot.id}` / `slot={toolbarSlot.id}`

Internal helpers `ToolbarItem` and `PaneSectionLabel` move into this file unchanged.

### Step 2: File Explorer namespace plugin

Per create-app rules: the top-level plugin is **empty** — namespace only. No slots, no components, no logic.

**New files:**
- `plugins/apps/file-explorer/package.json` — `@singularity/plugin-apps-file-explorer`
- `plugins/apps/file-explorer/web/index.ts` — empty plugin: `contributions: []`, no exports beyond the default

### Step 3: File Explorer shell sub-plugin

The shell sub-plugin owns everything: slot definitions, layout component, and `Apps.App` contribution. This mirrors how `plugins/shell/` works for the agent manager — the shell defines and renders the slots.

**New files:**
- `plugins/apps/file-explorer/plugins/shell/package.json` — `@singularity/plugin-apps-file-explorer-shell`
- `plugins/apps/file-explorer/plugins/shell/web/index.ts` — exports `FileExplorer` slots, contributes `Apps.App` at `/files`
- `plugins/apps/file-explorer/plugins/shell/web/slots.ts` — `FileExplorer.Sidebar` and `FileExplorer.Toolbar`
- `plugins/apps/file-explorer/plugins/shell/web/components/file-explorer-layout.tsx` — ~10 line wrapper calling `AppShellLayout`

Slot definitions mirror `Shell.Sidebar`/`Shell.Toolbar` exactly (same item shape), but with `file-explorer.*` slot IDs. Other file-explorer sub-plugins will import from `@plugins/apps/file-explorer/plugins/shell/web` to contribute to these slots.

### Step 4: Refactor `ShellLayout` to use the primitive

**Modified file:**
- `plugins/shell/web/components/shell-layout.tsx` — shrinks from 200+ lines to ~30

Becomes a thin wrapper:
```tsx
export function ShellLayout() {
  return (
    <AppShellLayout
      sidebarSlot={Shell.Sidebar}
      toolbarSlot={Shell.Toolbar}
      defaultCollapsed={new Set(["Debug"])}
      sidebarGroupIcons={{ System: MdTune }}
      header={<SingularityBranding />}
    />
  );
}
```

`Shell.Sidebar`, `Shell.Toolbar`, and all existing contributions are completely untouched.

## Key files

| File | Action |
|---|---|
| `plugins/primitives/plugins/app-shell/package.json` | Create |
| `plugins/primitives/plugins/app-shell/web/index.ts` | Create |
| `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` | Create (extracted from shell-layout.tsx) |
| `plugins/apps/file-explorer/package.json` | Create |
| `plugins/apps/file-explorer/web/index.ts` | Create (empty namespace) |
| `plugins/apps/file-explorer/plugins/shell/package.json` | Create |
| `plugins/apps/file-explorer/plugins/shell/web/index.ts` | Create |
| `plugins/apps/file-explorer/plugins/shell/web/slots.ts` | Create |
| `plugins/apps/file-explorer/plugins/shell/web/components/file-explorer-layout.tsx` | Create |
| `plugins/shell/web/components/shell-layout.tsx` | Refactor to thin wrapper |

## Verification

1. `./equin build` — must succeed (frontend + server + registry generation)
2. Open `http://<worktree>.localhost:9000` — agent manager looks identical (sidebar, toolbar, all contributions present)
3. Click folder icon in app rail → navigates to `/files`, shows empty sidebar+toolbar chrome with miller columns
4. `./equin check` — passes all checks (plugin boundaries, eslint, etc.)
