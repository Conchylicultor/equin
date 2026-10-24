# Heading blocks (H1/H2/H3) for the Pages editor

## Context

The Pages block editor (`plugins/page/`) has no heading block types, so documents
have no visual hierarchy — every block renders at body size. Notion's H1/H2/H3
(with `# `/`## `/`### ` markdown shortcuts and slash-menu entries) are missing.

This plan adds three heading block types as thin block-type plugins, reusing the
editor's existing generic extension points. The editor was explicitly built for
this: `MarkdownShortcutPlugin` and the slash menu both read block metadata
generically from the dispatch slot ("adding a heading/quote/to-do type needs zero
changes here"), and every text-like block shares one renderer so type conversions
reconcile in place (caret preserved). The only genuinely missing capability is
**per-type typography** (the shared editor hardcodes `text-body`), which we make
generic via one new handle field.

## Design

### New block-type plugins (mirrors `text` / `bulleted-list`)

Umbrella grouping folder `plugins/page/plugins/heading/` (pure folder, no own
barrel — like `plugins/infra`, `plugins/primitives`) with three child plugins:

- `plugins/page/plugins/heading/plugins/heading-1/`
- `plugins/page/plugins/heading/plugins/heading-2/`
- `plugins/page/plugins/heading/plugins/heading-3/`

Three separate plugins (one block type each) mirrors the existing
one-block-type-per-plugin precedent and keeps each level independently composable
via the reorder/composition system.

Each child has the same shape as `plugins/page/plugins/text/`:
`package.json`, `CLAUDE.md`, `core/index.ts`, `core/heading-N-block.ts`,
`web/index.ts`.

`core/heading-1-block.ts` (H2/H3 analogous):

```ts
import { MdTitle } from "react-icons/md";
import { defineBlock, textDataSchema } from "@plugins/page/plugins/editor/core";

export const heading1Block = defineBlock({
  type: "heading-1",
  schema: textDataSchema,          // same { text: string } payload as text
  label: "Heading 1",
  icon: MdTitle,                   // see "Icons" below
  aliases: ["h1", "title", "heading"],
  empty: () => ({ text: "" }),
  placeholder: "Heading 1",
  markdownPrefixes: ["# "],        // "## " for H2, "### " for H3
  textVariant: "title",            // NEW field — "heading" for H2, "subheading" for H3
  splitInto: "text",               // NEW field — Enter at end yields a body paragraph
});
```

`web/index.ts` (identical to `text`/`bulleted-list`, reusing `BlockTextRenderer`
so conversions reconcile in place):

```ts
Editor.Block({ match: heading1Block.type, block: heading1Block, component: BlockTextRenderer })
```

**Why `BlockTextRenderer` (not a custom component):** all text-like types must
resolve to the *same* dispatch component, or converting text↔heading remounts the
Lexical editor and loses the caret. Per-type presentation is read from the handle.

### Typography mapping (H1→`title`, H2→`heading`, H3→`subheading`)

Maps onto the existing semantic typography variants
(`plugins/primitives/plugins/text` — `title` 1.25rem/600, `heading` 1.125rem/600,
`subheading` 1rem/600, vs `body` 0.875rem/400). These read clearly above body text
while respecting the closed token set. The `text-{variant}` utilities are the
*sanctioned* classes (the `no-adhoc-typography` lint bans only raw `text-sm`/`text-lg`
etc., never these), and `block-text-editor.tsx` already uses `text-body` literally.

This is the only editor-core change needed for typography. Add a generic field to
the block handle (same pattern as the existing `marker`, `toggle`,
`splitChildWhenExpanded` fields):

1. `plugins/page/plugins/editor/core/define-block.ts` — add to `BlockHandle` +
   `defineBlock` opts/return:
   ```ts
   /** Semantic typography variant for the editable text (default "body"). */
   textVariant?: TextVariant;   // import type from @plugins/primitives/plugins/text/web (type-only)
   ```

2. `plugins/page/plugins/editor/web/components/block-text-renderer.tsx` — pass
   `textVariant={handle?.textVariant ?? "body"}` to `BlockTextEditor`.

3. `plugins/page/plugins/editor/web/components/block-text-editor.tsx` — accept a
   `textVariant: TextVariant` prop and apply the matching `text-<variant>` utility
   to **both** the `ContentEditable` and the placeholder `<div>`, replacing the
   two hardcoded `text-body` occurrences. Resolve via a local literal map
   `{ title: "text-title", heading: "text-heading", subheading: "text-subheading",
   body: "text-body", label: "text-label", caption: "text-caption" }` (keeps the
   change inside the editor plugin; the classes are lint-sanctioned). No DB change.

### Enter-at-end yields a paragraph (Notion behavior)

Pressing Enter at the **end** of a heading should create a normal `text` block
below (you write body text after a heading), not another heading. Mid-heading
splits keep the heading type. Implemented as a generic handle field `splitInto`,
mirroring the existing `splitChildWhenExpanded`/`childType` mechanism. Threaded
through the existing `splitOptions` channel:

1. `core/define-block.ts` — add `splitInto?: string` ("sibling type produced when
   Enter splits at end of text; defaults to same type").
2. `web/components/block-text-renderer.tsx` — include `splitInto: handle?.splitInto`
   in the `splitOptions` object passed down.
3. `web/components/block-text-editor.tsx` + `web/components/keyboard-plugin.tsx` —
   widen the `splitOptions` prop type to carry `splitInto?: string`; forward it.
4. `web/internal/keystroke-intent.ts` — `IntentContext.splitOptions` gains
   `splitInto?`; `KeyIntent` split gains `siblingType?`. In the `Enter` case set
   `siblingType = (!asChild && position === textLengthOf(node)) ? ctx.splitOptions?.splitInto : undefined`.
5. `core/block-ops.ts` — `BlockOp` split gains `siblingType?: string`; in
   `applyBlockOp` the new sibling's type becomes `siblingType ?? node.type`
   (asChild path unchanged).
6. `web/components/keyboard-plugin.tsx` execute `split` + `BlockEditorAPI.split`
   (`web/types.ts`, `web/internal/optimistic-block-ops.ts`) — thread `siblingType`
   into the emitted `BlockOp`.

These are all additive changes to the editor's own designed extension points (the
`BlockHandle` interface and the pure `block-ops`/`keystroke-intent` reducers), not
to load-bearing cross-cutting primitives.

### Icons

Convention is `react-icons/md` (322 uses; only `lucide-react` + `MdSmartToy` are
lint-banned). Material lacks dedicated H1/H2/H3 glyphs. Use `MdTitle` for all three
(consistent, the "Heading 1/2/3" label disambiguates) — or the numbered
`MdLooksOne`/`MdLooksTwo`/`MdLooks3` if clearer level distinction is preferred.
Implementer's choice; default to `MdTitle`.

## Files

New:
- `plugins/page/plugins/heading/plugins/heading-{1,2,3}/{package.json,CLAUDE.md,core/index.ts,core/heading-{1,2,3}-block.ts,web/index.ts}`

Modified (editor plugin — its designed extension points):
- `plugins/page/plugins/editor/core/define-block.ts` (+`textVariant`, +`splitInto`)
- `plugins/page/plugins/editor/core/block-ops.ts` (+`siblingType` in split)
- `plugins/page/plugins/editor/core/block-ops.test.ts` (cover siblingType split)
- `plugins/page/plugins/editor/web/components/block-text-renderer.tsx`
- `plugins/page/plugins/editor/web/components/block-text-editor.tsx`
- `plugins/page/plugins/editor/web/components/keyboard-plugin.tsx`
- `plugins/page/plugins/editor/web/internal/keystroke-intent.ts` (+ its test if present)
- `plugins/page/plugins/editor/web/types.ts` + `web/internal/optimistic-block-ops.ts` (split signature)

## Verification

1. `./equin build` — regenerates the plugin registry (picks up the 3 new
   plugins) and runs checks (`type-check`, `plugins-registry-in-sync`,
   `plugins-doc-in-sync`, `plugin-boundaries`).
2. Pure tests:
   `bun test plugins/page/plugins/editor/core/block-ops.test.ts`
   (and the keystroke-intent test if one exists).
3. Scripted Playwright on a page (`http://<worktree>.localhost:9000` → a page):
   - Slash menu: type `/` → "Heading 1/2/3" entries appear with icons; selecting
     one converts the block; typography is visibly larger/bolder per level.
   - Markdown: in an empty block type `# ` / `## ` / `### ` → converts to H1/H2/H3,
     prefix stripped, caret preserved, trailing text flows in.
   - In-place conversion: type text, then `# ` mid-stream → no remount, caret kept.
   - Enter at end of a heading → new **body** paragraph (not another heading).
   - Reload → heading type + text persist (DB `type`/`data`, no migration).
