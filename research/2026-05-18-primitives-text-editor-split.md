# Split prompt-editor into text-editor + prompt-editor

## Context

The current `prompt-editor` primitive is a Lexical-based rich text editor with two extension slots:

- **`Plugin`** — invisible Lexical plugins (sole contributor: `paste-images` for image paste/drop)
- **`FloatingAction`** — visible toolbar at the bottom (sole contributor: `prompt-templates` for conversation template chips)

The problem: `FloatingAction` and `prompt-templates` are conversation-specific, but the slot is global. When the editor mounts in non-conversation contexts (task draft, agent detail, screenshot form — 8 of 9 consumers), `prompt-templates` crashes on `conversationPane.useData()`. Commit `5d193e48` applied a band-aid (`useDataMaybe()`), but the real fix is to scope the toolbar to conversation contexts only.

**Goal:** Split into two primitives:
- `text-editor` — generic Lexical editor (all core + `Plugin` slot + `paste-images`)
- `prompt-editor` — conversation-scoped wrapper (wraps `TextEditor`, adds `FloatingAction` slot + toolbar)

## Design Decisions

### Composition via `bottomSlot` prop

`TextEditor` accepts `bottomSlot?: ReactNode` rendered inside the border container, below the text area, inside the `LexicalComposer` boundary. This lets the `PromptEditor` wrapper inject a `ToolbarRow` that can call `useLexicalComposerContext()`.

Why `bottomSlot` over `children`: the injection point is structurally specific (below text, inside border, inside Lexical context). A named prop makes intent explicit and avoids ambiguity with React children.

### prompt-editor keeps its path

`prompt-editor` stays at `plugins/primitives/plugins/prompt-editor/`. Only its internals change (thin wrapper instead of full Lexical stack). The one consumer that needs the toolbar (`prompt-input.tsx`) keeps its existing import path unchanged.

### Slot ID rename

`"prompt-editor.plugin"` → `"text-editor.plugin"`. Only `paste-images` contributes to it; updated in the same change. `"prompt-editor.floating-action"` stays as-is (still owned by `prompt-editor`).

## Implementation

### Step 1: Create `plugins/primitives/plugins/text-editor/`

New plugin. Receives all Lexical core from current `prompt-editor`.

**Create files (moved from prompt-editor with modifications):**

| New path | Source | Changes |
|----------|--------|---------|
| `text-editor/package.json` | new | `@singularity/plugin-primitives-text-editor`, deps: `lexical`, `@lexical/react` |
| `text-editor/web/slots.ts` | `prompt-editor/web/slots.ts` | Only `Plugin` slot, renamed to `TextEditorSlots.Plugin` with ID `"text-editor.plugin"`. Export `TextEditorPluginProps`. Drop `FloatingAction` and `PromptEditorActionProps`. |
| `text-editor/web/components/text-editor.tsx` | `prompt-editor/web/components/prompt-editor.tsx` | Rename component to `TextEditor`. Add `bottomSlot?: ReactNode` prop. In `EditorShell`: replace `<ToolbarRow />` with `{bottomSlot}`. Remove `ToolbarRow` function entirely. `PluginSlot` reads `TextEditorSlots.Plugin`. |
| `text-editor/web/internal/enter-key-plugin.tsx` | verbatim copy | |
| `text-editor/web/internal/lexical-config.ts` | verbatim copy | |
| `text-editor/web/internal/markdown.ts` | verbatim copy | |
| `text-editor/web/internal/node-extensions.ts` | verbatim copy | |
| `text-editor/web/index.ts` | new | Export `TextEditor`, `TextEditorSlots`, `TextEditorPluginProps`, `registerNodeExtension`, `NodeExtension`. Default export plugin definition `id: "text-editor"`. |
| `text-editor/CLAUDE.md` | new | |

Key change in `text-editor.tsx` — `EditorShell` signature:
```tsx
function EditorShell({ bottomSlot, ...rest }: {
  bottomSlot?: React.ReactNode;
  // ... existing props
}) {
  return (
    <div className="...border...">
      <div className="relative">
        <PlainTextPlugin ... />
      </div>
      {bottomSlot}
    </div>
  );
}
```

And `TextEditor` threads it:
```tsx
export function TextEditor({ bottomSlot, ...props }: TextEditorProps) {
  return (
    <LexicalComposer ...>
      <EditorShell bottomSlot={bottomSlot} ... />
      <ValueSyncPlugin ... />
      <PluginSlot ... />
      ...
    </LexicalComposer>
  );
}
```

### Step 2: Move `paste-images` sub-plugin

Move entire `prompt-editor/plugins/paste-images/` → `text-editor/plugins/paste-images/`.

**Changes in moved files:**

| File | Change |
|------|--------|
| `paste-images/package.json` | Name: `@singularity/plugin-primitives-text-editor-paste-images` |
| `paste-images/web/index.ts` | Import `TextEditorSlots` from `@plugins/primitives/plugins/text-editor/web`. Contribute to `TextEditorSlots.Plugin`. |
| `paste-images/web/internal/register.ts` | Import `registerNodeExtension` from `@plugins/primitives/plugins/text-editor/web` |
| All other files | No changes (only local/relative imports) |

### Step 3: Rewrite `prompt-editor` as thin wrapper

**Delete** all files under `prompt-editor/web/internal/` (now owned by `text-editor`).
**Delete** `prompt-editor/plugins/` directory (paste-images moved).
**Delete** `prompt-editor/core/` (empty; no server-side concerns).

**Modify:**

`prompt-editor/web/slots.ts` — keep only `FloatingAction`:
```ts
export interface PromptEditorActionProps {
  insertText: (text: string) => void;
}

export const PromptEditorSlots = {
  FloatingAction: defineRenderSlot<{
    component: ComponentType<PromptEditorActionProps>;
  }>("prompt-editor.floating-action"),
};
```

`prompt-editor/web/components/prompt-editor.tsx` — full rewrite:
```tsx
import { TextEditor } from "@plugins/primitives/plugins/text-editor/web";
import { PromptEditorSlots } from "../slots";
// + Lexical imports for ToolbarRow

export function PromptEditor(props: { /* same interface as TextEditor */ }) {
  return <TextEditor {...props} bottomSlot={<ToolbarRow />} />;
}

// ToolbarRow — moved verbatim from current prompt-editor.tsx (lines 178-221)
// Uses useLexicalComposerContext() — works because it's inside TextEditor's LexicalComposer
function ToolbarRow() { ... }
```

`prompt-editor/web/index.ts` — export only wrapper concerns:
```ts
export { PromptEditor } from "./components/prompt-editor";
export { PromptEditorSlots, type PromptEditorActionProps } from "./slots";
// No more: registerNodeExtension, NodeExtension, PromptEditorPluginProps
```

`prompt-editor/package.json` — remove `lexical` / `@lexical/react` deps.

### Step 4: Update 8 non-conversation consumers

Change import from `@plugins/primitives/plugins/prompt-editor/web` → `@plugins/primitives/plugins/text-editor/web`. Rename `<PromptEditor>` → `<TextEditor>`.

| File | Notes |
|------|-------|
| `plugins/tasks/plugins/task-draft-form/web/components/task-draft-card.tsx` | |
| `plugins/active-data/plugins/task/web/components/task-card.tsx` | |
| `plugins/screenshot/web/components/prompt-form.tsx` | |
| `plugins/tasks/plugins/task-description/web/components/description-view.tsx` | Also update paste-images import |
| `plugins/agents/web/components/agent-detail.tsx` | |
| `plugins/conversations/.../branch/web/components/branch-buttons.tsx` | |
| `plugins/conversations/.../launch-prompts/web/components/launch-prompts-settings.tsx` | |
| `plugins/conversations/.../prompt-templates/web/components/prompt-templates-settings.tsx` | |

`prompt-input.tsx` stays unchanged — it imports from `prompt-editor/web` which now wraps `TextEditor`.

### Step 5: Update paste-images import paths (12 files)

All change from `@plugins/primitives/plugins/prompt-editor/plugins/paste-images/{web,core}` → `@plugins/primitives/plugins/text-editor/plugins/paste-images/{web,core}`.

**Web barrel consumers:**
- `plugins/screenshot/plugins/draw-on-app/web/components/draw-on-app-button.tsx`
- `plugins/tasks/plugins/task-description/web/components/description-view.tsx`
- `plugins/tasks/plugins/task-draft-form/web/internal/submit.ts`
- `plugins/conversations/plugins/conversation-view/web/prompt-draft-utils.ts`

**Core barrel consumers:**
- `plugins/tasks/server/internal/handle-update.ts`
- `plugins/tasks/server/internal/handle-create-chain.ts`
- `plugins/agents/server/internal/handle-update.ts`
- `plugins/conversations/.../launch-prompts/server/internal/handle-create.ts`
- `plugins/conversations/.../launch-prompts/server/internal/handle-update.ts`
- `plugins/conversations/.../prompt-templates/server/internal/handle-create.ts`
- `plugins/conversations/.../prompt-templates/server/internal/handle-update.ts`
- `plugins/conversations/server/internal/resolve-prompt-attachments.ts`

### Step 6: Revert `useDataMaybe()` band-aid

In `prompt-template-chips.tsx`, revert the guard from commit `5d193e48`:

```diff
- const conversationData = conversationPane.useDataMaybe();
- const live = useConversationById(conversationData?.conversation.id ?? null) ?? conversationData?.conversation;
+ const { conversation } = conversationPane.useData();
+ const live = useConversationById(conversation.id) ?? conversation;

- const conversation = conversationData?.conversation;
- const canSend = live?.status === "waiting" && sendingId === null;
+ const canSend = live.status === "waiting" && sendingId === null;

- if (!canSend || !conversation) return;
+ if (!canSend) return;
```

Also revert the import: `useConversationById` → `useConversation` (the non-nullable variant).

### Step 7: Update CLAUDE.md files

- `text-editor/CLAUDE.md` — new, describes generic editor + paste-images sub-plugin
- `prompt-editor/CLAUDE.md` — update to describe conversation-scoped wrapper role
- `primitives/CLAUDE.md` — add `text-editor` entry, update `prompt-editor` description

### Step 8: Build and verify

Run `./equin build` — regenerates `plugins.generated.ts` with new `text-editor` entries.

## Verification

1. `./equin build` succeeds
2. `./equin check` passes (plugin boundaries, eslint)
3. **Conversation prompt**: open a conversation — template chips appear in the toolbar, insert and send-directly work
4. **Task draft form**: open improve/new-task — editor renders without toolbar, image paste works
5. **Other consumers** (agent detail, screenshot form, task description, branch, launch-prompts settings, prompt-templates settings): editor renders without toolbar
6. No console errors about `conversationPane.useData()` outside conversation context

## File count

- ~6 new files (text-editor plugin skeleton)
- ~12 files moved (paste-images sub-plugin)
- ~3 files rewritten (prompt-editor wrapper)
- ~3 files deleted (prompt-editor internals, core)
- ~20 files with import path updates
- ~1 file reverted (prompt-template-chips.tsx)
- ~3 CLAUDE.md updates
