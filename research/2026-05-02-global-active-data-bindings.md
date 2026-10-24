# Active-data bindings — persisting state for inline widgets

## Context

`<task>` cards (and any future block widget under `plugins/active-data/`) hold their result state in component-local React state. After a reload, `TaskCard` re-renders fresh from the immutable assistant text, so a task that was already created appears as a fresh editable card and can be re-created. The fix is a small generic primitive that lets any block widget persist a payload keyed by its position in the conversation, so the card can read back "I already created task X" on mount.

Scope: a new server-owned table + push resource on the `active-data` plugin, a typed wrapper consumers use to read/write their payload, slot props extended with a stable identity, and `TaskCard` migrated to it.

## Identity scheme

Each block widget instance is identified by:

```
(conversationId, messageId, tag, occurrenceIndex)
```

- `messageId` — Claude's per-event uuid, already on `AssistantTextEvent` (`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/shared/protocol.ts:40`). Optional in legacy logs; if absent we skip persistence (card behaves as today).
- `tag` — the block tag name (e.g. `"task"`).
- `occurrenceIndex` — count of prior block segments with the same tag in the same assistant message. Stable because `buildSegments` (`plugins/active-data/web/internal/segment-active-data.ts:25`) walks the regex left-to-right deterministically.

## Schema

New plugin server side under `plugins/active-data/server/`.

`plugins/active-data/server/internal/tables.ts`:

```ts
import { jsonb, pgTable, primaryKey, text, integer, timestamp } from "drizzle-orm/pg-core";
import { _conversations } from "@plugins/tasks-core/server";

export const _activeDataBindings = pgTable(
  "active_data_bindings",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => _conversations.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    tag: text("tag").notNull(),
    occurrenceIndex: integer("occurrence_index").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.conversationId, t.messageId, t.tag, t.occurrenceIndex],
    }),
  }),
);
```

Auto-discovered by `server/drizzle.config.ts` glob — no aggregator edit needed.

## Resource

One push resource per conversation (subscribe once, get all bindings for that conversation).

`plugins/active-data/server/internal/resource.ts`:

```ts
export const activeDataBindingsResource = defineResource<Payload, { conversationId: string }>({
  key: "active-data.bindings",
  mode: "push",
  schema: PayloadSchema,
  loader: async ({ conversationId }) =>
    db.select().from(_activeDataBindings).where(eq(_activeDataBindings.conversationId, conversationId)),
});
```

Mirror in `plugins/active-data/shared/resource.ts` via `resourceDescriptor`.

## HTTP surface

`PUT /api/active-data/bindings/:conversationId/:messageId/:tag/:occurrenceIndex`

Body: `{ payload: unknown }`. Upserts (last-write-wins on `payload` + `updatedAt`). Calls `activeDataBindingsResource.notify({ conversationId })`.

`DELETE /api/active-data/bindings/:conversationId/:messageId/:tag/:occurrenceIndex` — for "undo" / re-edit later (clears the binding so the card is editable again). Optional for v1 but cheap to include.

Plugin registration in `plugins/active-data/server/index.ts`, then add to `server/src/plugins.ts`.

## Typed wrapper (consumer-facing API)

In `plugins/active-data/web/index.ts`, ship one hook:

```ts
function useActiveDataBinding<T>(
  schema: ZodSchema<T>,
): {
  value: T | null;
  set: (next: T) => Promise<void>;
  clear: () => Promise<void>;
}
```

The hook reads identity from a React context populated by the host renderer (see "Slot wiring" below) — consumers don't pass `messageId`/`occurrenceIndex` themselves. If identity is absent (legacy log without `messageId`), `value` stays `null` and `set`/`clear` no-op. Internally:

- `useResource(activeDataBindingsResource, { conversationId })` (conversation comes from `conversationPane.useData()`).
- Filters to the single matching row, parses with the consumer's schema.
- `set` does a `PUT` and optimistically updates the query cache.

## Slot wiring

`plugins/active-data/web/slots.ts` extends `ActiveDataBlockContribution`'s component type to receive identity via context, not props — the slot signature stays `{ content, attrs }`. The host wraps each block in a tiny `<ActiveDataIdentityProvider messageId tag occurrenceIndex>` so the consumer hook reads it.

Renderer changes (`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/web/components/assistant-text-row.tsx:225`):

```tsx
{(() => {
  const counts = new Map<string, number>();
  return segments.map((seg, i) => {
    if (seg.type !== "block") return <Markdown key={i} text={seg.content} />;
    const tag = seg.tag;
    const idx = counts.get(tag) ?? 0;
    counts.set(tag, idx + 1);
    return (
      <ActiveDataIdentityProvider
        key={i}
        messageId={e.messageId}
        tag={tag}
        occurrenceIndex={idx}
      >
        <seg.component content={seg.content} attrs={seg.attrs} />
      </ActiveDataIdentityProvider>
    );
  });
})()}
```

`segment-active-data.ts` needs one tweak: the `block` segment must carry `tag` (currently only `component` is stored). Trivial — the regex already captures it.

## TaskCard migration

`plugins/active-data/plugins/task/web/components/task-card.tsx`:

```ts
const TaskBindingSchema = z.object({
  taskId: z.string(),
  launchedConvId: z.string().optional(),
});

const { value, set } = useActiveDataBinding(TaskBindingSchema);

// Replace local state branches:
if (value?.launchedConvId) return <ConvChip content={value.launchedConvId} attrs={{}} />;
if (value?.taskId) return <TaskChip taskId={value.taskId} />;
```

`onCreate` writes `set({ taskId: task.id })`. `onLaunched` writes `set({ taskId, launchedConvId })`. Local `useState` for `createdTask`/`launchedConvId` goes away; `creating`/`error` stay.

`TaskChip` becomes a small wrapper that takes `taskId` and reads the task from `useResource(tasksResource)` (or accepts the row from a small fetch — pick whichever already exists; `tasks-core` exposes `tasksResource`).

## Files to modify / create

Create:
- `plugins/active-data/server/index.ts`
- `plugins/active-data/server/internal/tables.ts`
- `plugins/active-data/server/internal/resource.ts`
- `plugins/active-data/server/internal/routes.ts`
- `plugins/active-data/shared/resource.ts`
- `plugins/active-data/web/internal/identity-context.tsx`
- `plugins/active-data/web/internal/use-active-data-binding.ts`

Modify:
- `plugins/active-data/web/index.ts` — export `useActiveDataBinding`
- `plugins/active-data/web/slots.ts` — no signature change (identity via context)
- `plugins/active-data/web/internal/segment-active-data.ts` — add `tag` to block segments
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/web/components/assistant-text-row.tsx` — count occurrences, wrap in identity provider
- `plugins/active-data/plugins/task/web/components/task-card.tsx` — replace local state with `useActiveDataBinding`
- `server/src/plugins.ts` — register active-data server plugin
- `plugins/active-data/CLAUDE.md` — document the binding API

## Verification

1. `./equin build` regenerates the migration and restarts. Confirm the migration adds `active_data_bindings`.
2. In a live conversation, get the agent to emit `<task>do thing</task>`, click **Create**. Card collapses to chip.
3. Reload the page. Card stays as the chip (was previously: editable card again).
4. Same for **Launch** → reload → still shows `ConvChip`.
5. Open a second `<task>` in the same message; verify `occurrenceIndex` keeps them independent (one chip, one editable, then both chips).
6. Open a legacy conversation without `messageId` on assistant events — confirm card still works (just non-persistent), no errors.
7. `./equin check` to confirm plugin-boundary + schema-in-sync pass.

## Open questions

- **Legacy fallback**: skip persistence when `messageId` absent (proposed) vs use `at` timestamp as fallback id. Skipping is simpler and old conversations don't have `<task>` tags anyway.
- **Bindings cleanup**: cascade on `_conversations` delete handles most cases. No further GC needed.
