# To-do / checkbox block type for the page editor

## Context

The block-based page editor (`plugins/page/`) recently gained a `bulleted-list`
block type (commit `ee130cb15`). That commit extracted a reusable text-block
primitive (`BlockTextEditor` / `BlockTextRenderer`) and a generic markdown
block-shortcut affordance, so new editable-text block types are now thin wrappers
that declare config on a `BlockHandle` (marker, placeholder, `markdownPrefixes`)
and reuse the shared renderer. Converting between such types reconciles *in place*
(same renderer function → Lexical instance, focus and caret survive).

We want a **to-do / checkbox block**: a text block with a toggleable checkbox,
strikethrough/muted styling when done, and a markdown affordance — typing `[] ` or
`[ ] ` at the start of a line converts the block into a to-do.

A to-do differs from text/bullet in two ways the current primitive doesn't cover:
1. Its data payload is `{ text, checked }`, not just `{ text }`.
2. It needs an *interactive* leading control (the checkbox) and content styling
   derived from `checked`.

The clean approach mirrors `bulleted-list` exactly: the to-do is a thin wrapper
that reuses the shared `BlockTextRenderer`, and the small differences are declared
as generic `BlockHandle` config and implemented once in the editor primitive (the
same way `marker`/`placeholder`/`markdownPrefixes` already are). This preserves
in-place reconciliation — so typing `[] ` converts without losing the caret — and
makes any future boolean-state text block (e.g. a "done" toggle) trivial.

## Approach

### A. Editor primitive — generic enhancements (4 files)

**1. `plugins/page/plugins/editor/core/define-block.ts`**
Add an optional generic `toggle` field to `BlockHandle` and `defineBlock`:

```ts
/**
 * For text block types with a boolean state: renders an interactive checkbox
 * marker bound to data[field], and applies `doneClassName` to the text content
 * when the field is truthy. Generic — never names a specific block type.
 */
toggle?: { field: string; doneClassName?: string };
```

**2. `plugins/page/plugins/editor/web/components/block-text-renderer.tsx`**
When the matched `handle.toggle` is set, render an interactive checkbox as the
`marker` (instead of the static glyph) and compute a content class:

- Read the boolean: `const data = block.data as Record<string, unknown>;`
  `const checked = Boolean(data[handle.toggle.field]);`
- Marker = a `<input type="checkbox" checked={checked}>` whose `onChange` calls
  `editor.update({ ...data, [handle.toggle.field]: !checked })`. Keep it outside
  the contentEditable (it already is — marker sits left of the editor) and
  `select-none`/`flex-none` like the existing glyph marker.
- `contentClassName = checked ? (handle.toggle.doneClassName ?? "line-through text-muted-foreground") : undefined`,
  passed through to `BlockTextEditor`.

The existing string-`marker` path (bullet) is unchanged.

**3. `plugins/page/plugins/editor/web/components/block-text-editor.tsx`**
- Add an optional `contentClassName?: string` prop, merged into the
  `ContentEditable` className via `cn(...)`.
- Fix `onSave` to **preserve sibling data fields** (today it does
  `editor.update({ text: next })`, which would wipe `checked`):
  ```ts
  onSave: (next) =>
    editor.update({ ...(block.data as Record<string, unknown>), text: next }),
  ```
  This is the correct general semantics — the text editor owns only the `text`
  field and must not clobber siblings. Backward-compatible for text/bullet
  (their data is just `{ text }`). The `block.data as Record<string, unknown>`
  cast mirrors the existing precedent in `handle-split-block.ts`.

**4. `plugins/page/plugins/editor/web/components/markdown-shortcut-plugin.tsx`**
On conversion, seed the **target type's default payload** before overlaying text
so a converted block gets a valid `{ text, checked }` (not just `{ text }`):
```ts
const target = contributions.find((c) => c.block.type === type)?.block;
editorRef.current.convertTo(type, { ...(target?.empty?.() ?? {}), text: remaining });
```
(The slash menu and "Turn into" menu already seed via `handle.empty?.() ?? {}` —
`slash-menu-plugin.tsx:92`, `block-actions-menu.tsx:48` — this brings the markdown
path in line.)

### B. New `to-do` plugin (mirrors `bulleted-list`)

```
plugins/page/plugins/to-do/
├── package.json        # { "name": "@singularity/plugin-page-to-do", "description": ..., "private": true, "version": "0.0.1" }
├── CLAUDE.md           # prose; autogen reference block appended by build
├── core/
│   ├── to-do-block.ts
│   └── index.ts
└── web/
    └── index.ts
```

**`core/to-do-block.ts`**
```ts
import { MdCheckBox } from "react-icons/md";
import { z } from "zod";
import { defineBlock } from "@plugins/page/plugins/editor/core";

export const toDoDataSchema = z.object({ text: z.string(), checked: z.boolean() });

export const toDoBlock = defineBlock({
  type: "to-do",
  schema: toDoDataSchema,
  label: "To-do",
  icon: MdCheckBox,
  empty: () => ({ text: "", checked: false }),
  placeholder: "To-do",
  // Typing `[] ` or `[ ] ` at line start converts the block into a to-do.
  markdownPrefixes: ["[] ", "[ ] "],
  toggle: { field: "checked" },
});
```

**`core/index.ts`** → `export { toDoBlock, toDoDataSchema } from "./to-do-block";`

**`web/index.ts`** (mirror `bulleted-list/web/index.ts` — reuse the shared renderer):
```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor, BlockTextRenderer } from "@plugins/page/plugins/editor/web";
import { toDoBlock } from "../core";

export { toDoBlock } from "../core";

export default {
  name: "To-do Block",
  description: "To-do / checkbox block type for the page editor.",
  contributions: [
    Editor.Block({ match: toDoBlock.type, block: toDoBlock, component: BlockTextRenderer }),
  ],
} satisfies PluginDefinition;
```

### C. Registration

No manual registry edit. `plugins/framework/plugins/web-sdk/core/web.generated.ts`
is regenerated by `./equin build`, which discovers and registers the new
plugin automatically (same as `bulleted-list`). No DB migration — `page_blocks.data`
is `jsonb`; the new `checked` field stores immediately.

## Why no custom component / why `BlockTextRenderer`

Using the shared renderer (not a bespoke `TodoBlock` component) keeps the
text↔to-do conversion remount-free: the headline UX the bulleted-list commit
engineered (caret survives `[] `) applies for free. The checkbox is the
interactive analog of the bullet's static `•` marker — declared as generic handle
config and rendered once in the primitive, never naming `to-do`. This is the
established precedent and keeps the to-do plugin to ~3 tiny files.

## Critical files

- `plugins/page/plugins/editor/core/define-block.ts` — add `toggle` config
- `plugins/page/plugins/editor/web/components/block-text-renderer.tsx` — checkbox marker + done class
- `plugins/page/plugins/editor/web/components/block-text-editor.tsx` — `contentClassName` prop + sibling-preserving `onSave`
- `plugins/page/plugins/editor/web/components/markdown-shortcut-plugin.tsx` — seed `empty()` on convert
- `plugins/page/plugins/to-do/**` — new plugin (mirror `plugins/page/plugins/bulleted-list/`)

## Known minor behavior

`handle-split-block.ts` copies the parent block's data (minus text) to the new
block, so pressing Enter mid-text on an *already-checked* to-do yields a new
checked to-do. This is rare (the common flow — Enter on the unchecked item you
just typed — produces a new unchecked to-do) and split is intentionally generic.
Left as-is; can be revisited if it proves annoying.

## Verification

1. `./equin build` from the worktree dir; confirm it completes and checks pass.
2. Open `http://att-1780578443-foyl.localhost:9000`, go to the **Pages** app, open
   (or create) a page.
3. **Markdown affordance:** in an empty block type `[] ` → block converts to a
   to-do with a checkbox and the caret stays in place; continue typing to confirm
   no keystrokes are lost. Repeat with `[ ] `.
4. **Slash + Turn-into:** `/to-do` inserts a to-do; the gutter "Turn into → To-do"
   converts an existing block.
5. **Toggle + styling:** click the checkbox → text gets strikethrough + muted; the
   `checked` state persists across reload (`query_db: select data from page_blocks
   where type='to-do'`).
6. **Sibling preservation:** check a to-do, then edit its text → it stays checked
   (confirms the `onSave` merge).
7. Scripted check via `bun e2e/screenshot.mjs --url <page-url>` capturing
   before/after the checkbox click.
