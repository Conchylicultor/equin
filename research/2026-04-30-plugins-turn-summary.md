# Turn Summary Plugin

## Context

After every assistant turn, the user wants a small Haiku-generated summary card to appear above the prompt input bar — replacing the previous summary on each new turn. The card shows three things: a one-line summary of what just happened, bullet points of caveats / things to review or decide, and bullet points of suggested next actions. The goal is to give the user a fast, structured "what now?" read at the moment they're about to type the next prompt — without needing to re-read the full assistant response.

This mirrors the existing `conversation-category` plugin (Haiku auto-classifier on each turn) and the `summary` plugin (on-demand Sonnet summary in a side pane), but is per-turn, automatic, and rendered inline above the prompt input.

## Design summary

- **New sub-plugin**: `plugins/conversations/plugins/conversation-view/plugins/turn-summary/`. Sibling to `prompt-input`, `quick-prompts`, `summary`.
- **New slot in the host**: `Conversation.AbovePromptInput` (added to `conversation-view/web/slots.ts`) and rendered in `conversation-view.tsx` between the message stream and the prompt input. Multi-contributor (other plugins can add banners later).
- **Trigger**: persistent global trigger on `conversationTurnCompleted`, identical pattern to `conversation-category`.
- **Generation**: `runClaudePrint({ model: "haiku" })` with a system prompt that asks for **markdown with three fixed sections** (`## Summary` / `## Caveats` / `## Actions`). Parsed on the server into three text columns.
- **Persistence**: own table `turn_summaries` keyed by `conversationId` (one row per conversation; upserted on each turn). `messageId` stored for idempotency (skip if already processed).
- **Push resource** `turnSummariesResource` (mode `"push"`) — `Record<string, TurnSummary | null>`. Frontend uses `useResource` and looks up by current `conversation.id`.
- **Display**: latest only. Card hides entirely when no row exists.

## Files to create

### `plugins/conversations/plugins/conversation-view/plugins/turn-summary/`

- `package.json` — workspace manifest, mirror `conversation-category/package.json` deps (drizzle, react, etc.).
- `server/index.ts` — barrel: `import "./internal/job"; export { _turnSummaries } from "./internal/tables"; export { turnSummariesResource } from "./internal/resource"; export default definePlugin({ id: "turn-summary", onReady: registerTrigger })`.
- `server/internal/tables.ts` — Drizzle schema:
  ```ts
  export const _turnSummaries = pgTable("turn_summaries", {
    conversationId: text("conversation_id").primaryKey()
      .references(() => _conversations.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),       // assistant turn id, for idempotency
    summary: text("summary").notNull(),            // one-line
    caveats: text("caveats").notNull().default(""), // markdown bullets
    actions: text("actions").notNull().default(""),// markdown bullets
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  });
  ```
- `server/internal/job.ts` — `generateTurnSummaryJob` defined via `defineJob`. Skip if `existing.messageId === event.messageId`. Read user turn via `readConversationTurns(conversationId)` and pick the last `role === "user"`. Assistant text is in the event payload (`event.text`). Build prompt, call `runClaudePrint({ model: "haiku", system, prompt, timeoutMs: 12_000 })`. Parse output with `parseMarkdownSections` (next file). Upsert row, then `turnSummariesResource.notify()`. Catch `ClaudeCliError` and log + return like `conversation-category` does.
- `server/internal/parse.ts` — tiny pure function `parseMarkdownSections(raw): { summary, caveats, actions }`. Splits on `^##\s+(Summary|Caveats|Actions)$`. Tolerant: missing sections → empty strings. If no header at all, dump everything into `summary`.
- `server/internal/resource.ts` — `turnSummariesResource = defineResource({ key: "turn-summaries", mode: "push", schema: TurnSummariesPayloadSchema, loader: async () => Object.fromEntries(rows.map(r => [r.conversationId, r])) })`.
- `server/internal/register-trigger.ts` — `onReady` body:
  ```ts
  await deleteTriggersFor(generateTurnSummaryJob);
  await trigger({ on: conversationTurnCompleted, do: generateTurnSummaryJob, with: {}, oneShot: false });
  ```
- `shared/index.ts` — `TurnSummary` type, `TurnSummarySchema` (zod), `TurnSummariesPayloadSchema`, `turnSummariesResource` shared descriptor.
- `web/index.ts` — barrel: `import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";` + `contributions: [Conversation.AbovePromptInput({ component: TurnSummaryCard })]`.
- `web/components/turn-summary-card.tsx` — collapsible card. Reads `turnSummariesResource` via `useResource`, looks up by `conversation.id`, returns `null` if no row. Renders `summary` as a single line, `caveats` and `actions` via `ReactMarkdown` (strip the `## …` headers, render bullets). Light/dark theme aware. Use icons from `lucide-react` for caveats (alert) and actions (arrow-right).
- `CLAUDE.md` — handwritten prose: how the trigger fires, idempotency rule, schema location, why we don't add columns to `_conversations`. Mirror `conversation-category/CLAUDE.md`.

## Files to modify

### `plugins/conversations/plugins/conversation-view/web/slots.ts`

Add the new slot:
```ts
export const Conversation = {
  PromptBar: defineSlot< … >("conversation.prompt-bar"),
  PromptInput: defineSlot< … >("conversation.prompt-input"),
  AbovePromptInput: defineSlot<{
    component: ComponentType<{ conversation: ConversationRecord }>;
  }>("conversation.above-prompt-input"),
};
```

### `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx`

Hook the slot into the bottom bar. After line 50 (`promptInputItems`), add:
```ts
const abovePromptInputItems = Conversation.AbovePromptInput.useContributions();
```
Inside the `mainBlock` JSX (around line 80), prepend the contributions inside the bottom bar `<div>` *before* `<PromptInputComponent />`:
```tsx
{abovePromptInputItems.map((item, i) => {
  const Cmp = item.component;
  return <Cmp key={i} conversation={conversation} />;
})}
```
The bottom bar's `flex-col gap-2` already gives correct vertical spacing.

Also update `showBottomBar` to include `abovePromptInputItems.length > 0` so the bar renders even if only the summary card is contributing.

### `plugins/conversations/plugins/conversation-view/CLAUDE.md`

Update the `Slots:` line to include `Conversation.AbovePromptInput` and add the new sub-plugin entry under `Sub-plugins`.

### Plugin registries

- `web/src/plugins.ts` — register the new `turn-summary` web plugin.
- `server/src/plugins.ts` — register the new `turn-summary` server plugin.

## Reuse map (existing primitives — do not duplicate)

| Need | Use |
|---|---|
| Trigger on every turn | `conversationTurnCompleted`, `defineTriggerEvent`, `trigger`, `deleteTriggersFor` from `@plugins/infra/plugins/events/server` |
| Define a job | `defineJob` from `@plugins/infra/plugins/jobs/server` |
| Run Haiku one-shot | `runClaudePrint` from `@plugins/infra/plugins/claude-cli/server` |
| Read user-turn text | `readConversationTurns` from `@plugins/conversations/server` |
| Push live data to clients | `defineResource` (mode `"push"`), `useResource` |
| Cascade-delete on conversation removal | FK on `_conversations.id` from `@plugins/tasks-core/server` |
| Render markdown bullets | `react-markdown` (already used by `task-description`, `summary`) |

## Prompt design

System prompt:
```
You are summarizing the latest exchange between a user and an AI coding assistant.
Output ONLY markdown with these three sections, in order, using these exact headers:

## Summary
<one short sentence — what just happened, max ~20 words>

## Caveats
- <thing the user should review/double-check/decide on>
- <one bullet per item; 0–4 bullets; omit section body entirely if none>

## Actions
- <suggested next step the user could take>
- <one bullet per item; 0–4 bullets; omit section body entirely if none>

Be terse. No prose outside the sections. No code blocks.
```

User prompt is two clearly delimited blocks:
```
### USER
<last user turn text, trimmed>

### ASSISTANT
<event.text, trimmed>
```

Timeout: `12_000ms` (matches conversation-category).

## Verification

1. `./equin build` — confirms migration generates cleanly and server restarts.
2. Open `http://<worktree>.localhost:9000/`, start a conversation, send a turn, wait ~2s after the turn completes. The card should appear above the prompt input with the three sections.
3. Send another turn — the card should update in place (push resource).
4. Close + reopen the conversation tab — card should re-hydrate from the resource on first load (no flicker).
5. Edge cases to confirm manually:
   - Conversation with zero completed turns — card hidden.
   - Conversation deleted — row gone (cascade FK).
   - Haiku timeout / failure — no row written, no card, no UI error toast.
   - Same `messageId` event re-fired (e.g. server restart re-emits last turn) — job is a no-op.
6. `./equin check` — passes (especially `migrations-in-sync` and `plugin-boundaries`).
7. Use `e2e/screenshot.mjs` to capture the conversation view after a turn and visually confirm the card layout.

## Out of scope (deferred)

- History view / scroll-back of prior turn summaries (user picked "latest only" — keep schema flexible enough that we can switch to per-turn-keyed storage later by adding `messageId` to the PK).
- User dismiss / hide preference.
- Manual re-generate button.
- Configurable model (Haiku is hard-coded; can move to `Config.Spec` later).
