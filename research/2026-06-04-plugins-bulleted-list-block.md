# Bulleted-list block type for the page editor

## Context

The block-based page editor (`plugins/page/`) currently ships exactly two block
types: a plain-text block (`plugins/page/plugins/text`) and a "Link to page"
block (`plugins/page/plugins/page-link`). All editing affordances — split/merge,
indent/outdent, the slash menu, the gutter `+`, "turn into", and per-block focus
— are already generic and type-agnostic; only the *renderer* differs per type.

We want a **bulleted-list block type**: visually a `•` marker plus editable text,
that nests via the existing indent/outdent machinery. It must support the
**markdown affordance**: typing one of `* `, `- `, or `+ ` at the start of a
block converts it into a bullet (preserving any text typed after the marker).

The plain-text block's Lexical editing scaffolding (composer + value-sync +
keyboard + slash-menu) is exactly what a bullet needs too. Rather than duplicate
it, we extract it into a **reusable `BlockTextEditor` primitive** owned by the
`editor` plugin, so `text` and `bulleted-list` both become thin renderers and
future text-bearing block types (heading, quote, to-do, numbered list) are
trivial. The markdown trigger is made **registry-driven** (each block declares
its own prefixes) so the shared editor never names a specific block type —
respecting the collection-consumer separation rule in `CLAUDE.md`.

## Decisions (confirmed with user)

- **Code sharing:** extract a shared `BlockTextEditor` into the `editor` plugin.
- **Markdown markers:** `* `, `- `, and `+ ` all convert to a bullet.
- **Discoverability:** bullet appears in every block-type menu (slash, gutter
  `+`, Add-block, Turn-into) via a `label` + icon — free through the existing
  `useInsertableBlocks` registry.

## Design

### A. Centralize the editable-text data contract (`editor/core`)

Both text and bullet blocks store `{ text: string }`. Make the `editor` plugin
(the primitive that renders editable text) own this contract.

- **New** `plugins/page/plugins/editor/core/text-data.ts`:
  ```ts
  export const textDataSchema = z.object({ text: z.string() });
  export type TextData = z.infer<typeof textDataSchema>;
  ```
- Export `textDataSchema` / `TextData` from `editor/core/index.ts`.

### B. Registry-driven markdown prefixes (`editor/core/define-block.ts`)

Add an optional field to `BlockHandle` and `defineBlock`:

```ts
/** Leading text that auto-converts a block into this type (e.g. ["* ", "- "]). */
markdownPrefixes?: string[];
```

Thread it through `defineBlock` exactly like `label`/`icon`. No other consumer
changes — purely additive.

### C. Extract the shared `BlockTextEditor` (`editor/web`)

Move these files **from** `plugins/page/plugins/text/web/components/` **into**
`plugins/page/plugins/editor/web/components/` (they are generic, not text-specific):

- `value-sync-plugin.tsx` — unchanged
- `keyboard-plugin.tsx` — unchanged
- `slash-menu-plugin.tsx` — unchanged (already imports only editor-plugin APIs)

**New** `plugins/page/plugins/editor/web/components/markdown-shortcut-plugin.tsx`
(Lexical plugin, mirrors `slash-menu-plugin`'s `registerUpdateListener` pattern):

- Reads `Editor.Block.useContributions()` → flattens `{ prefix, type }` pairs
  from every block handle's `markdownPrefixes`.
- Tracks `prevTextRef`, initialized to the current root text at mount.
- On each update, reads `$getRoot().getTextContent()`. Fires **only on the
  transition** into a prefixed state (prev did not start with the prefix, now
  does) — this prevents auto-converting DB-seeded content like a literal
  `* foo` on mount, and fires the instant the user types the space.
- On a match where `targetType !== block.type`: compute
  `remaining = text.slice(prefix.length)` and call
  `editor.convertTo(targetType, { text: remaining })`.

**New** `plugins/page/plugins/editor/web/components/block-text-editor.tsx` —
the reusable primitive (lifted from the current `text-block.tsx`):

```ts
export function BlockTextEditor({
  block, isFocused, editor,
  marker,        // optional ReactNode rendered left of the text (e.g. a bullet)
  placeholder,   // shown when empty & focused
}: {
  block: Block; isFocused: boolean; editor: BlockEditorAPI;
  marker?: ReactNode; placeholder?: ReactNode;
})
```

- Parses `block.data` with `textDataSchema`; wires `useEditableField` →
  `editor.update({ text })`.
- Renders `LexicalComposer` + `PlainTextPlugin` + `HistoryPlugin` +
  `ValueSyncPlugin` + `KeyboardPlugin` + `SlashMenuPlugin` +
  **`MarkdownShortcutPlugin`** + the existing `EditorRefPlugin` focus-handle glue.
- Layout: when `marker` is set, render a flex row `[marker][flex-1 editable]`;
  the marker is `select-none` and line-height-matched (`leading-6`) so the `•`
  aligns with the first text line. Without a marker, identical to today.
- Export `BlockTextEditor` from `editor/web/index.ts`.

### D. Refocus after `convertTo` (`editor/web/block-editor-context.tsx`)

`convertTo` keeps the same block `id` but remounts a different renderer, so
focus is currently lost on conversion. Set `pendingFocusRef.current = blockId`
inside `convertTo` (same mechanism `insert`/`split` already use) so the
remounted renderer re-grabs focus via `registerFocusHandle`. This fixes
mid-typing focus loss for the markdown shortcut **and** improves the existing
slash-menu / turn-into UX.

### E. Slim down the `text` plugin

- `core/text-block.ts`: `schema: textDataSchema` (import from `editor/core`).
- `web/components/text-block.tsx`: becomes a thin wrapper —
  `<BlockTextEditor block={block} isFocused={isFocused} editor={editor}
   placeholder="Type '/' for commands" />`.
- **Delete** the three moved files (`value-sync`, `keyboard`, `slash-menu`) and
  the inline `EditorRefPlugin` (now in editor).
- `package.json`: lexical deps move to the editor plugin (text no longer imports
  lexical directly).
- Update `CLAUDE.md` prose (the autogen block is regenerated by build).

### F. New `bulleted-list` sub-plugin

Mirror the `text` sub-plugin's file set byte-for-byte:
`plugins/page/plugins/bulleted-list/{package.json, CLAUDE.md, core, web}`.

- `core/bulleted-list-block.ts`:
  ```ts
  export const bulletedListBlock = defineBlock({
    type: "bulleted-list",
    schema: textDataSchema,
    label: "Bulleted list",
    icon: MdFormatListBulleted,
    empty: () => ({ text: "" }),
    markdownPrefixes: ["* ", "- ", "+ "],
  });
  ```
- `core/index.ts`: `export { bulletedListBlock } from "./bulleted-list-block";`
- `web/components/bulleted-list-block.tsx`:
  ```tsx
  <BlockTextEditor
    block={block} isFocused={isFocused} editor={editor}
    placeholder="List"
    marker={<span className="text-muted-foreground select-none py-1 pl-3 pr-1 text-sm leading-6">•</span>}
  />
  ```
- `web/index.ts`: contributes
  `Editor.Block({ match: bulletedListBlock.type, block: bulletedListBlock, component: BulletedListBlock })`.
- `package.json`: `@singularity/plugin-page-bulleted-list` (no direct lexical dep
  — it only renders `BlockTextEditor`).

Registration is automatic: `./equin build` regenerates
`web.generated.ts` from the filesystem (the new sub-plugin's `web/index.ts`
barrel is discovered). The Pages app (`page-tree`) renders all registered block
types through the dispatch slot — no app-side change needed.

## Critical files

| Action | Path |
|---|---|
| new | `plugins/page/plugins/editor/core/text-data.ts` |
| edit | `plugins/page/plugins/editor/core/index.ts` (export text-data) |
| edit | `plugins/page/plugins/editor/core/define-block.ts` (`markdownPrefixes`) |
| new | `plugins/page/plugins/editor/web/components/block-text-editor.tsx` |
| new | `plugins/page/plugins/editor/web/components/markdown-shortcut-plugin.tsx` |
| move | `…/text/web/components/{value-sync,keyboard,slash-menu}-plugin.tsx` → `…/editor/web/components/` |
| edit | `plugins/page/plugins/editor/web/index.ts` (export `BlockTextEditor`) |
| edit | `plugins/page/plugins/editor/web/block-editor-context.tsx` (`convertTo` refocus) |
| edit | `plugins/page/plugins/editor/package.json` (add lexical / editable-field deps) |
| edit | `plugins/page/plugins/text/core/text-block.ts` (use `textDataSchema`) |
| edit | `plugins/page/plugins/text/web/components/text-block.tsx` (thin wrapper) |
| del | `plugins/page/plugins/text/web/components/{value-sync,keyboard,slash-menu}-plugin.tsx` |
| edit | `plugins/page/plugins/text/{package.json,CLAUDE.md}` |
| new | `plugins/page/plugins/bulleted-list/**` (package.json, CLAUDE.md, core, web) |

## Reused existing pieces

- `defineBlock` / `BlockHandle` — `editor/core/define-block.ts`
- `Editor.Block` dispatch slot + `useInsertableBlocks` / `filterBlockTypes` /
  `BlockTypeList` — `editor/web/{slots,components/block-type-list}.ts`
- `BlockEditorAPI.convertTo` + `pendingFocusRef` focus glue —
  `editor/web/block-editor-context.tsx`
- `useEditableField` — `primitives/plugins/editable-field/web`
- Indent/outdent + depth-based rendering (nesting) — already generic in
  `block-editor.tsx` / `block-row.tsx`; bullets nest for free.

## Verification

1. `./equin build` (regenerates migrations — none expected here since no
   schema change — plus the plugin registry and docs). Must pass `./equin
   check` (boundaries, registry-in-sync, plugins-doc-in-sync, eslint).
2. Open the Pages app at `http://att-1780564738-v7m5.localhost:9000` (Pages →
   open/create a page), or use the page debug document endpoint.
3. **Markdown affordance:** in an empty text block type `* ` → block becomes a
   bullet, caret stays in the (now empty) bullet. Repeat with `- ` and `+ `.
   Type `* milk` in one keystroke-run → bullet with text "milk" preserved.
4. **Menus:** `/bullet` in the slash menu, the gutter `+`, the Add-block button,
   and the drag-handle "Turn into" all list "Bulleted list" and convert/insert.
5. **Nesting:** Tab on a bullet indents it under the previous block; Shift-Tab
   outdents. Enter splits into a new sibling bullet; Backspace-at-start merges.
6. **Regression:** plain text blocks still split/merge/indent and the slash menu
   still works (shared scaffolding unchanged in behavior).
7. Scripted check with `bun e2e/screenshot.mjs` to capture before/after of a
   `* `→bullet conversion.

## Out of scope

- Numbered lists, to-do/checkbox, headings, quotes (the extracted primitive
  makes these straightforward follow-ups — each is a new sub-plugin reusing
  `BlockTextEditor` with its own marker + `markdownPrefixes`).
- Auto-continuing the list on Enter into an "empty bullet → exit list" behavior
  (current Enter = generic split, which already yields a new sibling bullet;
  refine later if desired).
