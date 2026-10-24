# Debug Plugin

## Context

Logs currently lives in the "System" sidebar group as a top-level button. A new DB Backup capability needs to be added. Rather than cluttering the sidebar, both tools should live under a dedicated "Debug" section — a collapsible group in the sidebar with child items that open their respective panes.

## Architecture

`Debug` follows the **parent-plugin-with-slots** pattern (same as `stats`):

- `Debug` contributes to `Shell.Sidebar` with a **`component`** (inline sidebar section — same pattern as `conversations-view`)
- `Debug` defines a `Debug.Item` slot that child plugins contribute to
- `DebugSidebar` component renders all `Debug.Item` contributions as clickable sidebar entries
- `Logs` removes its `Shell.Sidebar` contribution and adds a `Debug.Item` contribution instead
- `db-backup` is a new child plugin of `Debug` that contributes a `Debug.Item` and adds a server endpoint

### Sidebar rendering

`Shell.Sidebar` contributions split into two kinds (see `shell-layout.tsx`):
- **`onClick` (no `component`)** → rendered as buttons in named groups
- **`component` (no `onClick`)** → rendered as inline sidebar pane sections (always visible)

`Debug` uses the `component` pattern — `DebugSidebar` renders inline under a "Debug" group label in the sidebar, listing each child item as a `SidebarMenuButton`.

## File Plan

### New files

```
plugins/debug/
├── web/
│   ├── index.ts                          # PluginDefinition — Shell.Sidebar contribution
│   ├── slots.ts                          # Defines Debug.Item slot
│   └── components/
│       └── debug-sidebar.tsx             # Renders Debug.Item contributions
└── plugins/
    └── db-backup/
        ├── web/
        │   ├── index.ts                  # PluginDefinition — Debug.Item contribution
        │   ├── views.ts                  # dbBackupPane() factory
        │   └── components/
        │       └── db-backup-panel.tsx   # Run button + result display
        └── server/
            └── index.ts                  # POST /api/debug/backup-db
```

### Modified files

- `plugins/logs/web/index.ts` — replace `Shell.Sidebar` contribution with `Debug.Item`
- `web/src/plugins.ts` — add `debugPlugin` (before `logsPlugin`) and `dbBackupPlugin`
- `server/src/plugins.ts` — add `dbBackupPlugin`

## Implementation Details

### `plugins/debug/web/slots.ts`

```typescript
import { defineSlot } from "@core";
import type { ComponentType } from "react";

export const Debug = {
  Item: defineSlot<{
    id: string;
    title: string;
    icon: ComponentType<{ className?: string }>;
    onClick: () => void;
  }>("debug.item"),
};
```

### `plugins/debug/web/index.ts`

```typescript
import type { PluginDefinition } from "@core";
import { Shell } from "@plugins/shell/web/slots";
import { MdBugReport } from "react-icons/md";
import { DebugSidebar } from "./components/debug-sidebar";

const debugPlugin: PluginDefinition = {
  id: "debug",
  name: "Debug",
  description: "Debug tools sidebar group.",
  contributions: [
    Shell.Sidebar({
      title: "Debug",
      icon: MdBugReport,
      component: DebugSidebar,
    }),
  ],
};
export default debugPlugin;
```

### `plugins/debug/web/components/debug-sidebar.tsx`

```typescript
import { PluginErrorBoundary } from "@core";
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "@/components/ui/sidebar";
import { Debug } from "../slots";

export function DebugSidebar() {
  const items = Debug.Item.useContributions();
  return (
    <SidebarMenu>
      {items.map((item) => (
        <PluginErrorBoundary key={item.id} slot="debug.item" label={item.title}>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={item.onClick}>
              <item.icon className="size-4" />
              <span>{item.title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </PluginErrorBoundary>
      ))}
    </SidebarMenu>
  );
}
```

### Modified `plugins/logs/web/index.ts`

Remove the `Shell.Sidebar` contribution. Add:
```typescript
import { Debug } from "@plugins/debug/web/slots";
// ...
Debug.Item({
  id: "logs",
  title: "Logs",
  icon: MdTerminal,
  onClick: () => ShellCommands.OpenPane(logPane()),
}),
// Keep Shell.Route contributions unchanged
```

### `plugins/debug/plugins/db-backup/web/index.ts`

```typescript
import { Debug } from "@plugins/debug/web/slots";
import { Shell as ShellCommands } from "@plugins/shell/web/commands";
import { MdBackup } from "react-icons/md";
import { dbBackupPane } from "./views";

const dbBackupPlugin: PluginDefinition = {
  id: "debug-db-backup",
  contributions: [
    Debug.Item({
      id: "db-backup",
      title: "DB Backup",
      icon: MdBackup,
      onClick: () => ShellCommands.OpenPane(dbBackupPane()),
    }),
  ],
};
```

### `plugins/debug/plugins/db-backup/web/components/db-backup-panel.tsx`

Simple panel:
- "Run Backup" button — calls `POST /api/debug/backup-db`
- Shows loading state while running
- On success: displays output dir and list of dumped databases
- On error: displays error message (via Shell.Toast or inline)

### `plugins/debug/plugins/db-backup/server/index.ts`

```typescript
const plugin: ServerPluginDefinition = {
  id: "debug-db-backup",
  httpRoutes: { "POST /api/debug/backup-db": handleBackup },
};
```

### `plugins/debug/plugins/db-backup/server/internal/handle-backup.ts`

Logic:
1. Query `pg_database` via `adminSql` for databases excluding `template0`, `template1`, `postgres`, and `claude-%` pattern
2. Create `~/.backups/singularity/<timestamp>/` with `mkdirSync`
3. For each database: `Bun.spawn(["pg_dump", "-U", user, "-Fc", dbname])` with stdout piped to `<outDir>/<dbname>.dump`
4. Await each process, collect results
5. Return `{ ok: true, outDir, databases: [{ name, sizeBytes }] }`

Uses `adminSql` from `server/src/db/client.ts` and env vars `PGUSER`/`USER` for the pg user (same as `client.ts`).

### Registration order in `web/src/plugins.ts`

```typescript
import debugPlugin from "@plugins/debug/web";
import dbBackupPlugin from "@plugins/debug/plugins/db-backup/web";

// in plugins array — debug before logs (logs contributes to debug.item)
debugPlugin,
logsPlugin,     // existing, now contributes to Debug.Item
dbBackupPlugin,
```

## Verification

1. `./equin build` — should compile with no errors
2. Open the app; sidebar should show a "Debug" section (inline, always visible) with "Logs" and "DB Backup" items
3. "Logs" click → opens log viewer (same as before)
4. "DB Backup" click → opens backup panel; "Run Backup" triggers the endpoint; `~/.backups/singularity/` gets a timestamped folder with `singularity.dump`
5. "System" group should no longer contain "Logs"
