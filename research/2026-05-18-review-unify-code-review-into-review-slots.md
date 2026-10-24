# Unify code-review into the Review slot system

## Context

There are currently two independent "Review" toolbar buttons in the conversation action bar:

1. **`plugins/review/`** — extensible review pane with `ReviewSlots.Section` slot. One child: `plugin-changes` (shows plugin API diffs). Toolbar button renders a review icon + section summary badges.
2. **`plugins/conversations/.../code/plugins/review/`** — standalone code-review pane showing file-by-file diffs with source tabs (working tree + push history). Has its own toolbar button with file count, +additions/-deletions, warning level.

These should be unified: code-review becomes a `ReviewSlots.Section` contribution so there's a single "Review" button and pane hosting both sections.

## Plan

### 1. Move plugin to `plugins/review/plugins/code-review/`

Move the entire plugin from its deeply-nested location to live under the review umbrella alongside `plugin-changes`. The new file structure:

```
plugins/review/plugins/code-review/
├── package.json                  (new, @singularity/plugin-review-code-review)
├── shared/
│   ├── index.ts                  (moved verbatim)
│   ├── config.ts                 (moved verbatim)
│   ├── resources.ts              (moved verbatim)
│   └── endpoints.ts              (moved verbatim)
├── server/
│   ├── index.ts                  (moved, plugin id → "review-code-review")
│   └── internal/
│       ├── tables.ts             (moved verbatim)
│       ├── resources.ts          (moved verbatim)
│       ├── rank.ts               (moved verbatim)
│       ├── seed.ts               (moved verbatim)
│       ├── handle-list.ts        (moved verbatim)
│       ├── handle-create.ts      (moved verbatim)
│       ├── handle-update.ts      (moved verbatim)
│       └── handle-delete.ts      (moved verbatim)
└── web/
    ├── index.ts                  (new: ReviewSlots.Section contribution)
    ├── core-files.ts             (moved verbatim)
    ├── use-push-files.ts         (moved verbatim)
    └── components/
        ├── code-review-summary.tsx      (new: summary badge for toolbar button)
        ├── code-review-section.tsx       (adapted from review-view.tsx)
        ├── review-file-row.tsx          (moved, config key updated)
        └── review-sections-settings.tsx (moved verbatim)
```

Delete: `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/` (entire tree).

### 2. Convert to `ReviewSlots.Section` contribution

**New `web/index.ts`** — replaces standalone pane + toolbar button with a section contribution:

```ts
import { ReviewSlots } from "@plugins/review/web";
import { Config } from "@plugins/config/web";
import { reviewConfig } from "../shared/config";

contributions: [
  ReviewSlots.Section({
    id: "code-review",
    label: "Code Review",
    component: CodeReviewSection,
    summary: CodeReviewSummary,
  }),
  Config.Spec(reviewConfig),
  Config.Section({ id: "review-sections", ... }),
]
```

Removed contributions: `Pane.Register`, `Conversation.ActionBar`.

### 3. Create `CodeReviewSummary` component

Extracted from the old `ReviewButton` — renders file count + additions/deletions + warning icon inline in the `ReviewButton`:

```tsx
export function CodeReviewSummary({ conversationId }: { conversationId: string }) {
  // useEditedFiles, useConfigValues, useResource(pushesResource)
  // returns null when count === 0 && !hasPastPushes
  // renders: <span>N +adds −dels [warning]</span>
}
```

The `ReviewButton` in `plugins/review/` already iterates `Review.Section.useContributions()` and renders each section's `summary` — no changes needed there.

### 4. Adapt `ReviewView` → `CodeReviewSection`

Key change: the component currently reads `conversationPane.useData()` to get the conversation. As a section component it receives `{ conversationId: string }` from the `Review.Host` instead.

- Replace `conversationPane.useData()` with `useConversationById(conversationId)` from `@plugins/conversations/web`
- Add null guard (return placeholder while loading)
- Remove the "Review" label from the internal `ToolbarRow` — the collapsible section header already provides "Code Review"
- Rest of the component (source tabs, file list, file sections, expand/collapse) stays the same

### 5. Enable collapsible mode on `Review.Host`

**`plugins/review/web/slots.ts`:**

```ts
export const Review = defineDetailSections<{ conversationId: string }>("review", {
  collapsible: true,
  defaultOpen: true,
});
```

Both sections get a labeled collapsible header so users can collapse one to focus on the other.

### 6. Set review pane width to 720

**`plugins/review/web/panes.tsx`:**

```ts
export const convReviewPane = Pane.define({
  id: "conv-review",
  after: [conversationPane],
  segment: "review",
  component: ConvReviewBody,
  width: 720,
});
```

### 7. Config key migration

The old plugin ID was `"conversation-code-review"`, the new one is `"review-code-review"`. Config values (`safePaths`, `carefulPaths`) are keyed by plugin ID. Update `useConfigValues(reviewConfig, "review-code-review")` in the summary and file-row components. Existing stored values under the old key will fall back to defaults (safe — these are just path prefix lists with sensible defaults seeded on first boot).

### 8. Plugin registry

Auto-handled by `./equin build` — it discovers plugin barrels by convention. No manual registry edits needed.

### 9. DB migration

The `review_sections` table name, columns, and all API routes (`/api/review-sections/*`) are unchanged. No new migration needed. The table definition just moves to a different plugin directory; drizzle sees the same schema.

## Critical files

| File | Action |
|---|---|
| `plugins/review/web/slots.ts` | Enable collapsible mode |
| `plugins/review/web/panes.tsx` | Add width: 720 |
| `plugins/review/plugins/code-review/web/index.ts` | New: section contribution |
| `plugins/review/plugins/code-review/web/components/code-review-section.tsx` | Adapted from old review-view.tsx |
| `plugins/review/plugins/code-review/web/components/code-review-summary.tsx` | New: toolbar badge |
| `plugins/conversations/.../code/plugins/review/` | Delete entire tree |
| `plugins/conversations/.../code/CLAUDE.md` | Remove review from sub-plugins |

## Verification

1. `./equin build` — no TypeScript errors, no new migration generated
2. Single "Review" toolbar button in conversation view (no separate "Code Review" button)
3. Review pane at 720px with two collapsible sections: "Plugin Changes" and "Code Review", both open by default
4. Code Review section: source tabs work, file list grouped by sections, diffs expand inline, warning levels color rows
5. Plugin Changes section: renders unchanged
6. `ReviewButton` shows: icon + code-review summary (file count, +add/-del) + plugin-changes summary badge
7. Settings: "Review Sections" panel accessible, CRUD works
