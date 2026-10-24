# Launch Prompts

## Context

Quick prompts send canned text to the *current* conversation. This feature adds a complementary "launch prompts" concept: pre-configured prompts that each carry a fixed model (Sonnet or Opus) and, when clicked, start a **new background conversation** in the same worktree (same `attemptId`) without navigating away. Prompts are managed in the Settings pane.

The two features are intentionally separate data sets — different schema (model field), different send path, different UI surface (toolbar dropdown vs. chip row).

---

## Plugin Location

```
plugins/conversations/plugins/conversation-view/plugins/launch-prompts/
├── package.json
├── shared/
│   └── resources.ts
├── server/
│   ├── index.ts
│   └── internal/
│       ├── tables.ts
│       ├── tables-attachments.ts
│       ├── resources.ts
│       ├── rank.ts
│       ├── handle-list.ts
│       ├── handle-create.ts
│       ├── handle-update.ts
│       └── handle-delete.ts
└── web/
    ├── index.ts
    └── components/
        ├── launch-prompts-button.tsx   # toolbar dropdown
        └── launch-prompts-settings.tsx # settings section
```

Follow the `quick-prompts` plugin as the authoritative pattern for every file.

---

## Data Model

**`shared/resources.ts`**
```ts
export const LaunchPromptSchema = z.object({
  id:    z.string(),
  title: z.string(),
  prompt: z.string(),
  model:  z.enum(["sonnet", "opus"]),
  rank:   z.string(),
});
export type LaunchPrompt = z.infer<typeof LaunchPromptSchema>;
export const launchPromptsResource = resourceDescriptor<LaunchPrompt[]>(
  "launch-prompts", z.array(LaunchPromptSchema),
);
```

---

## DB Schema (`server/internal/tables.ts`)

```ts
export const launchPromptsTable = pgTable("launch_prompts", {
  id:        text("id").primaryKey(),
  title:     text("title").notNull(),
  prompt:    text("prompt").notNull(),
  model:     text("model").notNull(),          // "sonnet" | "opus"
  rank:      rankText("rank").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

`model` is `text` (not a PG enum) — Zod enforces the valid values at the API boundary.

**`server/internal/tables-attachments.ts`** — `Attachments.defineLink(launchPromptsTable)` for orphan-sweep protection on embedded images.

---

## Server

Routes (in `server/index.ts`):
- `GET    /api/launch-prompts`
- `POST   /api/launch-prompts`       — body: `{ title, prompt, model? }` (default `"sonnet"`)
- `PATCH  /api/launch-prompts/:id`   — body: `{ title?, prompt?, model? }`
- `DELETE /api/launch-prompts/:id`

Each mutating handler calls `launchPromptsServerResource.notify()` after the DB write and `syncOwnerAttachments` when `prompt` changes — same pattern as `quick-prompts` `handle-create.ts` / `handle-update.ts`.

---

## Web UI — Toolbar Button (`web/components/launch-prompts-button.tsx`)

Contributed via `conversationPane.Actions`. Returns `null` when the prompt list is empty (button is hidden until at least one prompt is configured).

```
conversationPane.useData()  →  conversation.attemptId
useResource(launchPromptsResource)  →  prompts[]

<DropdownMenu>
  <DropdownMenuTrigger> [ListVideo icon] Launch </DropdownMenuTrigger>
  <DropdownMenuContent>
    {prompts.map(item =>
      <DropdownMenuItem onSelect={() => launch(item)}>
        <span>{item.title}</span>
        <span className="...badge...">{Sonnet | Opus}</span>
      </DropdownMenuItem>
    )}
  </DropdownMenuContent>
</DropdownMenu>
```

`launch(item)`:
1. `POST /api/conversations` with `{ model: item.model, prompt: item.prompt, attemptId: conversation.attemptId }`
2. Does **not** navigate / open the new conversation (background launch)
3. Success: `Shell.Toast({ description: "Launched: {title}", variant: "success" })`
4. Failure: error toast

---

## Web UI — Settings (`web/components/launch-prompts-settings.tsx`)

Contributed via `Config.Section`. Same structure as `quick-prompts-settings.tsx` with one addition: a **model toggle** per prompt row.

Each `PromptRow`:
- `<Input>` for title (blur-to-save via PATCH)
- `<PromptEditor>` for prompt body (blur-to-save, same blur-containment logic as quick-prompts)
- Two-button model toggle — `Sonnet` / `Opus` — active uses `variant="secondary"`, inactive uses `variant="ghost"`; clicking either calls `PATCH /api/launch-prompts/:id { model }` immediately
- `×` delete button (optimistic: adds id to `deletingRef`, fires DELETE in background)

"Add prompt" button at the bottom: `POST /api/launch-prompts { title: "New prompt", prompt: "", model: "sonnet" }`.

---

## Web `index.ts` Contributions

```ts
contributions: [
  conversationPane.Actions({ component: LaunchPromptsButton }),
  Config.Section({
    id: "launch-prompts",
    title: "Launch Prompts",
    description: "Prompts that start a new background conversation in the same worktree.",
    component: LaunchPromptsSettings,
  }),
],
```

Import: `import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";`

---

## Files to Modify

| File | Change |
|---|---|
| `web/src/plugins.ts` | Add import near line 42 (after `conversationQuickPromptsPlugin`); add to array near line 154 |
| `server/src/plugins.ts` | Add import near line 22 (after `quickPromptsPlugin`); add to array near line 74 |

Child plugins are registered flat in the root plugin lists — no changes to `conversation-view/web/index.ts` or `conversation-view/server/index.ts`.

---

## Reused Primitives

| Primitive | Used for |
|---|---|
| `quick-prompts` pattern | DB schema, CRUD handlers, rank, resource push, settings structure |
| `conversationPane.useData()` | Get `conversation.attemptId` in the toolbar button |
| `Config.Section` | Mount settings component in the Settings pane |
| `useResource` | Live-subscribed prompt list |
| `PromptEditor` (paste-images) | Rich body editor in settings |
| `Shell.Toast` / `ShellCommands` | Success/error feedback |
| `DropdownMenu`, `Button`, `Input` | shadcn/ui components |

---

## Verification

1. `./equin build` — confirm migration runs and `launch_prompts` table is created
2. `curl POST /api/launch-prompts` → create a prompt; `GET` returns it; PATCH changes model; DELETE removes it
3. Open Settings → "Launch Prompts" — add/edit/delete prompts live without page refresh
4. Open any conversation — with no prompts the "Launch" button is absent; add a prompt and it appears
5. Click the button — dropdown shows title + Sonnet/Opus badge per item
6. Click a menu item — no navigation; success toast; new conversation appears in the sidebar in the same worktree
7. Toggle model in settings — badge in the dropdown reflects the new value immediately
