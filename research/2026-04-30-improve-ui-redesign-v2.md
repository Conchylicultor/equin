# Improve Plugin UI Redesign — v2

## Context

The current multi-card improve UI (added in `b241bd9`) shows all task cards simultaneously inside a 440px popover. Each card row has a drag handle + editor + model chip side-by-side, leaving the editor ~312px wide — too narrow. Context (URL/Screenshot) is a single global section at the bottom.

## Requirements

1. **Context per-task** — URL + Screenshot move inside each card (every card can include its own context)
2. **Model chip below text** — stacked layout, not side-by-side
3. **Text full width** — no side columns stealing horizontal space
4. **Drag handle subtle** — nearly invisible; whole card is the drag target, a faint grip icon on hover only
5. **Model chip renamed** — `Queue → No`, full label `Auto-launch with [No | Sonnet | Opus]`

## Visual Layout

### Head card (always visible, not draggable)
```
┌──────────────────────────────────────────────┐
│ What should be improved?                     │  ← minRows=5, full inner width
│                                              │
│                                              │
│  Auto-launch with  [No] [Sonnet] [Opus]      │  ← below text
│  ☐ URL   ☐ Screenshot                       │  ← context below model chip
└──────────────────────────────────────────────┘
```

### Chain card (compact, draggable — whole card is drag target)
```
↓ blocks
┌──────────────────────────────────────────────┐  ← cursor-grab, faint ⠿ on top-right on hover
│ Next task…                                   │  ← minRows=2, full inner width
│                                              │
│  Auto-launch with  [No] [Sonnet] [Opus]      │
│  ☐ URL   ☐ Screenshot              [×]      │  ← remove at right
└──────────────────────────────────────────────┘
```

### Form footer
```
[ + task ]                    ← always visible below last card

[ Cancel ]       [ Submit / Submit chain ]
```
*(Context section removed from form — it lives inside each card now)*

---

## Files Changed

### 1. `plugins/improve/shared/types.ts`

Move `url` and `attachmentIds` into each card; remove global fields:

```typescript
export interface ImproveSubmitCard {
  text: string;
  launch: "sonnet" | "opus" | null;
  url?: string;           // non-empty → append to task description
  attachmentIds?: string[]; // include these attachments on this task
}

export interface ImproveSubmitBody {
  cards: ImproveSubmitCard[];
  // Note: url and attachmentIds are now per-card
}

export interface ImproveSubmitResponse {
  taskIds: string[];
}
```

### 2. `plugins/improve/server/internal/handle-submit.ts`

Remove global url/attachmentIds extraction. Apply context per card:

```typescript
// Per-card parsing (replaces head-only logic):
for (let i = 0; i < body.cards.length; i++) {
  const c = body.cards[i];
  const url = typeof c?.url === "string" ? c.url : "";
  const cardAttachmentIds = Array.isArray(c?.attachmentIds)
    ? c.attachmentIds.filter((id): id is string => typeof id === "string")
    : [];
  const attachments = []; // validate each attachment exists
  for (const id of cardAttachmentIds) { ... }
  const description = renderTaskDescription({ text: card.text, url, attachments });
  ...
  // Insert task attachments for every card (not just head):
  if (attachments.length > 0) { await db.insert(_taskAttachments)... }
}
```

The `renderTaskDescription` helper is unchanged.

### 3. `plugins/improve/web/components/model-chip.tsx`

Rename labels and add inline "Auto-launch with" prefix:

```typescript
// Rename values array:
const MODELS = [
  { value: "queue", label: "No" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

// Wrap in a row with prefix label:
export function ModelChip({ value, onChange, disabled }: ModelChipProps) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>Auto-launch with</span>
      <div role="radiogroup" ...>
        {MODELS.map(...)}
      </div>
    </div>
  );
}
```

### 4. `plugins/improve/web/components/improve-card.tsx`

**New props added to `ImproveCardProps`:**
```typescript
isHead?: boolean;
includeUrl: boolean;
onToggleUrl: (v: boolean) => void;
includeScreenshot: boolean;
onToggleScreenshot: (v: boolean) => void;
```

**Always call `useSortable` unconditionally** (hooks rules). For head card, ignore its return values.

**Head card path (`isHead === true`):**
```tsx
<div className="border-border bg-background flex flex-col rounded-md border p-2">
  <PromptEditor minRows={5} maxHeight="20rem" placeholder="What should be improved?" ... />
  <div className="flex items-center justify-between pt-1.5">
    <ModelChip value={model} onChange={onModelChange} disabled={disabled} />
  </div>
  <ContextRow includeUrl={includeUrl} onToggleUrl={onToggleUrl} ... />
</div>
```

**Chain card path (`isHead === false`):**
- Attach `setNodeRef`, `transform`, `transition` to outer div
- Attach `...attributes` and `...listeners` to outer div (whole card is drag target)
- Add `cursor-grab active:cursor-grabbing` + `group` classes to outer div
- Subtle drag indicator: `<MdDragIndicator className="absolute top-1 right-1 size-3 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity" />` (position-absolute within `relative` outer div)
- Remove the dedicated drag-handle `<button>` entirely
- Layout: full-width PromptEditor, then ModelChip row, then ContextRow + remove button

```tsx
<div
  ref={setNodeRef}
  style={style}
  {...attributes}
  {...listeners}
  className={cn(
    "border-border bg-background relative flex flex-col rounded-md border p-2 group cursor-grab active:cursor-grabbing",
    isDragging && "opacity-50 shadow-lg",
  )}
>
  <MdDragIndicator className="absolute top-1 right-1.5 size-3 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
  <PromptEditor minRows={2} maxHeight="8rem" placeholder="Next task…" ... />
  <div className="flex items-center justify-between pt-1.5">
    <ModelChip value={model} onChange={onModelChange} disabled={disabled} />
    <button onClick={onRemove} ...><MdClose className="size-3.5" /></button>
  </div>
  <ContextRow includeUrl={includeUrl} onToggleUrl={onToggleUrl} ... />
</div>
```

**New inline `ContextRow` component** (small, local to this file):
```tsx
function ContextRow({ includeUrl, onToggleUrl, includeScreenshot, onToggleScreenshot }: ...) {
  return (
    <div className="flex items-center gap-3 pt-1.5">
      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" className="h-3 w-3" checked={includeUrl} onChange={(e) => onToggleUrl(e.target.checked)} />
        URL
      </label>
      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" className="h-3 w-3" checked={includeScreenshot} onChange={(e) => onToggleScreenshot(e.target.checked)} />
        Screenshot
      </label>
    </div>
  );
}
```

### 5. `plugins/improve/web/components/improve-form.tsx`

**Width:** `w-[440px]` → `w-[480px]`

**Remove from `ImproveFormProps`:** `includeUrl`, `onToggleUrl`, `includeScreenshot`, `onToggleScreenshot`

**`CardDraft` gains:** `includeUrl: boolean`, `includeScreenshot: boolean`

**`makeCard` updated:**
```typescript
function makeCard(model: ChainModel): CardDraft {
  return { localId: crypto.randomUUID(), text: "", model, includeUrl: false, includeScreenshot: false };
}
```

**Head / chain split** (same as v1 plan):
```typescript
const headCard = cards[0]!;
const chainCards = cards.slice(1);
const hasChain = chainCards.length > 0;
```

**DnD wraps only chain cards** (DndContext block only rendered when `hasChain`).

**Remove the global Context section** from the form body entirely.

**Pass per-card context to each `ImproveCard`:**
```tsx
<ImproveCard
  isHead
  includeUrl={headCard.includeUrl}
  onToggleUrl={(v) => updateCard(0, { includeUrl: v })}
  includeScreenshot={headCard.includeScreenshot}
  onToggleScreenshot={(v) => updateCard(0, { includeScreenshot: v })}
  ...
/>
```

**`+task` button** replaces global "Add task" ghost button, always visible below the chain/head card.

### 6. `plugins/improve/web/components/improve-button.tsx`

**Remove state:** `includeUrl`, `includeScreenshot` (now live in `CardDraft`)

**Submit logic update** — capture screenshot once if any card needs it, share the attachment ID:
```typescript
const needsScreenshot = trimmed.some((c) => c.includeScreenshot);
let screenshotAttachmentId: string | null = null;
if (needsScreenshot) {
  flushSync(() => setOpen(false));
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const blob = await domToBlob(document.documentElement, { scale: window.devicePixelRatio || 1 });
  if (!blob) { Shell.Toast(...); return; }
  const uploaded = await uploadAttachment(blob, "page.png", "image/png");
  screenshotAttachmentId = uploaded.id;
}

const body: ImproveSubmitBody = {
  cards: trimmed.map<ImproveSubmitCard>((c) => {
    const cardAttachmentIds: string[] = [...extractAttachmentIds(c.text)];
    // Prefilled attachments apply to head only (first card)
    if (c === trimmed[0]) prefilled.forEach((p) => cardAttachmentIds.push(p.id));
    if (c.includeScreenshot && screenshotAttachmentId) cardAttachmentIds.push(screenshotAttachmentId);
    return {
      text: c.text,
      launch: c.model === "queue" ? null : c.model,
      url: c.includeUrl ? url : undefined,
      attachmentIds: cardAttachmentIds.length > 0 ? cardAttachmentIds : undefined,
    };
  }),
};
```

**Remove `includeUrl`/`includeScreenshot` from `<ImproveForm />` call.**

---

## Index mapping & edge cases (unchanged from v1)

- DnD operates on `chainCards` IDs; `onDragEnd` finds positions by ID in full `cards` array — no offset math needed.
- Removing last chain card: `cards.length` drops to 1, `hasChain → false`, DndContext unmounts cleanly.
- Single card initial state: `hasChain = false`, no DndContext, `+task` visible.

---

## Verification

1. `./equin build` — no build errors
2. Open `http://att-1777505065-adjs.localhost:9000`
3. Click "Improve" toolbar — see large single input with model chip + URL/Screenshot checkboxes inside the card
4. Check "URL" on the head card; submit → task description includes URL
5. Click `+task` → compact chain card appears with `↓ blocks`, subtle hover-only grip indicator
6. Check "Screenshot" on a chain card; submit → screenshot attached to that task only
7. Drag chain cards to reorder (whole card is the drag target)
8. Remove a chain card; head card stays
9. Submit single → "Launched with Sonnet" toast; submit chain → "Chained N tasks" toast
