# Chain Connector Unlink Toggle

## Context

When creating multiple tasks via the Improve button (or any `TaskDraftPopover`), every card in the chain is automatically blocked by the one above it. There is no way to launch two tasks in parallel. The blocking relationship is purely positional and implicit — the server derives it from card order with no opt-out.

The goal is to let users break individual connectors so specific pairs of tasks launch independently, while keeping the sequential default.

---

## Design: Option C — Unlink button on the connector

Each `ChainConnector` between two cards has two visual states:

**Linked (default):**
- Thin connector with `↓ blocks` label (current appearance)
- On hover: label fades, a chain-break icon (`Link2Off`) appears — clicking it unlinks

**Unlinked:**
- Dashed gap with a muted `∥ parallel` label (or just dashed line)
- On hover: `Link2` icon appears — clicking it re-links
- The insert-card `+` button is suppressed when unlinked (inserting between unlinked cards is ambiguous; user can re-link first)

The toggle operates at the connector level. If there are three cards A→B→C and the A→B connector is unlinked, A and B launch in parallel; C still waits on B.

---

## State model

Add `linkedToPrev: boolean` to `CardDraft`:

```ts
export interface CardDraft {
  localId: string;
  text: string;
  model: ChainModel;
  includeUrl: boolean;
  includeScreenshot: boolean;
  includeParentTask: boolean;
  linkedToPrev: boolean;   // NEW — defaults true; irrelevant on head card (index 0)
}
```

- `makeCard()` initialises `linkedToPrev: true`
- Toggle: `cards[i].linkedToPrev = !cards[i].linkedToPrev` (immutable update via `onCardsChange`)
- Drag reorder: `linkedToPrev` travels with the card (via existing `arrayMove`) — semantically fine since unlinked cards remain unlinked after a reorder

---

## Files to modify

### 1. `plugins/tasks/plugins/task-draft-form/web/components/chain-connector.tsx`

Replace the `showBlocksLabel: boolean` prop with `linked: boolean` and add `onToggle: () => void`. Remove the insert button when unlinked (suppress `onInsert`).

New props interface:
```ts
export interface ChainConnectorProps {
  linked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  onInsert: () => void;
}
```

Render two distinct states:
- **linked**: existing layout; on hover replace "↓ blocks" with a `Link2Off` icon button that calls `onToggle`. Keep the `+` insert button.
- **unlinked**: dashed `border-dashed` horizontal rule, muted `∥` label; on hover show a `Link2` icon button to re-link. Hide the `+` insert button.

Use `lucide-react` icons `Link2` and `Link2Off` (already available in the repo).

### 2. `plugins/tasks/plugins/task-draft-form/web/components/task-draft-form.tsx`

a. Add `linkedToPrev: true` to `makeCard()`.

b. Add a toggle handler passed to each `ChainConnector`:
```ts
const toggleLink = (idx: number) => {
  onCardsChange(
    cards.map((c, i) => (i === idx ? { ...c, linkedToPrev: !c.linkedToPrev } : c))
  );
};
```

c. Pass to `ChainConnector` (rendered between cards at index `idx-1` and `idx`):
```tsx
<ChainConnector
  linked={cards[idx].linkedToPrev}
  onToggle={() => toggleLink(idx)}
  disabled={submitting || !!draggingId}
  onInsert={() => insertAt(idx)}
/>
```

Remove the hardcoded `showBlocksLabel={true}`.

### 3. `plugins/tasks/plugins/task-draft-form/core/types.ts`

Add `linkedToPrev` to the per-card schema in `TaskChainSubmitBody`:
```ts
cards: z.array(
  z.object({
    text: z.string().min(1),
    launch: z.enum(["sonnet", "opus"]).nullable(),
    url: z.string().optional(),
    attachmentIds: z.array(z.string()).optional(),
    includeParentTask: z.boolean().optional(),
    linkedToPrev: z.boolean().optional(),   // NEW — omitted = true (backward-compat)
  })
).min(1),
```

### 4. `plugins/tasks/plugins/task-draft-form/web/internal/submit.ts`

Include `linkedToPrev` per card:
```ts
cards: cards.map((c, i) => ({
  text: c.text,
  launch: ...,
  ...,
  ...(i > 0 && !c.linkedToPrev ? { linkedToPrev: false } : {}),
})),
```

Only send `linkedToPrev: false` for non-head unlinked cards (omitting it for the head and for all linked cards keeps the body slim and backward-compatible).

### 5. `plugins/tasks/server/internal/handle-create-chain.ts`

Change the positional dependency logic (currently around line 123):

```ts
// Before:
if (!isHead) {
  blockerIds.push(taskIds[i - 1]!);
}

// After:
if (!isHead && card.linkedToPrev !== false) {
  blockerIds.push(taskIds[i - 1]!);
}
```

`armTaskAutoStart` already uses the same `blockerIds` list, so it automatically inherits the correct behaviour — an unlinked card with `launch` set will start immediately without waiting.

---

## Verification

1. `./equin build` — confirm no TS errors, migrations unchanged
2. Open Improve button → add 3 tasks
3. Hover the first connector → chain-break icon appears, click it
4. Connector renders as dashed + `∥` label; insert `+` is hidden
5. Submit — confirm in DB (`query_db`) that the second task has **no** `depends_on` row pointing to the first, while the third task **does** depend on the second
6. Re-hover unlinked connector → `Link2` re-link icon appears, click → connector restores to linked state
7. Drag-reorder cards — confirm `linkedToPrev` flag travels with the card
