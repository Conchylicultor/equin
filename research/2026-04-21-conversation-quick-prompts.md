# Quick Prompts Chips in the Conversation Toolbar

## Context

Users want to send pre-defined messages to a conversation in one click. The feature lets users register named prompts (title → text) in Settings; chips for each prompt appear in the conversation's floating bar (the same area as Push & Exit / Drop & Exit). Clicking a chip POSTs the prompt text as a new turn. This accelerates repetitive workflows like "Implement", "Design", "Review".

---

## File Structure

```
plugins/conversations/plugins/conversation-view/plugins/quick-prompts/
├── package.json
├── shared/
│   └── resources.ts          # QuickPrompt type + resource descriptor
├── server/
│   ├── index.ts              # ServerPluginDefinition
│   └── internal/
│       ├── tables.ts         # quick_prompts DB table
│       ├── resources.ts      # defineResource (server-side, push mode)
│       ├── rank.ts           # generateKeyBetween helper
│       ├── handle-list.ts
│       ├── handle-create.ts
│       ├── handle-update.ts
│       └── handle-delete.ts
└── web/
    ├── index.ts              # PluginDefinition
    └── components/
        ├── quick-prompt-chips.tsx      # Floating-bar chips
        └── quick-prompts-settings.tsx  # Config.Section editor
```

---

## Shared Layer (`shared/resources.ts`)

```typescript
export interface QuickPrompt {
  id: string;
  title: string;
  prompt: string;
  rank: string;   // fractional-indexing text key
}

function descriptor<T>(key: string) {
  return { key } as {
    readonly key: string;
    readonly __types?: { value: T; params: Record<string, never> };
  };
}

export const quickPromptsResource = descriptor<QuickPrompt[]>("quick-prompts");
```

Copy the `descriptor` helper pattern from `push-and-exit/shared/resources.ts` — do **not** import from `@core`.

---

## Server Layer

### `server/internal/tables.ts`

```typescript
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { rankText } from "../../../../../../../../server/src/db/types";

export const quickPromptsTable = pgTable("quick_prompts", {
  id:        text("id").primaryKey(),
  title:     text("title").notNull(),
  prompt:    text("prompt").notNull(),
  rank:      rankText("rank").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Import depth from `internal/` up to root: 8 levels (`../../../../../../../../`).
Use `rankText` (not `real`) — all ordered collections in the codebase use fractional-indexing text keys.

### `server/internal/resources.ts`

```typescript
import { asc } from "drizzle-orm";
import { db } from "../../../../../../../../server/src/db/client";
import { defineResource } from "../../../../../../../../server/src/resources";
import { quickPromptsTable } from "./tables";
import type { QuickPrompt } from "../../shared/resources";

export const quickPromptsServerResource = defineResource<QuickPrompt[]>({
  key: "quick-prompts",
  mode: "push",
  async loader() {
    return db.select().from(quickPromptsTable)
      .orderBy(asc(quickPromptsTable.rank), asc(quickPromptsTable.createdAt));
  },
});
```

### `server/internal/rank.ts`

```typescript
import { desc } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { db } from "../../../../../../../../server/src/db/client";
import { quickPromptsTable } from "./tables";

export async function nextRank(): Promise<string> {
  const [last] = await db
    .select({ rank: quickPromptsTable.rank })
    .from(quickPromptsTable)
    .orderBy(desc(quickPromptsTable.rank))
    .limit(1);
  return generateKeyBetween(last?.rank ?? null, null);
}
```

### Handler pattern (all four files follow the same shape)

Each handler calls `quickPromptsServerResource.notify()` after any mutation. IDs are generated with `crypto.randomUUID()`. Follow the exact same pattern as `plugins/agents/server/internal/handle-*.ts`.

### `server/index.ts`

```typescript
import type { ServerPluginDefinition } from "../../../../../../../../server/src/types";
import { quickPromptsServerResource } from "./internal/resources";
import { handleList }   from "./internal/handle-list";
import { handleCreate } from "./internal/handle-create";
import { handleUpdate } from "./internal/handle-update";
import { handleDelete } from "./internal/handle-delete";

export default {
  id: "quick-prompts",
  httpRoutes: {
    "GET /api/quick-prompts":          handleList,
    "POST /api/quick-prompts":         handleCreate,
    "PATCH /api/quick-prompts/:id":    handleUpdate,
    "DELETE /api/quick-prompts/:id":   handleDelete,
  },
  resources: [quickPromptsServerResource],
} satisfies ServerPluginDefinition;
```

---

## Web Layer

### `web/components/quick-prompt-chips.tsx`

Contributes to the floating bar. Renders one `Button variant="outline" size="sm"` pill per prompt. Disables all chips when `status === "gone" | "starting"` or while a send is in-flight.

```typescript
export function QuickPromptChips({ conversation }: { conversation: ConversationState }) {
  const live = useConversation(conversation.id) ?? conversation;
  const { data: prompts } = useResource(quickPromptsResource);
  const [sendingId, setSendingId] = useState<string | null>(null);

  if (!prompts || prompts.length === 0) return null;

  const disabled = live.status === "gone" || live.status === "starting";

  async function sendPrompt(id: string, text: string) {
    if (disabled || sendingId !== null) return;
    setSendingId(id);
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversation.id)}/turn`,
        { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      ShellCommands.Toast({ description: `Failed: ${String(err)}`, variant: "error" });
    } finally {
      setSendingId(null);
    }
  }

  return (
    <>
      {prompts.map((p) => (
        <Button key={p.id} variant="outline" size="sm"
          disabled={disabled || sendingId !== null}
          className="h-7 rounded-full px-3 text-xs"
          onClick={() => void sendPrompt(p.id, p.prompt)}>
          {sendingId === p.id ? "Sending…" : p.title}
        </Button>
      ))}
    </>
  );
}
```

Import `ShellCommands` from `@plugins/shell/web` (same pattern as drop-and-exit).
Import `useConversation` from `@plugins/conversations/web`.

### `web/components/quick-prompts-settings.tsx`

Custom Settings editor using `Config.Section`. Uses `defaultValue` + `onBlur` (save on blur, not on keystroke). Optimistic delete via a `useRef` set.

**No `<Textarea>` shadcn component exists** in this project — use a plain `<textarea>` styled with Tailwind: `className="w-full resize-y rounded-md border border-input bg-background px-3 py-1.5 text-xs min-h-16"`.

```typescript
export function QuickPromptsSettings() {
  const { data: prompts } = useResource(quickPromptsResource);
  const deletingRef = useRef(new Set<string>());
  // ...
  // Render: visible rows (filter deleting), each with an Input for title,
  // plain textarea for prompt, and an × Button.
  // "Add prompt" button at the bottom calls POST /api/quick-prompts.
}
```

### `web/index.ts`

```typescript
export default {
  id: "conversation-quick-prompts",
  contributions: [
    Conversation.Toolbar({ component: QuickPromptChips, group: "floating" }),
    Config.Section({
      id: "quick-prompts",
      title: "Quick Prompts",
      description: "Named prompts that appear as chips in the conversation toolbar.",
      component: QuickPromptsSettings,
    }),
  ],
} satisfies PluginDefinition;
```

---

## Registration (3 files to edit)

### 1. `server/src/db/schema.ts`

Add after the commits tables line:
```typescript
export * from "@plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server/internal/tables";
```

### 2. `server/src/plugins.ts`

```typescript
import quickPromptsPlugin from "@plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server";
// add to plugins array after dropAndExitPlugin
```

### 3. `web/src/plugins.ts`

```typescript
import conversationQuickPromptsPlugin from "@plugins/conversations/plugins/conversation-view/plugins/quick-prompts/web";
// add to plugins array after conversationDropAndExitPlugin
```

---

## Build & Migration

After all files are in place, run:
```bash
./equin build --migration-name add-quick-prompts-table
```

This generates the SQL migration (hash-named), restarts the server, and applies it.

---

## Verification

1. **Migration**: Check server startup logs for `[migrate] applied ...add-quick-prompts-table`.
2. **CRUD**: `curl -X POST http://localhost:9001/api/quick-prompts -H 'content-type: application/json' -d '{"title":"Test","prompt":"Hello"}'` returns `201`.
3. **Settings**: Navigate to Settings → find "Conversation: Quick Prompts" section → add a prompt → it appears immediately (resource push).
4. **Chips**: Open a conversation → floating bar shows a chip per prompt → click fires POST to `/api/conversations/:id/turn` (verify in Network tab).
5. **Disabled state**: Conversation with `status=gone` → chips are visually disabled and unclickable.
6. **Empty state**: No prompts configured → `QuickPromptChips` returns null, no chips render.
