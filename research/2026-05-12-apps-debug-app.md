# Debug App

## Context

The Debug section currently lives as a sidebar group inside the agent-manager app (`Shell.Sidebar` contribution from `plugins/debug/web/index.ts`). Moving it to a standalone app in the app rail — following the exact `file-explorer` template — gives it a dedicated top-level entry point, removes debug clutter from the agent-manager sidebar, and makes the pattern consistent with other apps (file-explorer, deploy).

---

## Approach

Fork the `file-explorer` app pattern: create `plugins/apps/plugins/debug/plugins/shell/` that defines `DebugApp.Sidebar`/`DebugApp.Toolbar` slots and contributes an `Apps.App` entry. Then migrate all 10 `Debug.Item` contributors to `DebugApp.Sidebar`, and remove the now-obsolete `Shell.Sidebar` contribution and `Debug.Item` slot.

---

## Files to Create

### `plugins/apps/plugins/debug/package.json`
```json
{
  "name": "@singularity/plugin-apps-debug",
  "description": "Debug app.",
  "private": true,
  "version": "0.0.1"
}
```

### `plugins/apps/plugins/debug/plugins/shell/package.json`
```json
{
  "name": "@singularity/plugin-apps-debug-shell",
  "private": true,
  "version": "0.0.1"
}
```

### `plugins/apps/plugins/debug/plugins/shell/web/slots.ts`

Mirror `file-explorer/plugins/shell/web/slots.ts` exactly:

```ts
import { defineSlot } from "@core";
import type { ComponentType } from "react";
import { Reorder } from "@plugins/reorder/web";

export const DebugApp = {
  Sidebar: Reorder.area(
    defineSlot<{
      title: string;
      icon: ComponentType<{ className?: string }>;
      onClick?: () => void;
      component?: ComponentType;
      group?: string;
      labelExtra?: ComponentType;
      scroll?: boolean;
    }>("debug-app.sidebar", { docLabel: (p) => p.title }),
    { getGroup: (item) => item.group ?? null, getLabel: (item) => item.title },
  ),

  Toolbar: Reorder.area(
    defineSlot<{
      label?: string;
      icon?: ComponentType<{ className?: string }>;
      onClick?: () => void;
      component?: ComponentType;
      group?: string;
    }>("debug-app.toolbar", { docLabel: (p) => p.label }),
    {
      getGroup: (item) => item.group ?? null,
      getLabel: (item) => item.label ?? item.id,
    },
  ),
};
```

### `plugins/apps/plugins/debug/plugins/shell/web/components/debug-layout.tsx`

```tsx
import { AppShellLayout } from "@plugins/primitives/plugins/app-shell/web";
import { DebugApp } from "../slots";

export function DebugLayout() {
  return (
    <AppShellLayout
      sidebarSlot={DebugApp.Sidebar}
      toolbarSlot={DebugApp.Toolbar}
    />
  );
}
```

### `plugins/apps/plugins/debug/plugins/shell/web/index.ts`

```ts
import type { PluginDefinition } from "@core";
import { Apps } from "@plugins/apps/web";
import { MdBugReport } from "react-icons/md";
import { DebugLayout } from "./components/debug-layout";

export { DebugApp } from "./slots";

export default {
  id: "debug-app-shell",
  name: "Debug App: Shell",
  description:
    "App shell for the debug tools. Registers the /debug app entry and defines DebugApp.Sidebar/Toolbar slots.",
  contributions: [
    Apps.App({
      id: "debug",
      icon: MdBugReport,
      tooltip: "Debug",
      component: DebugLayout,
      path: "/debug",
    }),
  ],
} satisfies PluginDefinition;
```

---

## Files to Modify

### `plugins/debug/web/index.ts`

Remove the `Shell.Sidebar` contribution, `Shell` import, `MdBugReport` import, `DebugSidebar` import. Also remove `Debug` re-export (slot is being deleted). Reduce to minimal umbrella:

```ts
import type { PluginDefinition } from "@core";

export default {
  id: "debug",
  name: "Debug",
  description: "Debug tools umbrella plugin.",
  contributions: [],
} satisfies PluginDefinition;
```

### `plugins/debug/web/slots.ts` — **delete**

`Debug.Item` is replaced by `DebugApp.Sidebar`. Once all contributors are migrated, this file is dead.

### `plugins/debug/web/components/debug-sidebar.tsx` — **delete**

Only used by the now-removed `Shell.Sidebar` contribution.

### All 10 `Debug.Item` contributors

Change import and contribution in each file:

| File | Old import | New import |
|---|---|---|
| `plugins/debug/plugins/broadcasts/web/index.ts` | `@plugins/debug/web` | `@plugins/apps/plugins/debug/plugins/shell/web` |
| `plugins/debug/plugins/claude-cli-calls/web/index.ts` | same | same |
| `plugins/debug/plugins/db-backup/web/index.ts` | same | same |
| `plugins/debug/plugins/logs/web/index.ts` | same | same |
| `plugins/debug/plugins/memory/web/index.ts` | same | same |
| `plugins/debug/plugins/profiling/web/index.ts` | same | same |
| `plugins/debug/plugins/queue/web/index.ts` | same | same |
| `plugins/debug/plugins/worktree-cleanup/web/index.ts` | same | same |
| `plugins/conversations-recover/web/index.ts` | same | same |
| `plugins/events-test/web/index.ts` | same | same |

In each file, rename `Debug.Item({ id, title, icon, onClick })` → `DebugApp.Sidebar({ id, title, icon, onClick })`.

The `DebugApp.Sidebar` slot shape is a superset of `Debug.Item` — all existing fields (`title`, `icon`, `onClick`) map directly. No other changes to contribution props.

> Note: `profiling/plugins/boot/web/index.ts` and `profiling/plugins/build/web/index.ts` contribute to `Profiling.Section`, not `Debug.Item` — leave them untouched.

---

## Plugin Registration

`web/src/plugins.ts` re-exports from `web/src/plugins.generated.ts`, which is **auto-regenerated by `./equin build`** from the filesystem. No manual registration needed — the build discovers `plugins/apps/plugins/debug/plugins/shell/web/index.ts` automatically.

Root `package.json` workspaces use a glob (`"plugins/**"`) that auto-discovers both new packages. No workspace change needed.

---

## Implementation Order

1. Create `plugins/apps/plugins/debug/package.json`
2. Create `plugins/apps/plugins/debug/plugins/shell/package.json`
3. Create `plugins/apps/plugins/debug/plugins/shell/web/slots.ts`
4. Create `plugins/apps/plugins/debug/plugins/shell/web/components/debug-layout.tsx`
5. Create `plugins/apps/plugins/debug/plugins/shell/web/index.ts`
6. Update all 10 sub-plugin `web/index.ts` (swap `Debug` import + `Debug.Item` → `DebugApp.Sidebar`)
7. Update `plugins/debug/web/index.ts` (strip to no-op umbrella)
8. Delete `plugins/debug/web/slots.ts`
9. Delete `plugins/debug/web/components/debug-sidebar.tsx`
10. Run `./equin build`

---

## Verification

1. `./equin build` completes without errors
2. Open `http://<worktree>.localhost:9000` — the app rail shows a bug-report icon for `/debug`
3. Click the icon — the Debug app opens with a sidebar listing all items (Broadcasts, Logs, Memory, etc.)
4. Clicking a sidebar item opens the corresponding pane
5. The Debug sidebar group no longer appears in the agent-manager app
