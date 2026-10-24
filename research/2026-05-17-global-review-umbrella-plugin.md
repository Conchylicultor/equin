# Implementation Plan: `plugins/review/` Global Review Umbrella Plugin

Date: 2026-05-17

## 1. Context

The review plugin adds a toolbar button to every conversation view that opens a side pane
exposing agent modifications at a higher level of abstraction than the raw JSONL log. The
pane is intentionally empty at first — it is an **umbrella plugin** whose only job is to
own the pane definition, the toolbar button, and the `ReviewSlots` extensibility surface
that future child plugins contribute into.

Planned future section contributors (not in scope here):
- Files changed (code diffs from the worktree)
- Tasks created / modified
- Config changes
- Anything else a plugin wants to surface per-conversation

The new plugin lives at `plugins/review/` — a top-level sibling of `plugins/build/`,
`plugins/tasks/`, etc.

**Naming conflict**: The existing plugin at
`plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/` already
claims pane id `"conv-review"` and URL segment `"review"`. Before creating the new plugin,
the existing plugin must be migrated to `"conv-code-review"` / `"code-review"`, freeing
those names for the umbrella.

## 2. Plugin Structure

```
plugins/review/
├── CLAUDE.md
├── package.json
└── web/
    ├── index.ts                    ← PluginDefinition + public exports (ReviewSlots)
    ├── panes.tsx                   ← Pane.define for convReviewPane
    ├── slots.ts                    ← defineDetailSections → ReviewSlots
    └── components/
        └── review-button.tsx       ← Toolbar button
```

No `server/` or `shared/` directories — this plugin is web-only.

## 3. Implementation Steps

### Step 0 — Rename existing code-review pane (free up the "review" name)

**File:** `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/panes.tsx`

Change:
- `id: "conv-review"` → `id: "conv-code-review"`
- `segment: "review"` → `segment: "code-review"`
- Rename exported constant: `convReviewPane` → `convCodeReviewPane`

**File:** `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/components/review-button.tsx`

- Update `title="Review"` / `aria-label="Review"` → `"Code Review"`
- Update import of `convReviewPane` → `convCodeReviewPane`
- Update `useToggle` call to use `convCodeReviewPane`

**File:** `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/index.ts`

- Update import of `convReviewPane` → `convCodeReviewPane`
- Update barrel re-export: `export { convCodeReviewPane } from "./panes"` (if previously exported)
- Update any `convReviewPane.Actions(...)` references

**File:** `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/components/review-view.tsx` (and any other component that imports `convReviewPane` from `../panes`)

- Update all imports and usages from `convReviewPane` → `convCodeReviewPane`

> After this step, grep for `conv-review` and `convReviewPane` inside the
> `code/plugins/review/` subtree to confirm all references are updated.

### Step 1 — `plugins/review/package.json`

```json
{
  "name": "@singularity/plugin-review",
  "private": true,
  "version": "0.0.1"
}
```

### Step 2 — `plugins/review/web/slots.ts`

```ts
import { defineDetailSections } from "@plugins/primitives/plugins/detail-sections/web";

export const Review = defineDetailSections<{ conversationId: string }>("review");
```

`defineDetailSections` returns `{ Section, Host }`. The entity prop type is
`{ conversationId: string }` — this is what child plugins receive when their section
component renders.

### Step 3 — `plugins/review/web/panes.tsx`

```tsx
import { Pane, PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { Review } from "./slots";

export const convReviewPane = Pane.define({
  id: "conv-review",
  after: [conversationPane],
  segment: "review",
  component: ConvReviewBody,
});

function ConvReviewBody() {
  const { conversation } = conversationPane.useData();
  return (
    <PaneChrome pane={convReviewPane} title="Review">
      <div className="h-full overflow-auto">
        <Review.Host conversationId={conversation.id} />
      </div>
    </PaneChrome>
  );
}
```

Notes:
- `after: [conversationPane]` anchors the pane to the right of the main conversation pane,
  exactly as `terminal-pane` and `tasks-panel` do.
- `Review.Host` renders all contributed sections; with none contributed yet it renders an
  empty container.

### Step 4 — `plugins/review/web/components/review-button.tsx`

```tsx
import { MdRateReview } from "react-icons/md";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { Button } from "@/components/ui/button";
import { convReviewPane } from "../panes";

export function ReviewButton() {
  const { conversation } = conversationPane.useData();
  const { isOpen, toggle } = convReviewPane.useToggle({ convId: conversation.id });

  return (
    <Button
      variant={isOpen ? "secondary" : "ghost"}
      size="sm"
      title="Review"
      aria-label="Review"
      aria-pressed={isOpen}
      onClick={toggle}
      className="gap-1.5"
    >
      <MdRateReview className="size-4" />
    </Button>
  );
}
```

Icon: `MdRateReview` from `react-icons/md`. All existing toolbar buttons use `react-icons/md`.

### Step 5 — `plugins/review/web/index.ts`

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/plugins/action-bar/web";
import { ReviewButton } from "./components/review-button";
import { convReviewPane } from "./panes";

export { Review as ReviewSlots } from "./slots";
export { convReviewPane } from "./panes";

export default {
  id: "review",
  name: "Review",
  description:
    "Toolbar button that opens a side pane exposing agent modifications (files changed, tasks, config) in a structured, extensible view.",
  contributions: [
    Pane.Register({ pane: convReviewPane }),
    Conversation.ActionBar({ id: "review", component: ReviewButton }),
  ],
} satisfies PluginDefinition;
```

Key decisions:
- The slot object is exported as `ReviewSlots` from the barrel — consistent with
  `TaskDetailSlots` and `PluginViewSlots`.
- `convReviewPane` is also re-exported so future child plugins can call
  `convReviewPane.Actions(...)` if needed.

### Step 6 — `plugins/review/CLAUDE.md`

```markdown
# review

Toolbar button that opens a side pane exposing agent modifications at a higher level.
The pane is extensible via `ReviewSlots.Section` contributions from child plugins.

## Public API (web)

- `ReviewSlots` — `DetailSections<{ conversationId: string }>` — contribute sections via
  `ReviewSlots.Section({ id, label, component })`. Section components receive
  `{ conversationId: string }`.
- `convReviewPane` — the pane object; use `.Actions(...)` to add pane-level action buttons.

## Adding a child plugin section

```ts
import { ReviewSlots } from "@plugins/review/web";
contributions: [
  ReviewSlots.Section({ id: "files-changed", label: "Files Changed", component: FilesChangedSection }),
]
// FilesChangedSection receives { conversationId: string }
```
```

## 4. Plugin Registration

`web/src/plugins.generated.ts` is **autogenerated**. Run `./equin build` after
creating the files. The build tool scans `plugins/*/web/index.ts` and regenerates the file
automatically. No manual edit required.

## 5. How a Future Child Plugin Contributes a Section

```ts
// plugins/review/plugins/<name>/web/index.ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ReviewSlots } from "@plugins/review/web";
import { MySection } from "./components/my-section";

export default {
  id: "review-<name>",
  name: "Review: <Name>",
  description: "...",
  contributions: [
    ReviewSlots.Section({ id: "<name>", label: "<Label>", component: MySection }),
  ],
} satisfies PluginDefinition;
// MySection receives { conversationId: string }
```

## 6. Verification

```bash
# 1. Build + deploy
./equin build

# 2. Smoke-test in browser
# - Open any conversation
# - Toolbar shows a new "Review" button (MdRateReview icon)
# - Old code-review button now shows "Code Review"
# - Click Review → pane opens to the right, shows "Review" header, empty body
# - Click again → pane closes; button variant toggles ghost ↔ secondary
# - Switch conversations → pane state is per-conversation

# 3. Type check (from web/ directory)
bun run tsc --noEmit
```
