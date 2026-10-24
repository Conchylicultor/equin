# Pages editor: math / equation support (block + inline LaTeX)

## Context

The Pages block editor has no math support — no block-level equation block and no
inline LaTeX. This adds both, rendered with **KaTeX**, mirroring the editor's two
established extension surfaces:

- **Block types** (`code-block`, `divider`): contributed to the `Editor.Block`
  dispatch slot via `defineBlock` + a renderer component.
- **Inline nodes** (`inline-page-link`): contributed to the `BlockTextExtension`
  registry — a custom Lexical `DecoratorNode` that round-trips as a text token
  inside the block's plain-text `data.text`.

No DB/schema change is needed: block `data` is a schema-free `JSONB` column, and
inline nodes persist as tokens inside existing text.

## Structure — umbrella `plugins/page/plugins/math/`

Three sub-plugins (umbrella dir carries no barrel, like `plugins/infra`):

```
plugins/page/plugins/math/
  plugins/render/    — shared KaTeX renderer leaf: <KatexMath/>; owns the katex dep + CSS import
  plugins/equation/  — block-level "equation" block type
  plugins/inline/    — inline math: $$-typeahead + click-to-edit, BlockTextExtension
```

`equation` and `inline` both import `<KatexMath/>` from `render`'s web barrel
(`@plugins/page/plugins/math/plugins/render/web`). The shared renderer is the
single home for KaTeX config (so error styling, macros, etc. stay consistent).

### Why a shared `render` leaf (not one combined plugin)
Block equations and inline math are independently meaningful, independently
toggleable features → separate plugins (per project "split for modularity"). Both
need KaTeX rendering; cross-plugin sharing requires a barrel → a tiny `render`
leaf is the clean DAG-respecting home (no re-export proxying).

## `render` plugin

- `package.json`: deps `katex`, `@types/katex` (verified installable, v0.17.0).
- `web/components/katex-math.tsx`:
  ```tsx
  import "katex/dist/katex.min.css"; // Vite bundles the CSS + woff2 fonts (pattern: terminal imports xterm.css)
  import katex from "katex";
  export function KatexMath({ expression, display, className }: {
    expression: string; display: boolean; className?: string;
  }) {
    const html = useMemo(
      () => katex.renderToString(expression, {
        displayMode: display, throwOnError: false, output: "html",
        errorColor: "var(--destructive)", // matches theme tokens
      }),
      [expression, display],
    );
    return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  ```
  `throwOnError: false` makes KaTeX render parse errors inline in `errorColor`
  rather than throwing — fail-soft display is correct here (the user is mid-typing
  a formula), and is a *render* concern, not a swallowed exception.
- `web/index.ts`: barrel exporting `KatexMath` (empty `contributions`).
- `core/`: none needed (no shared types).

## `equation` plugin (block-level)

Mirror `code-block` (focusable, owns its own focus handle + textarea — outside
Lexical). Files:

- `core/equation-block.ts`:
  ```ts
  export const EQUATION_TYPE = "equation";
  export const equationBlock = defineBlock({
    type: EQUATION_TYPE,
    schema: z.object({ expression: z.string().default("") }),
    label: "Equation",
    icon: MdFunctions,                 // react-icons/md
    aliases: ["math", "latex", "katex", "formula", "tex", "equation"],
    empty: () => ({ expression: "" }),
    markdownPrefixes: ["$$"],          // `$$` at start of a text block → equation block
  });
  ```
- `core/index.ts`: re-export.
- `web/components/equation-block.tsx` (renderer):
  - Reads `equationBlock.parse(block.data)`.
  - `useEditableField({ value: expression, onSave: (v) => editor.update({ expression: v }) })`
    (same debounced-save pattern as code-block).
  - **Display (not focused, non-empty):** centered `<KatexMath display />`,
    clickable to focus → reveals editor. Empty + not focused: muted placeholder
    ("New equation — click to edit").
  - **Editing (focused or empty):** a small panel: monospace `<textarea>` for the
    LaTeX source + a live `<KatexMath display />` preview above it. Errors show via
    KaTeX `errorColor`.
  - Focus handle via `registerFocusHandle` (it's a void-ish block, like divider/
    code) + `useEffect` pulling focus into the textarea when `isFocused`.
  - Keyboard (mirror code-block): `Backspace` on empty → `editor.remove()`;
    `ArrowUp` at caret 0 → `editor.navigate("up")`; `ArrowDown` at end →
    `editor.navigate("down")`. `Enter`: commit + `editor.insertAfter(textBlock…)`
    a text block below (Notion-like — leave the equation, keep writing). Use the
    `textBlock` seed pattern from divider (`@plugins/page/plugins/text/core`).
- `web/index.ts`: `Editor.Block({ match: equationBlock.type, block: equationBlock, component: EquationBlock })`.

## `inline` plugin (inline math)

Mirror `inline-page-link` exactly.

- `core/tokens.ts` — canonical token format. Persist as LaTeX-standard inline
  delimiters `\(…\)` (collision-safe: prose virtually never contains `\(`, and
  LaTeX content never contains the math delimiters themselves; far safer than `$…$`
  which collides with prices on reload):
  ```ts
  export const INLINE_MATH_TOKEN_PATTERN = /\\\(([^\n]*?)\\\)/; // group 1 = latex
  export const inlineMathToken = (latex: string) => `\\(${latex}\\)`;
  ```
- `web/components/inline-math-node.tsx` — `DecoratorNode<ReactNode>`,
  `isInline(): true`, stores `__expression`, `getTextContent(): ""` (token must not
  leak into root-text reads / the `$$` scan). `decorate()` → `<InlineMathView
  nodeKey expression/>` rendering `<KatexMath display={false}/>`, **clickable to
  edit**: opens a `Popover` with a LaTeX input + live preview; on change updates the
  node by key (`editor.update(() => { const n = $getNodeByKey(key); n.setExpression(v) })`,
  with a `getWritable()` setter). Provide `$createInlineMathNode`, `$isInlineMathNode`.
- `web/components/inline-math-plugin.tsx` — `$$` typeahead, mirror
  `InlinePageLinkPlugin`:
  - Trigger `"$$"`; derive open-state + query (LaTeX after the last `$$` up to
    caret) + caret rect from the editor on every update.
  - **Guard:** if the `$$` is at absolute offset 0 of the block's first line (no
    preceding text), CLOSE — defer to the block `$$` markdown shortcut. (start-of-
    line `$$` = block equation; mid-line `$$` = inline.)
  - A `$` / newline inside the query ends/closes it; Esc sets the dismiss latch.
  - Popover (portaled at caret, `Surface level="overlay"`): single live
    `<KatexMath display={false}/>` preview of the query + a "↵ to insert" hint
    (no list — freeform LaTeX, unlike page-link's option list).
  - Commit on `Enter`: replace `$$<query>` with `$createInlineMathNode(query)` +
    trailing space (mirror `insertLink`). Empty query → no-op.
- `web/internal/register.ts` — side-effect `registerBlockTextExtension({ id:
  "inline-math", node: InlineMathNode, deserializePattern: INLINE_MATH_TOKEN_PATTERN,
  createNodeFromMatch: (m) => $createInlineMathNode(m[1]!), serializeNode: (n) =>
  $isInlineMathNode(n) ? inlineMathToken(n.getExpression()) : null, Plugin:
  InlineMathPlugin })`.
- `web/index.ts` — `import "./internal/register"`; empty `contributions`.
- `package.json`: deps `lexical`, `@lexical/react` (mirror inline-page-link).

## Files to create (summary)

```
plugins/page/plugins/math/plugins/render/{package.json, web/index.ts, web/components/katex-math.tsx}
plugins/page/plugins/math/plugins/equation/{package.json, core/{index.ts,equation-block.ts}, web/{index.ts,components/equation-block.tsx}}
plugins/page/plugins/math/plugins/inline/{package.json, core/{index.ts,tokens.ts}, web/{index.ts,internal/register.ts,components/{inline-math-node.tsx,inline-math-plugin.tsx}}}
```

Each plugin gets a `CLAUDE.md` is auto-generated by `./equin build` (docgen)
— do NOT hand-write the reference block.

## Verification

1. `./equin build` (runs `bun install` → pulls katex; regenerates docs/registry; restarts).
2. Open `http://att-1781558718-vudf.localhost:9000` → Pages app → a page.
3. Block: `/equation` (and `$$` at empty line) → editor appears; type `E=mc^2` →
   centered render; click away → collapsed render; click → re-edit; empty +
   Backspace → removed.
4. Inline: mid-line type `$$E=mc^2` → preview popover → Enter → inline render;
   reload page → still rendered (token round-trip); click chip → edit popover.
5. `./equin check` clean (boundaries, type-check, plugins-registry/doc in sync).
```

## Key decisions / tradeoffs

- **`$$` inline trigger (user-confirmed)** over LaTeX-native `$…$`: prose-safe (no
  popover on "$5"), coherent "`$$` = math" rule. Cost: LaTeX users typing `$x$`
  get nothing; discoverable via `/equation` + docs.
- **Persist inline as `\(…\)`** not `$…$`: collision-safe on reload.
- **Umbrella + shared `render` leaf** over one combined plugin: modular, KaTeX
  config single-homed.
- **KaTeX** over MathJax: smaller, synchronous `renderToString`, CSS+font bundling
  via Vite, ubiquitous for Notion-like inline math.
