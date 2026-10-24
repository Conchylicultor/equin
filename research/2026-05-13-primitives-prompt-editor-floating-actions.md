# Prompt Editor Floating Actions

## Context

Prompt template chips currently render *above* the `PromptEditor` via the `Conversation.AbovePromptInput` slot — a conversation-specific slot that only works in the conversation view. This means template chips don't appear in other `PromptEditor` instances (task-draft-form/improve, agent detail, etc.).

The goal is to move template chips *inside* the `PromptEditor` as a floating element in the bottom-right corner. A collapsed PenLine icon expands on hover to reveal all template chips. Since this lives inside the `PromptEditor` primitive, it appears everywhere automatically.

## Design

### 1. New slot on PromptEditor

`PromptEditor` gains a `defineSlot`-based extensibility point — following the same pattern as `Markdown.Enhancer` in `plugins/primitives/plugins/markdown/`.

PromptEditor renders contributions as an absolutely-positioned overlay in the bottom-right. It has **no opinion on UX** — each contribution owns its own visual treatment (collapse/expand, icon, chips, etc.). PromptEditor just provides the anchor.

### 2. prompt-templates owns the floating chip UX

The `prompt-templates` plugin contributes a self-contained component: a collapsed PenLine icon that expands on hover to show individual template chips. The component inserts text directly into the Lexical editor via `useLexicalComposerContext()` — no need for the `PromptInsertProvider` bridge since it renders inside `LexicalComposer`.

### 3. Clean removal from AbovePromptInput

The prompt-templates `Conversation.AbovePromptInput` contribution is removed. The `AbovePromptInput` slot stays (notes, quick-prompts, turn-summary still use it).

## Implementation

### Step 1 — Define the slot

**New file: `plugins/primitives/plugins/paste-images/web/slots.ts`**

```ts
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { ComponentType } from "react";

export const PromptEditorSlots = {
  FloatingAction: defineRenderSlot<{
    component: ComponentType;
  }>("prompt-editor.floating-action"),
};
```

### Step 2 — Export from barrel

**Modify: `plugins/primitives/plugins/paste-images/web/index.ts`**

Add:
```ts
export { PromptEditorSlots } from "./slots";
```

### Step 3 — Render the slot inside PromptEditor

**Modify: `plugins/primitives/plugins/paste-images/web/components/prompt-editor.tsx`**

Inside `EditorShell`, after `<PlainTextPlugin>` but still inside the `<div className="relative ...">` wrapper, render the slot contributions:

```tsx
function EditorShell({ ... }) {
  // ...existing code...
  return (
    <div className="relative w-full min-w-0">
      <PlainTextPlugin ... />
      <FloatingActionAnchor />
    </div>
  );
}
```

`FloatingActionAnchor` is a small internal component:

```tsx
function FloatingActionAnchor() {
  const items = PromptEditorSlots.FloatingAction.useContributions();
  if (items.length === 0) return null;
  return (
    <div className="absolute bottom-1.5 right-1.5 z-10 pointer-events-none">
      <PromptEditorSlots.FloatingAction.Render>
        {(item) => (
          <div className="pointer-events-auto">
            <item.component />
          </div>
        )}
      </PromptEditorSlots.FloatingAction.Render>
    </div>
  );
}
```

The outer div is `pointer-events-none` so clicks pass through to the editor; each contribution wraps in `pointer-events-auto` so it's interactive.

### Step 4 — Rewrite PromptTemplateChips as a floating chip menu

**Modify: `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/components/prompt-template-chips.tsx`**

The component becomes self-contained with its own collapse/expand UX:

- **Collapsed state**: A small PenLine icon button
- **Expanded state** (on hover): A row of chips, each inserting its template text
- Uses `useLexicalComposerContext()` to insert text directly (no `usePromptInsert()`)
- Uses `editor.isEditable()` + `registerEditableListener` to hide when editor is disabled (replaces the old conversation status check)
- `onMouseDown={e => e.preventDefault()}` on all interactive elements to prevent editor blur

Remove imports of `usePromptInsert`, `ConversationRecord`, `useConversation`.

### Step 5 — Update prompt-templates barrel

**Modify: `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/index.ts`**

- Remove `Conversation.AbovePromptInput` contribution
- Add `PromptEditorSlots.FloatingAction({ id: "prompt-templates", component: FloatingTemplateChips })`
- Keep `Config.Section` contribution unchanged

### Step 6 — Remove unused imports in conversation-view

**Check: `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx`**

No changes needed — `AbovePromptInput` is still used by 3 other plugins (notes, quick-prompts, turn-summary).

## Files

| File | Action |
|------|--------|
| `plugins/primitives/plugins/paste-images/web/slots.ts` | **Create** — slot definition |
| `plugins/primitives/plugins/paste-images/web/index.ts` | **Modify** — add export |
| `plugins/primitives/plugins/paste-images/web/components/prompt-editor.tsx` | **Modify** — render FloatingActionAnchor |
| `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/components/prompt-template-chips.tsx` | **Modify** — rewrite as self-contained floating chip menu with Lexical insert |
| `plugins/conversations/plugins/conversation-view/plugins/prompt-templates/web/index.ts` | **Modify** — switch slot contribution |

## Verification

1. `./equin build` — builds cleanly
2. Open conversation view — template chips appear as a floating PenLine icon inside the editor bottom-right, expand on hover, click inserts text
3. Open task-draft-form (Improve button) — same floating chips appear inside that editor too
4. Disabled editor (conversation gone/done) — floating chips hidden
5. No template chips above the editor anymore (AbovePromptInput only shows notes, quick-prompts, turn-summary)
6. Settings page for prompt templates still works
