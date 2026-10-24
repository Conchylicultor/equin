# Deploy App Shell — Cross-App Miller Columns

## Context

Deploy is currently a sidebar entry inside the shell (agent-manager) app. It renders its panes (server list, server detail, add-server) as Miller columns in the shell's main area alongside Tasks, Conversations, etc.

The goal is to make Deploy its own top-level app in the `Apps.App` rail — a dedicated full-screen surface with its own layout. This requires making the Miller columns system cross-app compatible, establishing the pattern for future apps (Docs, Metrics, etc.).

---

## Key Architectural Insight

**The pane primitive needs no changes.** The module-level singleton state works because:

1. `AppsLayout` renders exactly ONE active app at a time — two `MillerColumns` never coexist in the DOM.
2. The global `registry` is fine — `parseUrl("/deploy/...")` naturally resolves only to deploy's pane tree (rooted by `segment: "deploy"`, `after: [null]`).
3. Module-level column state (collapse, widths, maximize) is keyed by `paneId`, so deploy and shell panes never collide.

The only changes needed are in the app-switching layer, a toaster extraction, and a new deploy shell sub-plugin.

---

## Implementation

### 1. Replace `isActive` with declarative `path` in `Apps.App`

**File: `plugins/apps/web/slots.ts`**

Apps declare a path prefix instead of writing matching logic:

```ts
defineSlot<{
  icon: ComponentType<{ className?: string }>;
  tooltip: string;
  component: ComponentType;
  path: string;       // e.g. "/deploy", "/"
  onClick?: () => void;  // optional — defaults to navigating to `path`
}>("apps.app")
```

### 2. Segment-boundary matching in `AppsLayout`

**File: `plugins/apps/web/components/apps-layout.tsx`**

`AppsLayout` owns all routing. Matching is segment-boundary aware — `/deploy` matches `/deploy` and `/deploy/...` but NOT `/deploy-abc` or `/deployment/123`:

```ts
function appMatchesPath(appPath: string, pathname: string): boolean {
  if (appPath === "/") return true;
  return pathname === appPath || pathname.startsWith(appPath + "/");
}
```

Longest-prefix wins. Sort candidates by `path.length` descending, pick first match:

```ts
const sorted = [...appsArea.items].sort((a, b) => b.path.length - a.path.length);
const activeApp = sorted.find((a) => appMatchesPath(a.path, pathname));
if (!activeApp) {
  console.error(`No app matches pathname: ${pathname}`);
}
```

Root app (`path: "/"`) naturally matches everything not claimed by a longer prefix. Shell never needs updating when a new app is added.

Rail `onClick`: if no custom `onClick` is provided, default to navigating to the app's `path`.

### 3. Extract toaster to `plugins/shell/plugins/toaster/`

Currently `<Toaster />`, the `Shell.Toast.useHandler(...)`, and the unhandled-rejection listener all live inside `ShellLayout`. When deploy is active, shell unmounts, and toasts break — but `Core.Root` contributors like `CrashReporter` and `ReconnectWatcher` call `ShellCommands.Toast` unconditionally.

**Fix:** New sub-plugin `plugins/shell/plugins/toaster/` that contributes `Core.Root` — always mounted regardless of which app is active.

The `Shell.Toast` command definition stays in `plugins/shell/web/commands.ts` — no import migration across 20+ consumer files.

**New file: `plugins/shell/plugins/toaster/web/index.ts`**

```ts
import { Core, type PluginDefinition } from "@core";
import { ToasterRoot } from "./components/toaster-root";

export default {
  id: "shell-toaster",
  name: "Shell: Toaster",
  description: "Global toast notifications. Mounts the sonner Toaster and handles Shell.Toast commands.",
  contributions: [
    Core.Root({ component: ToasterRoot }),
  ],
} satisfies PluginDefinition;
```

**New file: `plugins/shell/plugins/toaster/web/components/toaster-root.tsx`**

Renders `<Toaster />` (moved from `shell/web/components/toaster.tsx`), registers `ShellCommands.Toast.useHandler(...)`, and installs the `unhandledrejection` listener (both moved from `shell-layout.tsx`). Renders no visible layout — just the sonner portal.

**File: `plugins/shell/web/components/shell-layout.tsx`**

Remove:
- `<Toaster />` render
- `ShellCommands.Toast.useHandler(...)` call
- The `unhandledrejection` `useEffect`
- Imports for `toast`, `Toaster`, `ShellCommands`

### 4. Update shell's `Apps.App` contribution

**File: `plugins/shell/web/index.ts`**

```ts
Apps.App({
  id: "agent-manager",
  icon: MdDashboard,
  tooltip: "Agent Manager",
  component: ShellLayout,
  path: "/",
})
```

### 5. Create `plugins/deploy/plugins/shell/web/`

**New file: `plugins/deploy/plugins/shell/web/index.ts`**

```ts
import type { PluginDefinition } from "@core";
import { Apps } from "@plugins/apps/web";
import { MdCloud } from "react-icons/md";
import { DeployLayout } from "./components/deploy-layout";

export default {
  id: "deploy-shell",
  name: "Deploy: Shell",
  description: "App shell for the deploy platform.",
  contributions: [
    Apps.App({
      id: "deploy",
      icon: MdCloud,
      tooltip: "Deploy",
      component: DeployLayout,
      path: "/deploy",
    }),
  ],
} satisfies PluginDefinition;
```

**New file: `plugins/deploy/plugins/shell/web/components/deploy-layout.tsx`**

```tsx
import { MillerColumns } from "@plugins/layouts/plugins/miller/web";

export function DeployLayout() {
  return (
    <main className="h-full min-h-0 overflow-hidden bg-muted/30">
      <MillerColumns />
    </main>
  );
}
```

Minimal — just MillerColumns. Deploy panes already provide their own visual structure (ServersList at 320px width acts as the nav column, ServerDetail flex-grows). Future additions (toolbar, breadcrumbs) go here without affecting other apps.

### 6. Remove `Shell.Sidebar` from deploy-servers

**File: `plugins/deploy/plugins/servers/web/index.ts`**

Remove:
- The `Shell.Sidebar(...)` contribution
- The `import { Shell } from "@plugins/shell/web"` import

Keep all `Pane.Register` contributions — they still make the panes routable.

---

## Why This Generalizes

For any future app:
1. Define panes with `after: [null]` and a unique root `segment` (e.g., `"docs"`)
2. Create a sub-plugin that contributes `Apps.App` with `path: "/docs"`
3. Its layout component renders `<MillerColumns />`
4. No changes to pane primitive, Miller columns, apps framework, or shell needed per new app

---

## File Inventory

| Action | File |
|--------|------|
| Modify | `plugins/apps/web/slots.ts` — `isActive` → `path`, `onClick` optional |
| Modify | `plugins/apps/web/components/apps-layout.tsx` — segment-boundary matching, longest-prefix-wins |
| Modify | `plugins/apps/web/components/app-rail.tsx` — use `path` for active state + default onClick |
| Modify | `plugins/shell/web/index.ts` — `path: "/"`, remove `isActive`/`onClick` |
| Modify | `plugins/shell/web/components/shell-layout.tsx` — remove toaster/handler/rejection |
| Create | `plugins/shell/plugins/toaster/web/index.ts` — Core.Root toaster plugin |
| Create | `plugins/shell/plugins/toaster/web/components/toaster-root.tsx` — Toaster + handler |
| Create | `plugins/deploy/plugins/shell/web/index.ts` — deploy app definition |
| Create | `plugins/deploy/plugins/shell/web/components/deploy-layout.tsx` — layout |
| Modify | `plugins/deploy/plugins/servers/web/index.ts` — remove Shell.Sidebar |

---

## Verification

```bash
./equin build
# Visit http://<worktree>.localhost:9000
# → App rail shows two icons: Agent Manager (dashboard) + Deploy (cloud)
# → Click Deploy icon → navigates to /deploy, shows server list in Miller
# → Click Agent Manager → returns to /, shows tasks/conversations
# → Navigate directly to http://<worktree>.localhost:9000/deploy → deploy app activates
# → /deploy-abc does NOT activate deploy app (segment-boundary matching)
# → Toasts still work in both apps (toaster is Core.Root, always mounted)
# → Console shows no "No app matches" errors for normal navigation
```
