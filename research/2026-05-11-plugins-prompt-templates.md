# Prompt Templates Plugin

## Context

Quick-prompts send a message immediately on click. Users want a complementary mechanism: **template chips** that prepend text to the prompt editor so they can review/edit before sending. This is a one-click "insert into editor" action, not a "fire and forget" send.

The new `prompt-templates` plugin is a sibling of `quick-prompts` under `conversation-view/plugins/`, sharing the same DB-backed CRUD pattern but with different click behavior and visual styling.

## Design

### Behavioral differences from quick-prompts

| | quick-prompts | prompt-templates |
|---|---|---|
| Click action | `POST /api/conversations/:id/turn` (sends immediately) | `setDraft(prev => template + '\n' + prev)` (prepends to editor) |
| Visibility | Only when `status === "waiting"` | When editor is interactive (`!gone && !done && !starting`) — visible during "working" too |
| Visual | Solid outline chip | **Dashed** outline chip + `PenLine` icon |

### Prepend mechanism

Uses the same `useDraft("conversation:prompt", "", { scope: conversation.id })` key as `prompt-input`. The `setDraft` setter accepts an updater function `(prev) => newValue`, writes to localStorage, and dispatches `singularity:draft-updated` — the `PromptEditor`'s `ValueSyncPlugin` picks up the change and updates the Lexical editor content. No focus management needed — user naturally clicks into the editor after inserting.

## File structure

```
plugins/conversations/plugins/conversation-view/plugins/prompt-templates/
├── CLAUDE.md
├── package.json
├── shared/
│   └── resources.ts              # Zod schema + resourceDescriptor
├── server/
│   ├── index.ts                  # ServerPluginDefinition (routes + resource)
│   └── internal/
│       ├── tables.ts             # prompt_templates pgTable
│       ├── tables-attachments.ts # Attachments.defineLink
│       ├── resources.ts          # defineResource (push mode)
│       ├── rank.ts               # nextRank() helper
│       ├── handle-list.ts
│       ├── handle-create.ts
│       ├── handle-update.ts
│       └── handle-delete.ts
└── web/
    ├── index.ts                  # PluginDefinition (contributions)
    └── components/
        ├── prompt-template-chips.tsx     # AbovePromptInput contribution
        └── prompt-templates-settings.tsx # Config.Section contribution
```

## Implementation steps

### 1. `package.json`

```json
{
  "name": "@singularity/plugin-conversations-conversation-view-prompt-templates",
  "private": true,
  "version": "0.0.1"
}
```

### 2. `shared/resources.ts`

Mirror quick-prompts. Resource key: `"prompt-templates"`.

```ts
import { z } from "zod";
import { resourceDescriptor } from "@plugins/primitives/plugins/live-state/shared";
import { RankSchema } from "@plugins/primitives/plugins/rank/shared";

export const PromptTemplateSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  rank: RankSchema,
});

export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

export const promptTemplatesResource = resourceDescriptor<PromptTemplate[]>(
  "prompt-templates",
  z.array(PromptTemplateSchema),
);
```

### 3. Server — DB tables, resource, rank, CRUD handlers

**All files mirror `quick-prompts/server/internal/` byte-for-byte**, with these renames:
- Table: `prompt_templates` (columns: id, title, prompt, rank, createdAt, updatedAt)
- Symbols: `promptTemplatesTable`, `promptTemplateAttachments`, `promptTemplatesServerResource`
- Routes: `/api/prompt-templates` (GET, POST) and `/api/prompt-templates/:id` (PATCH, DELETE)

Key imports (same as quick-prompts):
- `db` from `@plugins/database/server`
- `rankText` from `@plugins/primitives/plugins/rank/shared`
- `nextRankIn` from `@plugins/primitives/plugins/rank/server`
- `Attachments`, `extractAttachmentIds` from `@plugins/infra/plugins/attachments/server` and `@plugins/primitives/plugins/paste-images/shared`
- `defineResource` from `@server/resources`

### 4. `web/components/prompt-template-chips.tsx`

Key differences from `quick-prompt-chips.tsx`:
- **No sendingId state** — operation is synchronous (localStorage write)
- **useDraft** instead of fetch: `const [, setDraft] = useDraft("conversation:prompt", "", { scope: conversation.id })`
- **Click handler**: `setDraft(prev => t.prompt + (prev ? "\n" + prev : ""))`
- **Visibility gate**: `disabled` (`gone | done | starting`) rather than `status !== "waiting"`
- **Styling**: `border-dashed` class + `<PenLine className="mr-1 size-3" />` icon from lucide-react

```tsx
// Key parts:
const [, setDraft] = useDraft("conversation:prompt", "", { scope: conversation.id });

const disabled = live.status === "gone" || live.status === "done" || live.status === "starting";
if (!templates?.length || disabled) return null;

<Button variant="outline" size="sm" className="h-7 rounded-full border-dashed px-3 text-xs"
  onClick={() => setDraft(prev => t.prompt + (prev ? "\n" + prev : ""))}>
  <PenLine className="mr-1 size-3" />
  {t.title}
</Button>
```

### 5. `web/components/prompt-templates-settings.tsx`

Exact copy of `quick-prompts-settings.tsx` with renamed symbols and `/api/prompt-templates` routes. Same patterns: `deletingRef`, blur-to-save, `PromptEditor` with per-row namespace `prompt-template-${id}`.

### 6. `web/index.ts`

```ts
export default {
  id: "conversation-prompt-templates",
  name: "Conversation: Prompt Templates",
  description: "Template chips above the prompt input that prepend text to the editor draft for editing before sending.",
  contributions: [
    Conversation.AbovePromptInput({ id: "prompt-templates", component: PromptTemplateChips }),
    Config.Section({
      id: "prompt-templates",
      title: "Prompt Templates",
      description: "Named templates that appear as chips above the prompt input. Click a chip to prepend its text to your current draft.",
      component: PromptTemplatesSettings,
    }),
  ],
} satisfies PluginDefinition;
```

### 7. Build & verify

`./equin build` will:
- Auto-discover `server/index.ts` and `web/index.ts`, regenerate `plugins.generated.ts`
- Generate migration for `prompt_templates` + attachments join table
- Build frontend + restart server

## Verification

1. `./equin build` succeeds
2. Open Settings → "Prompt Templates" section → add a template (title + body) → verify it saves
3. Open a conversation → verify dashed chips with PenLine icon appear above the prompt input
4. Click a chip → verify template text is prepended to the editor (not sent)
5. Type additional text → press Enter → verify the combined text is sent as a turn
6. Verify quick-prompts still work independently (solid chips, immediate send)
7. Verify chips are hidden when conversation is `gone`/`done`/`starting`
8. Verify chips are visible when conversation is `working` (user can preload next message)
