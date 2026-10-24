# Allow-File Monitor Plugin

## Context

Agents can create two worktree-local sentinel files to bypass security guards:

- `.allow-main` — disables `mainEditsGuard` and `mainWritesGuard` (allows editing/writing outside the worktree)
- `.allow-migrations` — disables `migrationsGuard` (allows deleting migration files)

Both are gitignored and checked only by `existsSync` — their presence alone is the signal. They are only valid when the human explicitly approves them in the current conversation.

When an agent creates one of these files, anyone watching the conversation has no obvious visual signal that a security bypass is active. This plugin surfaces that state prominently in the conversation toolbar header so it cannot be missed.

---

## Implementation Plan

### Plugin location

```
plugins/conversations/plugins/conversation-view/plugins/allow-monitor/
├── CLAUDE.md
├── package.json
├── web/
│   ├── index.ts
│   └── components/
│       └── allow-monitor-chip.tsx
└── server/
    ├── index.ts
    └── internal/
        └── allow-files-route.ts
```

---

### Server

**File**: `server/internal/allow-files-route.ts`

- `GET /api/conversations/:id/allow-files`
- Fetches the conversation via `getConversation(id)` from `@plugins/tasks-core/server`
- Resolves `conversation.worktreePath`; if null, returns `{ allowFiles: [] }`
- Checks existence of each sentinel file using `Bun.file(join(worktreePath, name)).exists()`
- Returns `{ allowFiles: string[] }` — the subset of sentinel files that currently exist

Known allow files to check: `.allow-main`, `.allow-migrations`

**File**: `server/index.ts`

Standard server plugin barrel. Registers the Hono route.

```ts
export default {
  id: "allow-monitor-server",
  routes: app => {
    app.get("/api/conversations/:id/allow-files", ...)
  },
} satisfies ServerPluginDefinition;
```

---

### Web component

**File**: `web/components/allow-monitor-chip.tsx`

```tsx
export function AllowMonitorChip() {
  const { conversation } = conversationPane.useData();          // no prop drilling
  const { data } = useQuery({
    queryKey: ["allow-files", conversation.id],
    queryFn: () => fetch(`/api/conversations/${conversation.id}/allow-files`).then(r => r.json()),
    refetchInterval: 3_000,                                      // poll every 3 s
  });
  const allowFiles: string[] = data?.allowFiles ?? [];
  const flagged = allowFiles.length > 0;

  if (!flagged) return null;  // hide when clean; only appear when flagged

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 animate-pulse bg-red-500/90 hover:bg-red-500 text-white font-semibold"
          >
            <MdWarning className="size-4" />
            BYPASS ACTIVE
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="font-semibold text-red-500">Security guard bypassed:</p>
          <ul className="mt-1 space-y-0.5">
            {allowFiles.map(f => (
              <li key={f} className="font-mono text-xs">{f}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
```

**Visual design when flagged**: pulsing red pill with ⚠ icon + "BYPASS ACTIVE" label. Tooltip shows the exact files. Component returns `null` when clean — no cluttering the toolbar in normal operation.

**File**: `web/index.ts`

```ts
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";

export default {
  id: "allow-monitor",
  name: "Allow-File Monitor",
  contributions: [
    conversationPane.Actions({ component: AllowMonitorChip, position: "right" }),
  ],
} satisfies PluginDefinition;
```

Uses `conversationPane.Actions` (header, right side) — the same slot as `status`, `commits-graph`, `push-counter`. This is a status indicator, not an action button, so the header is the right home.

---

### Registration

**`web/src/plugins.ts`** — add:
```ts
import allowMonitorPlugin from "@plugins/conversations/plugins/conversation-view/plugins/allow-monitor/web";
```

**`server/src/plugins.ts`** — add:
```ts
import allowMonitorServerPlugin from "@plugins/conversations/plugins/conversation-view/plugins/allow-monitor/server";
```

---

### Key files to read/reference

| Purpose | Path |
|---|---|
| `conversationPane` definition & export | `plugins/conversations/plugins/conversation-view/web/panes.tsx` |
| `conversationPane.Actions` usage example | `plugins/conversations/plugins/conversation-view/plugins/status/web/index.ts` |
| `conversationPane.useData()` usage example | `plugins/conversations/plugins/conversation-view/plugins/commits-graph/web/components/commits-chip.tsx` |
| `getConversation` / `worktreePath` | `plugins/tasks-core/server` |
| `Bun.file().exists()` pattern | `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/get-edited-files.ts` |
| Animated/colored button example | `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx` |
| Guard definitions (allow file names) | `cli/src/guards/guards/main-edits.ts`, `main-writes.ts`, `migrations.ts` |
| Global web plugin registry | `web/src/plugins.ts` |
| Global server plugin registry | `server/src/plugins.ts` |

---

### Verification

1. `./equin build` — confirm build succeeds with new plugin
2. Open any active conversation at `http://<worktree>.localhost:9000/c/<id>`
3. Toolbar header should show **no badge** in normal state
4. In the worktree terminal: `touch .allow-main`
5. Within 3 seconds the "BYPASS ACTIVE" red pulsing chip appears in the header
6. Hover the chip — tooltip shows `.allow-main`
7. `rm .allow-main` — chip disappears within 3 seconds
8. Repeat with `.allow-migrations`
