# Conversation Progress Tracking

## Context

Per-conversation progress tracking for the Singularity agent manager. After each assistant turn, a Haiku model classifies the conversation into one of four sequential phases (`research → plan → implementation → pushed`). Additionally, when a push event lands in the DB the phase is immediately forced to `pushed` without waiting for another turn. A 4-dot progress bar appears in the conversation toolbar (left of other chips) and in the sidebar conversation list item (compact chip).

---

## Plugin Location

**New directory:** `plugins/conversations/plugins/conversation-progress/`

Sibling to `conversation-category` within the `conversations` sub-plugin tree.

**Registration:**
- `server/src/plugins.ts` — add import + entry after `conversationCategoryPlugin`
- `web/src/plugins.ts` — add import + entry after `conversationCategoryPlugin`

---

## Data Layer

### DB Schema (`server/internal/tables.ts`)

```ts
export const _conversationProgress = pgTable("conversation_progress", {
  conversationId: text("conversation_id")
    .primaryKey()
    .references(() => _conversations.id, { onDelete: "cascade" }),
  phase: text("phase", { enum: ["research", "plan", "implementation", "pushed"] }).notNull(),
  messageId: text("message_id"),   // null for push-triggered; idempotency key for Haiku turns
  source: text("source", { enum: ["haiku", "push"] }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

One row per conversation. Cascade-deletes with the parent conversation.

### Shared Schemas (`shared/schemas.ts`)

```ts
export const PHASE_ORDER = ["research", "plan", "implementation", "pushed"] as const;
export type ConversationPhase = typeof PHASE_ORDER[number];

export const ConversationProgressSchema = z.object({
  phase: z.enum(PHASE_ORDER),
  source: z.enum(["haiku", "push"]),
  updatedAt: z.coerce.date(),
});
export type ConversationProgressEntry = z.infer<typeof ConversationProgressSchema>;

export const ConversationProgressPayloadSchema = z.record(z.string(), ConversationProgressSchema);
export type ConversationProgressPayload = z.infer<typeof ConversationProgressPayloadSchema>;

export const conversationProgressResource = resourceDescriptor<ConversationProgressPayload>(
  "conversation-progress",
  ConversationProgressPayloadSchema,
);
```

### Resource (`server/internal/resource.ts`)

Push resource (mode `"push"`) keyed `"conversation-progress"`. Loader returns the full map `Record<conversationId, { phase, source, updatedAt }>`. After every upsert, call `.notify()` to push to all subscribers. Pattern: identical to `conversation-category`'s resource.

---

## Server Jobs

### `server/internal/haiku-job.ts` — turn-triggered classification

Triggered by `conversationTurnCompleted`. Pattern mirrors `classify-job.ts` exactly, with per-turn idempotency (like `turn-summary`) and monotonicity enforcement.

**Key logic:**
1. Extract `conversationId` and `messageId` from event payload; skip if `messageId` is null.
2. Fetch existing row; if `existing.messageId === messageId`, return early (idempotent).
3. Fetch last 6 turns via `readConversationTurns`; build transcript digest (`### USER\n...\n\n### ASSISTANT\n...`).
4. Call `runClaudePrint({ model: "haiku", system: SYSTEM_PROMPT, prompt: digest, timeoutMs: 12_000 })`.
5. Parse: `PHASE_ORDER.find(p => reply.trim().toLowerCase() === p) ?? "research"`.
6. **Monotonicity:** `finalPhase = newIndex >= currentIndex ? newPhase : existing.phase`.
7. Upsert `{ conversationId, phase: finalPhase, messageId, source: "haiku" }` → `resource.notify()`.

**Haiku system prompt:**
```
You determine the current phase of a software engineering conversation between a user and an AI coding assistant.

Reply with EXACTLY ONE of these phases, copied verbatim, on a single line — no quotes, no prose:

research
plan
implementation
pushed

Guidelines:
- "research": Exploring code, reading files, asking questions. No concrete plan or code written yet.
- "plan": A design doc or plan has been written (e.g. a research/*.md file). Implementation not started.
- "implementation": Code has been written, edited, or bugs fixed. Agent is actively building.
- "pushed": Changes pushed to the repository (e.g. ./equin push completed successfully).
```

### `server/internal/push-job.ts` — push-event triggered

Triggered by `pushLanded` (from `@plugins/tasks-core/server`). No Haiku — directly writes the terminal state.

**Key logic:**
1. Extract `attemptId` from event payload.
2. Query conversations: `db.select({ id }).from(_conversations).where(eq(_conversations.attemptId, attemptId))`.
3. Upsert all to `{ phase: "pushed", messageId: null, source: "push" }` (no monotonicity check — push is terminal).
4. Call `conversationProgressResource.notify()` once.

### `server/index.ts`

```ts
onReady: async () => {
  await deleteTriggersFor(classifyProgressJob);
  await trigger({ on: conversationTurnCompleted, do: classifyProgressJob, with: {}, oneShot: false });
  await deleteTriggersFor(markProgressPushedJob);
  await trigger({ on: pushLanded, do: markProgressPushedJob, with: {}, oneShot: false });
},
```

---

## Frontend

### Hook (`web/internal/use-progress.ts`)

```ts
export function useProgressFor(id: string): ConversationProgressEntry | null {
  const { data } = useResource(conversationProgressResource);
  return data?.[id] ?? null;
}
```

### `web/components/progress-dots.tsx` — shared primitive

Props: `{ phase: ConversationPhase | null; compact?: boolean }`

Renders 4 dots. States:
- **Past** (index < current): filled, muted green (`bg-green-600/70`)
- **Active** (index === current): filled, accent (`bg-primary`)  
- **Future** (index > current): empty outline (`border border-muted-foreground/40`)

**Toolbar layout** (`compact=false`):
```
● ── ● ── ○ ── ○   Implementation
```
Dots are `w-2 h-2 rounded-full`. Connectors: `h-px w-3 bg-muted-foreground/30`. Phase label: `text-xs text-muted-foreground ml-1`.

**Sidebar layout** (`compact=true`):
```
● ● ○ ○
```
Dots only, `gap-0.5`, no connectors, no label.

Returns `null` if `phase` is null.

### `web/components/progress-bar-toolbar.tsx`

- No props (bare `ComponentType` — toolbar contribution pattern)
- `const { conversation } = conversationPane.useData()`
- If `conversation.kind === "system"`, return `null`
- Uses `useProgressFor(conversation.id)` → renders `<ProgressDots phase={progress.phase} />`

### `web/components/progress-bar-row.tsx`

- Props: `{ conv: ConversationItemConv }` (sidebar chip pattern)
- If `conv.kind === "system"`, return `null`
- Uses `useProgressFor(conv.id)` → renders `<ProgressDots phase={progress.phase} compact />`

### `web/index.ts` contributions

```ts
contributions: [
  conversationPane.Actions({ component: ProgressBarToolbar, position: "left" }),
  Item.Chips({ component: ProgressBarRow }),
],
```

---

## File Listing

**Create:**
- `plugins/conversations/plugins/conversation-progress/package.json`
- `plugins/conversations/plugins/conversation-progress/CLAUDE.md`
- `plugins/conversations/plugins/conversation-progress/shared/schemas.ts`
- `plugins/conversations/plugins/conversation-progress/server/index.ts`
- `plugins/conversations/plugins/conversation-progress/server/internal/tables.ts`
- `plugins/conversations/plugins/conversation-progress/server/internal/resource.ts`
- `plugins/conversations/plugins/conversation-progress/server/internal/haiku-job.ts`
- `plugins/conversations/plugins/conversation-progress/server/internal/push-job.ts`
- `plugins/conversations/plugins/conversation-progress/web/index.ts`
- `plugins/conversations/plugins/conversation-progress/web/internal/use-progress.ts`
- `plugins/conversations/plugins/conversation-progress/web/components/progress-dots.tsx`
- `plugins/conversations/plugins/conversation-progress/web/components/progress-bar-toolbar.tsx`
- `plugins/conversations/plugins/conversation-progress/web/components/progress-bar-row.tsx`

**Modify:**
- `server/src/plugins.ts` — add entry after `conversationCategoryPlugin`
- `web/src/plugins.ts` — add entry after `conversationCategoryPlugin`

---

## Key Reference Files

- `plugins/conversations/plugins/conversation-category/server/internal/classify-job.ts` — Haiku job pattern to replicate
- `plugins/conversations/plugins/conversation-view/plugins/turn-summary/server/internal/job.ts` — per-turn idempotency pattern
- `plugins/conversations/plugins/conversation-category/server/internal/resource.ts` — push resource pattern
- `plugins/conversations/plugins/conversation-category/web/components/category-chip-row.tsx` — sidebar chip pattern
- `plugins/conversations/plugins/conversation-category/web/components/category-chip-toolbar.tsx` — toolbar chip pattern
- `plugins/tasks-core/server/internal/tables-events.ts` — `pushLanded` event definition

---

## Verification

1. `./equin build` — no TS errors; `conversation_progress` migration generated and applied.
2. Send a message in any agent conversation → after ~5 s, toolbar shows `● ── ○ ── ○ ── ○  Research`; sidebar chip shows `● ○ ○ ○`.
3. A conversation where a plan doc was written shows 2 filled dots (`plan` phase) after the next turn.
4. After `./equin push`, the bar immediately jumps to all 4 dots filled (`Pushed`) without requiring another turn.
5. A conversation previously at `implementation` never regresses to `research` even if Haiku mis-classifies.
6. Hard-refresh the browser — phases persist (data is in DB, served via push resource).
7. `kind === "system"` conversations show no progress bar in either location.
