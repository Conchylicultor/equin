# Text Block Type — Implementation Plan

## Context

The page plugin's editor infrastructure (schema, server, component, slots) is built and working (Tasks 1+2 from the vision doc). The `Editor.Block` slot has zero contributors — no block types exist yet. This plan delivers the first: a plain-text block powered by Lexical, with keyboard-driven structural operations (split, merge, indent, outdent, focus navigation). This is the foundational block type that validates the entire editor architecture end-to-end.

## Approach

### Plugin location

`plugins/page/plugins/text/` — follows the standard `plugins/` convention used by the existing `editor` sub-plugin. The vision doc's `blocks/` directory was not followed when Tasks 1+2 were implemented; this stays consistent.

### Architecture

Each text block is an independent `LexicalComposer` with `PlainTextPlugin`. Two internal Lexical plugins handle persistence and keyboard:

```
TextBlock component
└─ LexicalComposer (per block)
   ├─ PlainTextPlugin + ContentEditable
   ├─ HistoryPlugin (per-block undo/redo)
   ├─ ValueSyncPlugin (two-way text↔Lexical sync via useEditableField)
   └─ KeyboardPlugin (Enter/Backspace/Tab/Arrows → BlockEditorAPI)
```

Data flow for persistence:
```
Server block.data.text → useEditableField.value → ValueSyncPlugin inbound → Lexical state
Lexical state → ValueSyncPlugin outbound → useEditableField.onChange → (debounce 500ms) → onSave → editor.update({ text }) → PATCH /api/blocks/:id
```

## Changes

### 1. Patch editor context — add `merge()` and pending-focus

**`plugins/page/plugins/editor/web/types.ts`** — Add `merge(): void` to `BlockEditorAPI` interface.

**`plugins/page/plugins/editor/web/block-editor-context.tsx`** — Four changes:

1. Import `mergeBlocks` from `../core` (already exported from core barrel).
2. Add `pendingFocusRef = useRef<string | null>(null)` in provider.
3. `split()` in `makeBlockAPI` — await the response, set `pendingFocusRef.current = result.created.id`, attempt immediate focus if handle already registered.
4. `merge()` in `makeBlockAPI` — await response (returns merged block = previous sibling), focus that block. Catch errors silently (merge on first block returns 400 — correct UX is no-op).
5. `registerFocusHandle` — on registration, check `pendingFocusRef` and auto-focus if matched.

### 2. Create text block plugin

**`plugins/page/plugins/text/package.json`** — Workspace package depending on `lexical@^0.44.0`, `@lexical/react@^0.44.0`.

**`plugins/page/plugins/text/core/index.ts`** — Block handle:
```ts
export const textBlock = defineBlock({
  type: "text",
  schema: z.object({ text: z.string() }),
});
```

**`plugins/page/plugins/text/web/components/value-sync-plugin.tsx`** — Lexical plugin (renders null):
- Inbound: when `value` prop changes and differs from `lastSerializedRef`, split by `\n`, rebuild ParagraphNode + TextNode per line. Set `selfWriteRef = true` with `queueMicrotask` reset.
- Outbound: `registerUpdateListener` → `$getRoot().getTextContent()` (Lexical joins paragraphs with `\n`) → compare to last → call `onChange`.

**`plugins/page/plugins/text/web/components/keyboard-plugin.tsx`** — Lexical plugin registering commands at `COMMAND_PRIORITY_HIGH`:

| Key | Detection | Action |
|---|---|---|
| Enter | Compute absolute cursor offset across paragraphs | `editor.split(offset)` |
| Backspace | Selection collapsed, anchor at offset 0 in first paragraph | `editor.merge()` |
| Tab | Always | `editor.indent()` (or `outdent()` if shiftKey) |
| ArrowUp | Collapsed at start of first paragraph | `editor.focusUp()` |
| ArrowDown | Collapsed at end of last paragraph | `editor.focusDown()` |

Cursor offset computation: walk `$getRoot()` children, accumulate `paragraph.getTextContent().length + 1` (for `\n` separator) for paragraphs before the anchor's, then add `selection.anchor.offset`.

**`plugins/page/plugins/text/web/components/text-block.tsx`** — Main component:
- Implements `BlockRendererProps`.
- `textBlock.parse(block.data)` for typed access to `{ text: string }`.
- `useEditableField({ value: data.text, onSave: (next) => editor.update({ text: next }) })` for debounced persistence.
- `useBlockEditor().registerFocusHandle(block.id, ...)` for focus-handle registration; stores Lexical editor ref via a `GetEditorPlugin`.
- `ContentEditable` `onFocus` → `field.onFocus()` + `editor.onFocus()`.
- `ContentEditable` `onBlur` → `field.onBlur()`.
- Renders `{children}` (nested blocks) below the `LexicalComposer`.

**`plugins/page/plugins/text/web/index.ts`** — Plugin barrel:
```ts
export default {
  id: "page-text",
  contributions: [
    Editor.Block({ block: textBlock, component: TextBlock }),
  ],
} satisfies PluginDefinition;
```

**`plugins/page/plugins/text/CLAUDE.md`** — Plugin documentation.

### Files summary

| Action | File |
|---|---|
| Modify | `plugins/page/plugins/editor/web/types.ts` |
| Modify | `plugins/page/plugins/editor/web/block-editor-context.tsx` |
| Create | `plugins/page/plugins/text/package.json` |
| Create | `plugins/page/plugins/text/core/index.ts` |
| Create | `plugins/page/plugins/text/web/components/value-sync-plugin.tsx` |
| Create | `plugins/page/plugins/text/web/components/keyboard-plugin.tsx` |
| Create | `plugins/page/plugins/text/web/components/text-block.tsx` |
| Create | `plugins/page/plugins/text/web/index.ts` |
| Create | `plugins/page/plugins/text/CLAUDE.md` |

### Reused infrastructure

- `defineBlock` from `@plugins/page/plugins/editor/core`
- `Editor.Block` slot from `@plugins/page/plugins/editor/web`
- `useBlockEditor` from `@plugins/page/plugins/editor/web`
- `useEditableField` from `@plugins/primitives/plugins/editable-field/web`
- `fetchEndpoint` from `@plugins/infra/plugins/endpoints/web`
- `LexicalComposer`, `PlainTextPlugin`, `ContentEditable`, `LexicalErrorBoundary`, `HistoryPlugin` from `@lexical/react`
- `useLexicalComposerContext` from `@lexical/react/LexicalComposerContext`
- Lexical commands: `KEY_ENTER_COMMAND`, `KEY_BACKSPACE_COMMAND`, `KEY_TAB_COMMAND`, `KEY_ARROW_UP_COMMAND`, `KEY_ARROW_DOWN_COMMAND`, `COMMAND_PRIORITY_HIGH`

## Scope boundaries

- **In scope**: Plain text editing, split/merge, indent/outdent, arrow-key focus navigation, debounced persistence.
- **Out of scope**: Rich text, cursor-at-join-point after merge (focus only — no position restore), cross-block undo, empty-document auto-create-block, drag-and-drop reorder.

## Verification

1. `./equin build` succeeds and `web.generated.ts` includes `page/plugins/text`.
2. Open a document in the app — text blocks render with editable Lexical editors.
3. Type in a block → after 500ms debounce, `PATCH /api/blocks/:id` fires with `{ data: { text: "..." } }`.
4. Press Enter mid-text → block splits into two, cursor focuses the new block.
5. Backspace at position 0 → blocks merge, focus moves to previous block.
6. Tab / Shift+Tab → block indents/outdents (nesting changes in tree).
7. ArrowUp at first line / ArrowDown at last line → focus navigates between blocks.
