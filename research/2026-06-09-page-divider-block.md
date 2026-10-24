# Divider block (`plugins/page/plugins/divider`) — Implementation Plan

> T1 of the Story Builder rollout. Companion to
> [`2026-06-03-app-story-builder-plan-v2.md`](./2026-06-03-app-story-builder-plan-v2.md)
> ("Divider block" section, lines 207–215).

## Context

The block editor (`plugins/page/plugins/editor`) has 7 block types but **no
horizontal divider/rule** — authors can't mark an explicit section break. This
adds a generic `divider` block, usable everywhere the editor is mounted
(including the Pages app), insertable via the slash menu and a `---` markdown
shortcut, rendering as a thin rule.

Beyond the immediate authoring need, the divider is the **structural-break
primitive** that later Story Builder renderers interpret: `story-core` (T3) will
map `type === DIVIDER_TYPE` to `role: "break"`, which the Slides renderer treats
as a slide boundary and the Blog renderer as an `<hr>`. Keeping the block
type-agnostic and self-contained here is what lets those renderers stay generic.

This task has **no dependencies**, owns **no migration**, and lands independently
(green build, working `---` in any Pages page).

## Design

A divider is a **void block**: it carries no data and has no editable content.
This makes it different from `code-block`/`image`, which have a `<textarea>` /
upload picker to hold focus. Because both insertion paths convert the *current*
text block into a divider **in place** —

- slash menu: `handleSelect` → `editor.convertTo(type, empty())`
  (`editor/web/components/slash-menu-plugin.tsx:92`)
- `---` markdown: → `editor.convertTo(...)`
  (`editor/web/components/markdown-shortcut-plugin.tsx:72–116`)

— and only `block-text-editor.tsx:86` registers a focus handle, a naive `<hr>`
would **strand the caret** on a non-editable block after insertion, and
arrow-key navigation (`focusUp`/`focusDown`, which call
`focusHandlesRef.get(id)?.focus()`) would silently skip over it.

**Decision (confirmed): the divider is a focusable void block.** It opts into
the editor's focus system so the caret never strands and keyboard nav works.
This is a justified deviation from the `code-block`/`image` mirror (per
*mirror-precedent*: deviate only with a named structural reason — here, a void
block has no intrinsic focus target).

## Plugin structure

Mirror `plugins/page/plugins/code-block` (core + web, **no server**, no schema
fields):

```
plugins/page/plugins/divider/
├── package.json
├── CLAUDE.md                       # scaffold; AUTOGEN block filled by ./equin build
├── core/
│   ├── index.ts                    # export { dividerBlock, DIVIDER_TYPE } from "./divider-block"
│   └── divider-block.ts            # defineBlock(...) + DIVIDER_TYPE const
└── web/
    ├── index.ts                    # default PluginDefinition → Editor.Block(...)
    └── components/
        └── divider-block.tsx       # focusable <hr> void block
```

`DIVIDER_TYPE` is exported as a named const so `story-core` (T3) can reference it
without string-duplicating `"divider"` — `story-core` is the single place
allowed to map block types → IR roles.

## Files

### `core/divider-block.ts`
```ts
import { z } from "zod";
import { MdHorizontalRule } from "react-icons/md";
import { defineBlock } from "@plugins/page/plugins/editor/core";

export const DIVIDER_TYPE = "divider";

export const dividerBlock = defineBlock({
  type: DIVIDER_TYPE,
  schema: z.object({}),            // void block — no data
  label: "Divider",                // required for slash-menu discovery
  icon: MdHorizontalRule,
  empty: () => ({}),
  markdownPrefixes: ["---"],       // longest-prefix-wins; fires on the 3rd "-"
});
```
Notes:
- The markdown plugin passes `{ ...empty(), text: remaining }` to `convertTo`;
  with no `text` field in the schema, `remaining` is harmlessly dropped (it is
  `""` anyway, since `---` is typed into an otherwise-empty block).
- Slash menu only lists blocks whose `block.label` is truthy
  (`block-type-list.tsx:12–18`); `filterBlockTypes` substring-matches `label`.

### `core/index.ts`
```ts
export { dividerBlock, DIVIDER_TYPE } from "./divider-block";
```

### `web/components/divider-block.tsx`
Focusable void block. Mirrors the focus-handle registration of
`block-text-editor.tsx:86` and the `onKeyDown` shape of `code-block.tsx`:
```tsx
import { useEffect, useRef } from "react";
import type { BlockRendererProps } from "@plugins/page/plugins/editor/web";
import { useBlockEditor } from "@plugins/page/plugins/editor/web"; // see "Open item"
import { cn } from "@/lib/utils";

export function DividerBlock({ block, isFocused, editor }: BlockRendererProps) {
  const { registerFocusHandle } = useBlockEditor();
  const ref = useRef<HTMLDivElement>(null);

  // Register so convertTo / insertAfter / arrow-nav can land focus on us.
  useEffect(
    () => registerFocusHandle(block.id, { focus: () => ref.current?.focus() }),
    [block.id, registerFocusHandle],
  );

  // Pull focus to the wrapper when the editor considers this block focused
  // (e.g. right after a `---` conversion keeps focusedBlockId on this id).
  useEffect(() => {
    if (isFocused && ref.current && document.activeElement !== ref.current) {
      ref.current.focus();
    }
  }, [isFocused]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      editor.focusUp();   // move caret to the block above first…
      editor.remove();    // …then delete the divider
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      editor.focusUp();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      editor.focusDown();
    } else if (e.key === "Enter") {
      e.preventDefault();
      editor.insertAfter("text", {}); // continue typing on a new line below
    }
  }

  return (
    <div
      ref={ref}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => editor.onFocus()}
      aria-label="Divider"
      className={cn(
        "group/divider cursor-default px-3 py-2 outline-none",
        isFocused && "rounded ring-1 ring-primary/30",
      )}
    >
      <hr className="border-t border-border" />
    </div>
  );
}
```
- Enter inserts a sibling text block and focuses it via the existing
  pending-focus machinery (`block-editor-context.tsx:212–226`). The editor
  deliberately does **not** know the text block (avoids an editor↔text cycle),
  so — exactly like `create-page-with-seed.ts` — the divider, as a consumer of
  both editor and text, constructs the seed itself:
  `editor.insertAfter(textBlock.type, textBlock.schema.parse({ text: "" }))`.
  Passing an invalid `{}` payload instead makes the new text block fail its
  schema parse (`text: Required`). `divider → text → editor` is acyclic.

### `web/index.ts`
```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { dividerBlock } from "../core";
import { DividerBlock } from "./components/divider-block";

export { dividerBlock, DIVIDER_TYPE } from "../core";

export default {
  // No `name` field — PluginDefinition has no authored name; id derives from path.
  description:
    "Divider block type: a thin horizontal rule marking a section break; insert via `/divider` or the `---` markdown shortcut.",
  contributions: [
    Editor.Block({ match: dividerBlock.type, block: dividerBlock, component: DividerBlock }),
  ],
} satisfies PluginDefinition;
```

### `package.json`
```json
{
  "name": "@singularity/plugin-page-divider",
  "description": "Divider block type for the page editor: a thin horizontal rule marking a section break.",
  "private": true,
  "version": "0.0.1"
}
```

### `CLAUDE.md`
Header (`# divider`) + an empty `AUTOGENERATED:BEGIN/END` block — `./equin
build` fills it (Web + Core sections only, no Server). Mirror
`code-block/CLAUDE.md`.

## No editor changes required

`useBlockEditor` (which exposes `registerFocusHandle`) and `BlockRendererProps`
are both already re-exported from `editor/web/index.ts`, so
`import { useBlockEditor, type BlockRendererProps } from "@plugins/page/plugins/editor/web"`
is a legal single-barrel cross-plugin import. The divider is a **pure additive
contribution** — zero changes to the editor or any other plugin.

## Cross-plugin imports (boundary-checked — runtime barrels only)
- `divider/core` → `@plugins/page/plugins/editor/core` (`defineBlock`); `zod`,
  `react-icons/md`.
- `divider/web` → `@plugins/framework/plugins/web-sdk/core` (`PluginDefinition`),
  `@plugins/page/plugins/editor/web` (`Editor`, `BlockRendererProps`,
  `useBlockEditor`), `@plugins/page/plugins/text/core` (`textBlock`, for the
  Enter continuation seed — mirrors `create-page-with-seed.ts`), `../core`,
  `@/lib/utils`.

No server side, no new DB table, no cross-plugin re-exports, no cycles.

## Verification

1. `./equin build` — codegen registers the new `web` plugin; fills the
   `CLAUDE.md` autogen block. (No migration — divider has no server/table.)
2. `./equin check plugin-boundaries` + `./equin check plugins-doc-in-sync`
   (and a full `./equin check` to be safe). Expect green.
3. Manual loop in the **Pages** app (`http://<worktree>.localhost:9000` → Pages):
   - In an empty block, type `/div` → "Divider" appears in the slash menu →
     Enter inserts it as a rule.
   - In a fresh empty block type `---` → converts to a divider on the third `-`.
   - With the divider focused (ring visible): `Enter` → new text line below;
     `↑`/`↓` move to neighbours; `Backspace` deletes it and lands the caret on
     the block above.
   - Drag-handle → block-actions menu → Delete also removes it (generic chrome).
   - Reload: divider persists (it's a normal `page_blocks` row of `type:"divider"`).
4. Scripted check (optional): `bun e2e/screenshot.mjs --url <pages-url> --out /tmp/divider`
   to capture the rendered rule.

## Out of scope (later rollout tasks)
- `story-core` mapping `DIVIDER_TYPE → role:"break"` (T3).
- Renderer interpretation (slide break / `<hr>`) in Slides/Blog (T5/T6).
- The build-log case-study entry (`research/2026-06-09-story-builder-build-log.md`).
</content>
</invoke>
