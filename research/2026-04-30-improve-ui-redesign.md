# Improve Plugin UI Redesign

## Context

The current improve UI (added in `b241bd9`) shows all task cards simultaneously inside a 440px popover. Each card has a drag handle + PromptEditor + model chip in a horizontal row, leaving the editor at ~312px wide — too narrow to comfortably write prompts. The user wants to revert to a single prominent input as the primary UI, with chain tasks expandable via a `+task` button below.

## Goal

- Head card: large, full-width prompt input
- Chain cards: hidden until user clicks `+task`, then appear below in a compact draggable list
- Context section (URL + Screenshot): unchanged
- Server code: unchanged

## Visual Layout

```
[ Improve this app ]
[ prefilled attachments if any ]
┌──────────────────────────────────────────┐
│ What should be improved?                 │  ← head card, minRows=5, full width (~440px)
│                                          │
│                                          │
│                                          │
│                              [Queue|Snnt|Opus] │  ← model chip at bottom-right
└──────────────────────────────────────────┘

  ↓ blocks                                      ← only when chain cards exist
  ┌────────────────────────────────────────┐
  │ ≡  Next task…              [Snnt] [×] │  ← compact, draggable
  └────────────────────────────────────────┘

[ + task ]                                      ← always visible below

[ Context ]
  ☐ URL   ☐ Screenshot

[ Cancel ]           [ Submit / Submit chain ]
```

## Implementation

Only two files change. All other files (improve-button.tsx, model-chip.tsx, chain-connector.tsx, server) are untouched.

### 1. `improve-card.tsx`

Add optional prop `isHead?: boolean` (default `false`).

**Rule:** Always call `useSortable` unconditionally (hooks rules). Attach its ref/style/listeners only in the chain-card path.

**Head path (`isHead === true`):**
```tsx
if (isHead) {
  return (
    <div className="border-border bg-background flex flex-col rounded-md border p-2">
      <PromptEditor
        value={text} onChange={onTextChange} onSubmit={onSubmitChord}
        submitMode="cmd-enter"
        placeholder="What should be improved?"
        disabled={disabled} autoFocus={autoFocus}
        minRows={5} maxHeight="20rem"
        namespace={`improve-card-${cardId}`}
      />
      <div className="flex justify-end pt-1.5">
        <ModelChip value={model} onChange={onModelChange} disabled={disabled} />
      </div>
    </div>
  );
}
```

No drag handle. No remove button. Model chip in a bottom-right footer row.

**Chain card path (`isHead === false`):**
- Keep existing sortable layout
- Change `minRows={3}` → `minRows={2}`, `maxHeight="14rem"` → `maxHeight="8rem"`
- Placeholder stays `"Next task…"` (already the non-zero-index placeholder)

### 2. `improve-form.tsx`

**Width:** `w-[440px]` → `w-[480px]`

**Split head from chain cards:**
```tsx
const headCard = cards[0]!;
const chainCards = cards.slice(1);
const hasChain = chainCards.length > 0;
```

**Replace `isMulti`** with `cards.length > 1` inline (two places: submit label, context label).

**Add `appendChainCard`:**
```tsx
const appendChainCard = () => {
  if (submitting) return;
  const inheritFrom = cards[cards.length - 1];
  const model = inheritFrom?.model ?? NEW_CARD_DEFAULT_MODEL;
  onCardsChange([...cards, makeCard(model)]);
};
```

**New render structure:**
```tsx
{/* Head card — outside DndContext */}
<ImproveCard isHead cardId={headCard.localId} index={0} ... removable={false} onRemove={() => {}} />

{/* Chain section — only when hasChain */}
{hasChain && (
  <DndContext sensors={sensors} onDragStart={...} onDragEnd={onDragEnd} onDragCancel={...}>
    <SortableContext items={chainCards.map(c => c.localId)} strategy={verticalListSortingStrategy}>
      <div className="flex flex-col">
        {chainCards.map((card, chainIdx) => {
          const cardsIdx = chainIdx + 1;
          return (
            <Fragment key={card.localId}>
              <ChainConnector showBlocksLabel={true} disabled={submitting || !!draggingId} onInsert={() => insertAt(cardsIdx)} />
              <ImproveCard cardId={card.localId} index={cardsIdx} ... removable={true} onRemove={() => removeAt(cardsIdx)} />
            </Fragment>
          );
        })}
      </div>
    </SortableContext>
  </DndContext>
)}

{/* +task button — always visible */}
<Button size="sm" variant="ghost" onClick={appendChainCard} disabled={submitting} className="text-muted-foreground self-start">
  <MdAdd className="size-3.5" /> + task
</Button>

{/* Context section — unchanged */}
{/* Footer — unchanged except isMulti → cards.length > 1 */}
```

### DnD index mapping

`SortableContext` gets only `chainCards` IDs. `onDragEnd` already finds positions by ID search in the full `cards` array — head card ID never appears in any drag event. `arrayMove(cards, from, to)` operates on full array correctly. No translation needed.

### Edge Cases

| Case | Behaviour |
|------|-----------|
| Single card (initial state) | `hasChain=false`, DndContext not rendered, `+task` visible |
| Click `+task` | Appends card, `hasChain=true`, chain section appears, new card autofocused |
| Remove last chain card | `cards.length` drops to 1, `hasChain=false`, DndContext unmounts cleanly |
| Insert between chain cards | `ChainConnector` calls `insertAt(cardsIdx)` using full-array index |
| `autoFocusId` on head card open | Head card gets `autoFocus={autoFocusId === headCard.localId}` — works as before |

## Width Improvement

| Scenario | Editor width |
|----------|-------------|
| Old design (440px popover, any card) | ~312px |
| New design (480px popover, head card) | ~440px (+41%) |
| New design (480px popover, chain card) | ~320px (same as before) |

## Files to Modify

- `plugins/improve/web/components/improve-card.tsx`
- `plugins/improve/web/components/improve-form.tsx`

## Verification

1. `./equin build` — confirm no build errors
2. Open `http://att-1777505065-adjs.localhost:9000`
3. Click "Improve" toolbar button
4. Verify: large single input, model chip at bottom-right of card
5. Click `+task` → chain card appears below with `↓ blocks` connector, compact editor, drag handle, model chip, remove button
6. Click `+task` again → second chain card appended
7. Drag chain cards to reorder
8. Remove a chain card; verify head card remains
9. Submit with single card → "Launched with Sonnet" toast
10. Submit with chain → "Chained N tasks" toast
