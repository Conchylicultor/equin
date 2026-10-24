# Conversation Model Selection (+Sonnet / +Opus)

## Context

Conversations currently launch Claude through tmux with no way to pick a model — the CLI picks a default. We want the user to choose at creation time so that heavy reasoning can use Opus while routine work uses Sonnet, and so that the chosen model is visible in the conversation UI.

Concretely:

- Replace the single "New conversation" button in the sidebar with two buttons: **+Sonnet** and **+Opus**.
- Persist the model on the conversation row so it survives across reloads/restarts.
- Propagate the model to the tmux runtime so Claude CLI is launched with `--model <name>`.
- Render the model as a colored chip next to the conversation title.

## Design

Model is a new first-class column on `_conversations`, flowing: UI button → `POST /api/conversations` body → `createConversation()` → DB insert → `runtime.create(..., { model })` → tmux `claude --model <name>` launch. On the web side, the existing `Conversation.Toolbar` slot (group `status`) already renders chips beside the title — we add a new nested plugin `model` that contributes a `ModelBadge` to that slot, mirroring the `status` plugin exactly.

### 1. Schema + migration

**`plugins/conversations/server/schema_internal.ts`** — add column:

```ts
model: text("model").$type<ConversationModel>().notNull().default("opus"),
```

**`plugins/conversations/server/model.ts`** (new) — enum + type, mirroring `status.ts`:

```ts
import { z } from "zod";
export const ConversationModelSchema = z.enum(["opus", "sonnet"]);
export type ConversationModel = z.infer<typeof ConversationModelSchema>;
```

**`plugins/conversations/server/schema.ts`** — re-export and refine Zod:

```ts
export { ConversationModelSchema } from "./model";
export type { ConversationModel } from "./model";

export const ConversationSchema = createSelectSchema(_conversations, {
  status: ConversationStatusSchema,
  model: ConversationModelSchema,     // <-- add
  createdAt: z.coerce.date(),
  ...
});
```

**Migration** — regenerated automatically by `./equin build` (never run `drizzle-kit generate` manually, per CLAUDE.md). Expected form:

```sql
ALTER TABLE "conversations" ADD COLUMN "model" text DEFAULT 'opus' NOT NULL;
```

### 2. Runtime API

**`plugins/conversations/server/api.ts`** — extend `ConversationRuntime.create()`:

```ts
create(
  conversationId: string,
  worktreePath: string,
  opts?: { prompt?: string; model?: ConversationModel },
): Promise<void>;
```

**`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`** — inject `--model` flag into the Claude command (lines 95–124):

```ts
const modelFlag = opts?.model ? ` --model ${opts.model}` : "";
const claudeBase = `${CLAUDE}${modelFlag}`;
const claudeCmd = hasPrompt ? `${claudeBase} "$SINGULARITY_PROMPT"` : claudeBase;
```

Shell-quoting is safe here because the values come from the validated enum.

### 3. Creation API + lifecycle

**`plugins/conversations/server/internal/handle-create.ts`** — accept and validate `model`:

```ts
const body = (await req.json().catch(() => ({}))) as {
  taskId?: string; attemptId?: string; prompt?: string;
  runtime?: string; model?: string;
};
const model = body.model ? ConversationModelSchema.parse(body.model) : undefined;
const session = await createConversation({ ..., model });
```

**`plugins/conversations/server/internal/lifecycle.ts`** — thread model through (lines 24–94):

- Add `model?: ConversationModel` to `createConversation` opts.
- Default to `"opus"` if omitted.
- Insert into DB: `.values({ id, attemptId, runtime: runtimeId, model })`.
- Forward to runtime: `runtime.create(conversationId, worktreePath, { prompt: opts.prompt, model })`.

### 4. Sidebar buttons

**`plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`** — replace the single "New conversation" button (lines 67–75) with two:

```tsx
const createConversation = async (model: "opus" | "sonnet") => {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  const conversation = ConversationSchema.parse(await res.json());
  openConversation(conversation.id);
  setActiveId(conversation.id);
};

<div className="flex gap-2">
  <Button variant="outline" size="sm" className="flex-1 gap-1" onClick={() => createConversation("sonnet")}>
    <MdAdd className="size-4" /> Sonnet
  </Button>
  <Button variant="outline" size="sm" className="flex-1 gap-1" onClick={() => createConversation("opus")}>
    <MdAdd className="size-4" /> Opus
  </Button>
</div>
```

### 5. Model chip in the title

Create a new nested plugin mirroring `status/`:

```
plugins/conversations/plugins/conversation-view/plugins/model/
├── package.json
├── web/
│   ├── index.ts
│   └── components/
│       └── model-badge.tsx
```

**`model-badge.tsx`** — same shape as `status-badge.tsx`:

```tsx
const MODEL_CLASSES: Record<ConversationModel, string> = {
  opus:   "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  sonnet: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

export function ModelBadge({ conversation }: { conversation: ConversationState }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${MODEL_CLASSES[conversation.model]}`}>
      {conversation.model}
    </span>
  );
}
```

**`web/index.ts`** — contribute to the toolbar `status` group so it sits beside the status chip:

```ts
const modelPlugin: PluginDefinition = {
  id: "conversation-model",
  name: "Conversation: Model",
  description: "Displays the conversation model as a colored chip in the toolbar.",
  contributions: [Conversation.Toolbar({ component: ModelBadge, group: "status" })],
};
```

Register the plugin in the web plugin registry following the pattern already used by `status`.

The `ConversationState` type consumed by toolbar components derives from `ConversationSchema`, so adding `model` to the schema automatically makes it available to the badge — no separate client-side type work required.

### 6. `docs/plugins.md`

Add the new `model` plugin entry under the `conversation-view` plugins tree.

## Critical files

| Concern | Path |
| --- | --- |
| DB column | `plugins/conversations/server/schema_internal.ts` |
| Model enum | `plugins/conversations/server/model.ts` (new) |
| Schema exports | `plugins/conversations/server/schema.ts` |
| Runtime contract | `plugins/conversations/server/api.ts` |
| Tmux launch | `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts` |
| Create handler | `plugins/conversations/server/internal/handle-create.ts` |
| Lifecycle | `plugins/conversations/server/internal/lifecycle.ts` |
| Sidebar buttons | `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` |
| Model badge plugin | `plugins/conversations/plugins/conversation-view/plugins/model/` (new) |
| Plugins doc | `docs/plugins.md` |

## Verification

1. `./equin build` — confirms a new migration is generated and commits it in the same PR.
2. Open `http://<worktree>.localhost:9000/` — sidebar shows **+Sonnet** and **+Opus**.
3. Click **+Opus**, wait for the pane to start, and verify:
   - The conversation title shows a purple `opus` chip next to the green status chip.
   - `tmux list-sessions` (inside the worktree) shows a session running `claude --model opus`.
4. Click **+Sonnet**, verify sky-blue chip and `claude --model sonnet` command line.
5. Reload the page: chips persist (value came from the DB, not memory).
6. `./equin check` — migrations-in-sync passes.
