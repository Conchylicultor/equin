# Review pane: shared commit source selector

## Context

The review pane (`plugins/review/`) has an extensible section system built on `defineDetailSections<{ conversationId }>`. Sub-plugins contribute sections that receive `{ conversationId }` as props.

The commit selector ("Working tree" + push tabs) currently lives *inside* `CodeReviewSection` as local state. `PluginChangesSection` and any future sections never see the selected source — they always show working-tree diffs.

**Goal:** Lift the commit selector to the pane level so all sections receive the selected source via entity props, and switching source automatically updates every section.

## Approach: widen `EntityProps`

`defineDetailSections` already threads entity props to every section component via `Review.Host`. Today it's `{ conversationId: string }`. We widen to:

```ts
type Source = { kind: "working" } | { kind: "push"; pushId: string };
interface ReviewProps { conversationId: string; source: Source }
```

The pane body owns source state, renders `SourceTabs` above `Review.Host`, and passes `source` through. Each section receives `source` and decides how to use it.

### The summary component caveat

`ReviewButton` (toolbar, outside the pane) renders `summary` components from each section. These also receive `EntityProps`. Since `ReviewButton` has no access to the pane's source state, it passes `source: { kind: "working" }` as a default. This matches today's behavior — toolbar badges always show working-tree aggregate info.

## Steps

### 1. Create `plugins/review/web/source.ts`

Extract from `code-review-section.tsx`:
- `Source` type, `PushGroup` interface
- `groupPushes()`, `formatDate()`
- `SourceTabs` component (+ inner `SourceTab`)

### 2. Widen entity props — `plugins/review/web/slots.ts`

```ts
import type { Source } from "./source";
export interface ReviewProps { conversationId: string; source: Source }
export const Review = defineDetailSections<ReviewProps>("review", { ... });
```

### 3. Own source state in pane — `plugins/review/web/panes.tsx`

`ConvReviewBody`:
- `useState<Source>({ kind: "working" })` for source
- `useResource(pushesResource)` filtered by `conversation.attemptId`, piped through `groupPushes()`
- Render `<SourceTabs>` above `<Review.Host>` (sticky, not inside the scroll area)
- `<Review.Host conversationId={conversation.id} source={source} />`

### 4. Export types — `plugins/review/web/index.ts`

```ts
export type { Source, ReviewProps } from "./source";
```

### 5. Fix ReviewButton — `plugins/review/web/components/review-button.tsx`

Line 25: pass `source: { kind: "working" }` alongside `conversationId`:
```tsx
return S ? <S key={s.id} conversationId={conversation.id} source={{ kind: "working" }} /> : null;
```

### 6. Simplify CodeReviewSection — `plugins/review/plugins/code-review/web/components/code-review-section.tsx`

Remove: `Source` type, `PushGroup`, `groupPushes`, `formatDate`, `SourceTabs`, `SourceTab`, `useState<Source>`, push group fetch, `useConversationById` (no longer needed — worktree comes from pane now... actually `WorkingTreeBody` still needs `worktree` for `useEditedFiles`).

Actually — `WorkingTreeBody` needs `conversationId` (for `useEditedFiles`) and `worktree` (the attempt ID for the diff base). The `worktree` currently comes from `useConversationById(conversationId).attemptId`. We can either:
- Keep `useConversationById` inside `CodeReviewSection` (simplest, no interface change)
- Add `attemptId` to `ReviewProps` (premature — source is the shared concept, attemptId is code-review-specific)

**Decision:** Keep `useConversationById` inside CodeReviewSection. Only the source selector logic is lifted.

Change props to `{ conversationId: string; source: Source }`. The body dispatch stays:
```tsx
source.kind === "working" ? <WorkingTreeBody .../> : <PushBody pushId={source.pushId} />
```

### 7. Widen summary props

`CodeReviewSummary` (`code-review-summary.tsx`): change prop type to `{ conversationId: string; source: Source }`. No logic change — it ignores `source`.

`PluginChangesSummary` (`plugin-changes-summary.tsx`): same. No logic change.

### 8. Gate PluginChangesSection on push mode — `plugin-changes-section.tsx`

Split into wrapper + inner to respect rules-of-hooks:

```tsx
export function PluginChangesSection({ conversationId, source }: ReviewProps) {
  if (source.kind === "push") {
    return <Placeholder>Plugin changes not available for individual pushes.</Placeholder>;
  }
  return <PluginChangesSectionWorking conversationId={conversationId} />;
}

function PluginChangesSectionWorking({ conversationId }: { conversationId: string }) {
  // existing body unchanged
}
```

## Files

| File | Action |
|------|--------|
| `plugins/review/web/source.ts` | **Create** |
| `plugins/review/web/slots.ts` | Edit — widen generic |
| `plugins/review/web/panes.tsx` | Edit — own source state, render SourceTabs |
| `plugins/review/web/index.ts` | Edit — re-export Source, ReviewProps |
| `plugins/review/web/components/review-button.tsx` | Edit — pass default source |
| `plugins/review/plugins/code-review/web/components/code-review-section.tsx` | Edit — remove selector, accept source from props |
| `plugins/review/plugins/code-review/web/components/code-review-summary.tsx` | Edit — widen props |
| `plugins/review/plugins/plugin-changes/web/components/plugin-changes-section.tsx` | Edit — accept source, gate push mode |
| `plugins/review/plugins/plugin-changes/web/components/plugin-changes-summary.tsx` | Edit — widen props |

No server changes needed.

## Verification

1. `./equin build` — clean compile
2. Open review pane for a conversation with pushes — source tabs appear above both sections
3. Switch to a push tab — code-review updates files, plugin-changes shows placeholder
4. Switch back to "Working tree" — both sections resume normal behavior
5. Toolbar review button — summary badges still render (file count, plugin count)
6. `./equin check` — no boundary or lint violations
