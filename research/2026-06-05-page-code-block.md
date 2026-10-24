# Code block type for the page editor

## Context

The page editor (`plugins/page/`) is a Notion-like block editor where each block type
is its own plugin contributing a renderer to the `Editor.Block` dispatch slot. It has
text, bulleted-list, to-do, toggle, image, and page-link blocks — but no way to embed
**code**. We want a first-class **code block** with:

- **Live syntax highlighting** while typing (chosen UX: transparent-textarea-over-
  highlighted-code overlay, à la react-simple-code-editor / CodeJar).
- **Language selection** via a dropdown.
- A **copy-to-clipboard** button.
- A **```** markdown shortcut to convert a text block into a code block.

The shiki-based highlighter already exists as a primitive
(`plugins/primitives/plugins/syntax-highlight/`) and **must be reused** — we do not add
new highlighting infrastructure.

This is a **purely client-side** feature. Block `data` is an opaque `jsonb` column on
`page_blocks`; a new block type adds no DB table and **no migration**. We mirror the
existing **image block** (`plugins/page/plugins/image/`, commit 783584598) as the
structural precedent — but the image block has a server plugin (attachment links); the
code block needs **no server plugin**, like the `text` block.

## New plugin: `plugins/page/plugins/code-block/`

Four files (mirroring `text` + `image`, minus any server code):

### 1. `core/code-block.ts` — the block handle

```ts
import { z } from "zod";
import { MdCode } from "react-icons/md";
import { defineBlock } from "@plugins/page/plugins/editor/core";

export const codeBlock = defineBlock({
  type: "code-block",
  schema: z.object({
    code: z.string().default(""),
    language: z.string().optional(), // undefined = plain text
  }),
  label: "Code",
  icon: MdCode,
  empty: () => ({ code: "" }),
  markdownPrefixes: ["```"], // typing ``` converts a text block → code block
});
```

- `language` is `undefined` for plain text; otherwise one of the 17 `SHIKI_LANGS` ids.
- `markdownPrefixes: ["```"]` plugs into the existing generic `MarkdownShortcutPlugin`
  (`plugins/page/plugins/editor/web/components/markdown-shortcut-plugin.tsx`) with **zero
  changes there** — it fires on the transition into `"```"` (the third backtick; no
  trailing space needed). Note: the converter passes `{ ...empty(), text: remaining }`;
  the code block's schema ignores the extra `text` key (zod strips unknown keys), so the
  block starts empty — matching Notion's ``` behavior.

### 2. `core/index.ts`

```ts
export { codeBlock } from "./code-block";
```

### 3. `web/index.ts` — register the contribution (mirrors image)

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { codeBlock } from "../core";
import { CodeBlock } from "./components/code-block";

export { codeBlock } from "../core";

export default {
  name: "Code Block",
  description:
    "Code block type: editable with live syntax highlighting, language picker, and copy button.",
  contributions: [
    Editor.Block({ match: codeBlock.type, block: codeBlock, component: CodeBlock }),
  ],
} satisfies PluginDefinition;
```

### 4. `package.json`

```json
{
  "name": "@singularity/plugin-page-code-block",
  "description": "Code block type for the page editor: editable code with live syntax highlighting, language picker, and copy button.",
  "private": true,
  "version": "0.0.1"
}
```

### 5. `web/components/code-block.tsx` — the renderer (the real work)

Receives `BlockRendererProps` (`{ block, isFocused, editor }`). The
**overlay editor** technique: a `<textarea>` with transparent text + visible caret laid
exactly over a `<pre>` of shiki-highlighted HTML, with byte-identical font metrics.

**Reused primitives (exact imports):**

- Highlighter: `getHighlighter`, `themeForMode`, `resolveLang`, `SHIKI_LANGS`,
  `useDarkMode` from `@plugins/primitives/plugins/syntax-highlight/web`.
  - Call the raw highlighter (`getHighlighter(lang).then(hl => hl.codeToHtml(code, { lang, theme }))`)
    rather than `<HighlightedCode>`, because `HighlightedCode` bakes in an outer `my-2`
    margin + `<ContentScope>` wrapper that fights pixel-perfect overlay alignment. We own
    the `<pre>` so its padding/metrics match the textarea exactly.
- Debounced persistence: `useEditableField` from
  `@plugins/primitives/plugins/editable-field/web`
  — API confirmed: `{ value, onChange, onFocus, onBlur, flush, isSaving }`, 500ms debounce,
  flush-on-blur. Use it for the `code` string; persist `language` immediately on select.
- Copy button: `CopyButton` from `@plugins/primitives/plugins/copy-to-clipboard/web`.
- Language dropdown: `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`
  from `@/components/ui/select` (all `SelectItem`s rendered eagerly → no `items` prop needed).
- Hover toolbar: `FloatingAction` + `FloatingActionFadeIn` from
  `@plugins/primitives/plugins/floating-action/web` (anchor top-right; language picker +
  copy button revealed on hover/focus).

**Alignment contract (must be identical on `<pre>` underlay and `<textarea>`):**
`p-3 font-mono text-xs leading-5`, `whitespace-pre`, `tabSize: 4` (inline style on both),
no border on either (outer wrapper owns background/rounding). Textarea: `absolute inset-0`,
`resize-none`, `bg-transparent text-transparent caret-foreground`, `outline-none`,
`overflow-auto`. Underlay `<pre>`: `m-0`, `pointer-events-none select-none`, hidden
scrollbar (`[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`). The `<pre>` sits in
normal flow and sizes the box; render `" "` when empty so the box never collapses.

**Behavior:**

- Local React state for `code` (via `useEditableField`) and `language` (`useState`, with a
  ref so the code-debounce closure always saves the latest language). `editor.update({ code, language })`
  on code save and immediately on language change.
- Re-highlight in a `useEffect` keyed on `[code, resolvedLang, dark]`; `resolveLang(language)
  === null` (plain text or unknown) → skip shiki, textarea shows its own text (drop the
  `text-transparent` so the plain text is legible).
- Scroll sync: `onScroll` on the textarea copies `scrollTop/scrollLeft` to the `<pre>`.
- Key handling inside the textarea (it natively captures keys, so Enter inserts a newline
  and never triggers the editor's block-split):
  - **Tab** → `preventDefault`, insert two spaces, restore caret (`requestAnimationFrame`).
  - **Backspace on empty** → `editor.remove()` (Notion behavior).
  - **ArrowUp at offset 0** → `editor.focusUp()`; **ArrowDown at end** → `editor.focusDown()`
    (so keyboard navigation flows across blocks).
  - `onFocus` → `editor.onFocus()` (keep the editor's focus model in sync) + `field.onFocus()`.

## Files to create

- `plugins/page/plugins/code-block/core/code-block.ts`
- `plugins/page/plugins/code-block/core/index.ts`
- `plugins/page/plugins/code-block/web/index.ts`
- `plugins/page/plugins/code-block/web/components/code-block.tsx`
- `plugins/page/plugins/code-block/package.json`

## Files NOT touched

- **No registry edits.** `web.generated.ts` / `server.generated.ts` are regenerated from
  the filesystem by `./equin build`; creating `web/index.ts` is sufficient.
- **No DB migration.** `page_blocks.data` is already `jsonb`.
- **No edits to the editor core, markdown-shortcut plugin, or insert menus** — they read
  block handles generically from the `Editor.Block` slot (collection-consumer separation).

## Key references

- Precedent (non-text custom block, focus model, free-resize): `plugins/page/plugins/image/web/components/image-block.tsx`
- Block handle factory: `plugins/page/plugins/editor/core/define-block.ts`
- Renderer props / editor API: `plugins/page/plugins/editor/web/types.ts`
- Highlighter primitive: `plugins/primitives/plugins/syntax-highlight/web/internal/{highlighted-code,lang,highlighter}.tsx`
- Debounce hook: `plugins/primitives/plugins/editable-field/web/use-editable-field.ts`
- Markdown shortcut wiring: `plugins/page/plugins/editor/web/components/markdown-shortcut-plugin.tsx`

## Verification

1. `./equin build` (regenerates registry + migrations, rebuilds, restarts; runs checks).
   Confirm the build is green and the new plugin appears in `web.generated.ts`.
2. Open `http://att-1780615565-rt0w.localhost:9000` → Pages app → open/create a page.
3. **Insertion paths:**
   - Slash menu: type `/` → pick **Code**. + button and "Turn into" menu also list **Code**.
   - Markdown shortcut: in an empty text block type ```` ``` ```` → it converts to a code block.
4. **Editing:** type `const x: number = 42;`, set language to **ts** → tokens colorize live
   as you type; caret stays aligned with the text. Test **Tab** (2 spaces), multi-line via
   **Enter**, long lines (horizontal scroll stays aligned), **Backspace on empty** removes
   the block, Arrow up/down crosses block boundaries.
5. **Language picker:** switch ts → python → **Plain text**; highlighting updates / clears.
6. **Copy button:** click → clipboard holds the exact code.
7. **Persistence:** reload the page → code + language survive (debounced save landed).
8. **Dark mode:** toggle theme → highlight theme follows (`github-dark` ↔ `github-light`).
9. Scripted check (optional): `bun e2e/screenshot.mjs --url http://att-1780615565-rt0w.localhost:9000/... --out /tmp/code-block`.
```
