# Generic remove (×) affordance for active-data inline chips in the editor

## Context

Commit `bc2b705af` unified inline-tag rendering: the bespoke element-picker
`UiContextNode` (which carried its own `onRemove` × via `UiContextChip`) was
deleted and replaced by the generic `active-data` editor bridge — a single
`ActiveDataInlineNode` Lexical decorator that renders **any** `display:"inline"`
contribution as a chip inside the Lexical editor.

The side effect: inline chips in the compose editor lost their explicit "×"
remove button. Removal now relies on native Lexical backspace deletion of the
atomic decorator — far less discoverable than the previous per-chip × button.

**Goal:** restore an explicit removal affordance, provided **generically** by the
editor bridge so every inline contribution (`<ui-context>`, `conv-…`, `att-…`,
`task-…`, plugin-link, …) gets it with zero per-contributor wiring. The
affordance must appear **only** in the editable editor context — read surfaces
(sent messages, assistant text) render the same chip non-editably and must NOT
show a ×.

## Why this lands in the right place

Read surfaces (`assistant-text`, `user-text`) render contribution components
**directly** via `useActiveDataLinkify` / `useActiveDataSegments` — they never go
through `ActiveDataInlineNode`/`ActiveDataInlineChip`. Only the Lexical editor
path renders the chip via the decorator's `decorate()`. So wrapping the removal
chrome inside `ActiveDataInlineChip` automatically scopes it to the editor and
leaves read surfaces untouched. Within the editor we additionally gate on
`editor.isEditable()` so a read-only/disabled editor shows no ×.

This mirrors the existing, only precedent in the codebase: `paste-images`
`ImageNode` → `AttachmentThumbnail` (hover-reveal corner × on an inline
decorator). We copy that pattern byte-for-byte.

## Approach

All changes are in **`plugins/active-data/web/internal/active-data-inline-node.tsx`**,
plus dead-code cleanup in element-picker.

### 1. Thread the node key into the chip and wrap with removal chrome

`active-data-inline-node.tsx`:

- `decorate()` → pass `this.__key`:
  ```tsx
  decorate(): ReactNode {
    return <ActiveDataInlineChip text={this.__text} nodeKey={this.__key} />;
  }
  ```
- `ActiveDataInlineChip` gains `nodeKey: NodeKey`, reads the editor via
  `useLexicalComposerContext()` (safe — the chip is only ever rendered from
  `decorate()`, i.e. inside a `LexicalComposer`), and wraps the resolved
  contribution component in generic hover-× chrome **only when editable**:

  ```tsx
  import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
  import { MdClose } from "react-icons/md";

  function ActiveDataInlineChip({ text, nodeKey }: { text: string; nodeKey: NodeKey }) {
    const [editor] = useLexicalComposerContext();
    const contributions = ActiveData.Tag.useContributions();
    const inline = contributions.filter(
      (c): c is SealContributions<ActiveDataInlineContribution> => c.display === "inline",
    );
    const match = inline.find((c) =>
      new RegExp(`^(?:${c.pattern.source})$`, stripGlobal(c.pattern.flags)).test(text),
    );
    if (!match) return <>{text}</>;
    const Component = UNSAFE_unsealSlotComponent(match.component);
    const chip = <Component content={text} attrs={{}} />;

    if (!editor.isEditable()) return chip;

    return (
      <span className="group relative inline-flex align-middle" contentEditable={false}>
        {chip}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            editor.update(() => {
              const node = editor.getEditorState()._nodeMap.get(nodeKey);
              if (node) (node as LexicalNode).remove();
            });
          }}
          className="bg-background/90 border-border text-foreground absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full border opacity-0 transition-opacity group-hover:opacity-100"
          aria-label="Remove"
        >
          <MdClose className="size-3" />
        </button>
      </span>
    );
  }
  ```

Notes:
- The remove handler uses the codebase-canonical Lexical mutation pattern
  (`editor.update` + `_nodeMap.get(nodeKey).remove()`), identical to
  `image-node.tsx:94-98`. Resolving the node at click time (not capturing it)
  keeps the key fresh across clones.
- `editor.isEditable()` snapshot mirrors the `ImageNode` precedent. `decorate()`
  re-runs on editor state changes, so a snapshot is sufficient (no
  `registerEditableListener` needed — the compose editor's editability is
  stable).
- `e.stopPropagation()` prevents the × click from triggering the chip's own
  click behavior (e.g. `UiContextChip` opening its popover).
- Styling is copied verbatim from `AttachmentThumbnail` (`size-4` button, `size-3`
  icon, `rounded-full`, hover-reveal via `group`/`group-hover:opacity-100`). No
  new radius/spacing tokens — `rounded-full` is an allowed fixed shape and is the
  established chip-× shape.

### 2. Remove now-dead `onRemove` plumbing in element-picker

With removal handled generically by the bridge, `UiContextChip`'s own `onRemove`
prop + popover-header × button are dead (nothing wires them). Delete them to
avoid a misleading second removal path:

- `plugins/improve/plugins/element-picker/web/components/ui-context-chip.tsx` —
  drop the `onRemove?: () => void` prop and the `{onRemove && (<button…>)}`
  block (lines ~62-74) and the now-unused `MdClose` import.

`UiContextTag` already calls `<UiContextChip meta={meta} />` with no `onRemove`,
so no change there.

## Files

- **Modify** `plugins/active-data/web/internal/active-data-inline-node.tsx` —
  thread `nodeKey`, add generic editable-only hover-× chrome.
- **Modify** `plugins/improve/plugins/element-picker/web/components/ui-context-chip.tsx`
  — remove dead `onRemove` prop + popover × + `MdClose` import.

## Reuse

- Pattern + × styling: `plugins/primitives/plugins/text-editor/plugins/paste-images/web/internal/image-node.tsx`
  and `…/components/attachment-thumbnail.tsx`.
- Lexical removal idiom: `editor.update(() => _nodeMap.get(key)?.remove())` (same
  as image-node).

## Verification

1. `./equin build`.
2. **Editor shows ×:** open `http://att-1781341482-9ud5.localhost:9000`, use the
   element-picker ("Pick UI element") to insert a `<ui-context>` chip into the
   Improve/compose editor. Hover the chip → a corner × appears → clicking it
   removes the chip (and its underlying token, verified by submitting / inspecting
   the markdown). Repeat with a `conv-…` / `task-…` token typed into the editor to
   confirm the affordance is generic across all inline contributions.
3. **Read surfaces have no ×:** confirm the sent user message and any assistant
   text containing the same chip render it with **no** × on hover.
4. Scripted check via `e2e/screenshot.mjs` (or a jsdom test under
   `plugins/active-data/web/__tests__/`): render the bridge node inside an
   editable vs non-editable `LexicalComposer` and assert the
   `aria-label="Remove"` button is present only in the editable case. Extend the
   existing `editor-bridge.test.tsx`.
