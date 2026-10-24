# Inline page links (`[[`) + one-step page-link block

## Context

The Notion-like Pages app supports cross-page references only through a **block-level**
"Link to page" block. Two problems:

1. **No inline links.** You can't reference another page *inside* a sentence — the only
   affordance is a whole block. Notion's hallmark is typing `[[` mid-text to drop an inline
   page mention. We have nothing equivalent.
2. **The block-level link is two steps.** Inserting the "Link to page" block (via `/link`)
   creates an empty block; you then have to *click* "Select a page…" to open the picker.
   Selecting the block type should open the page list immediately.

This plan adds an inline `[[` page-link (typeahead → inline chip, with create-on-fly for a
missing page) and makes the existing block picker open on insert. Both feed the existing
backlinks index.

Decisions locked with the user:
- `[[` with no match offers **"Create '<query>'"** → creates a new top-level page and links it.
- Inline links are stored as a **`[[<pageId>]]` token inside the block's existing `data.text`
  string** (no schema change), rendered via a custom Lexical decorator node. This mirrors how
  the text-editor primitive stores inline images (`![](attachment:<id>)`).

## Architecture facts (verified)

- The block editor is a **custom** editor; each text-bearing block wraps its own
  `LexicalComposer` with `PlainTextPlugin` and `nodes: []`
  (`plugins/page/plugins/editor/web/components/block-text-editor.tsx`).
- **DecoratorNode works under PlainTextPlugin** — confirmed by precedent: the text-editor
  primitive's `paste-images` registers an inline `ImageNode` (DecoratorNode, `isInline()`)
  under `PlainTextPlugin`. PlainText restricts *formatting commands*, not node classes.
- **Block/page ids are `block-${Date.now()}-${base36}`** (`handle-create-block.ts:13`), NOT
  UUIDs. The token regex must be `\[\[(block-\d+-[a-z0-9]+)\]\]`.
- The text-editor primitive already solved token (de)serialization generically in
  `plugins/primitives/plugins/text-editor/web/internal/markdown.ts` — `serializeEditorToMarkdown`
  (walks children, calls `ext.serializeNode`, falls back to `getTextContent`) and
  `applyMarkdownToEditor` (per-ext `deserializePattern` regex + `createNodeFromMatch`, sort,
  overlap-guard). **We mirror this shape** for the block editor.
- Backlinks: `PageLinks.Extractor` (`plugins/page/plugins/links/server/internal/extractor.ts`)
  is keyed by exact block type; `reindex.ts` builds a `type→extract` map and dispatches per
  block, dedupes targets into a `Set`, validates against `type="page"`, diffs `page_links`
  edges. Reindex already fires on every `blocksChanged` emit (`links/server/index.ts:25`).
- Top-level page creation: `createPageWithSeed`
  (`plugins/apps/plugins/pages/plugins/page-tree/web/internal/create-page-with-seed.ts`) —
  `createBlock({ parentId:null, type:PAGE_BLOCK_TYPE, data:{title,icon:null} })` then a seed
  `createBlock({ parentId:page.id, type:textBlock.type, data:{text:""} })`. Omit `rank` (server
  appends via `nextRankUnder`). It lives in the *consumer* on purpose to avoid an editor↔text
  plugin cycle.

## Design

### 1. New sub-plugin `plugins/page/plugins/inline-page-link/`

Owns the whole inline-link feature (web node + typeahead + create-on-fly; server extractor;
core token helpers). Sibling of `text`, `page-link`, etc. Plugin id is path-derived — no `id:`
in the barrel.

### 2. Generic block-text extension mechanism (in the `editor` plugin)

Mirror the text-editor primitive's `registerNodeExtension`/`getNodeExtensions` registry — a
**single contribution shape**, no separate render slot:

```ts
// editor/web (new internal: block-text-extensions.ts)
interface BlockTextExtension {
  node: Klass<LexicalNode>;
  deserializePattern: RegExp;                 // matches the token in a line
  createNodeFromMatch: (m: RegExpExecArray) => LexicalNode | null;
  serializeNode: (n: LexicalNode) => string | null;  // chip → token, else null
  Plugin?: ComponentType;                     // rendered inside every block composer
}
registerBlockTextExtension(ext): () => void
getBlockTextExtensions(): BlockTextExtension[]
```

Wire-up (3 edits in `editor/web`):
- `block-text-editor.tsx`: `nodes: getBlockTextExtensions().map(e => e.node)`; render
  `{getBlockTextExtensions().map(e => e.Plugin && <e.Plugin key=… block=… editor=… />)}` inside
  the `LexicalComposer` (so the `[[` plugin gets composer context, like the existing
  SlashMenuPlugin).
- `value-sync-plugin.tsx`:
  - **value→editor**: replace the single-`$createTextNode` loop with the
    `applyMarkdownToEditor` algorithm (per-line regex matches across all extensions, sort by
    `start`, overlap guard, slice text around matches, append `createNodeFromMatch` nodes).
  - **editor→value**: replace `$getRoot().getTextContent()` with the
    `serializeEditorToMarkdown` walk (per child: linebreak→`\n`, text→`getTextContent`,
    else→first `serializeNode` that returns non-null, fallback `getTextContent`).
- Export `registerBlockTextExtension` / types from `editor/web/index.ts`.

**Why serialize via `serializeNode`, not the node's `getTextContent()`:** keep the decorator
node's `getTextContent()` returning `""` so live root-text reads — the slash menu's
`startsWith("/")` and the `[[` query scan — never see `[[<id>]]` tokens mid-line. The token only
appears in the persisted string, produced by `serializeNode`. Parse and serialize MUST be exact
inverses, or the value round-trip (`lastSerializedRef` compare in value-sync) will clear+rebuild
the editor and drop the caret.

### 3. `inline-page-link` web: node + parse + `[[` typeahead

- `PageLinkInlineNode` (DecoratorNode): holds `pageId`; `isInline()=>true`;
  `getTextContent()=>""`; `createDOM` → inline `span`; `decorate()` → React chip resolving title
  via `pagesResource` + `pageData`, click → `useBlockEditor().onOpenPage(pageId)`; unknown page →
  muted "(page not found)". Reuse the `link-chip` primitive
  (`@plugins/primitives/plugins/link-chip/web`) for chip styling.
- `registerBlockTextExtension({ node: PageLinkInlineNode, deserializePattern:
  /\[\[(block-\d+-[a-z0-9]+)\]\]/, createNodeFromMatch: m => $createPageLinkInlineNode(m[1]),
  serializeNode: n => $isPageLinkInlineNode(n) ? `[[${n.getPageId()}]]` : null, Plugin:
  InlinePageLinkPlugin })` at module load (mirror `paste-images` registering on import).
- `InlinePageLinkPlugin` (the `[[` typeahead) — mirror `slash-menu-plugin.tsx`:
  - Derive open-state + query from editor text on `registerUpdateListener`: find the last `[[`
    before the caret with no `]]`/newline between it and the caret; the text after `[[` is the
    query. Esc-latch (like the slash menu) until the `[[` is removed.
  - Register Arrow/Enter/Esc at `COMMAND_PRIORITY_CRITICAL`, each returning `false` when the
    menu is closed (so Enter still falls through to KeyboardPlugin's split).
  - On select: in one `editor.update()`, delete the `[[query` range and insert
    `$createPageLinkInlineNode(pageId)` + a trailing space at the caret. The (non-self-write)
    update fires value-sync → serialize → save.
  - **Caret-anchored popover** (the one piece with no in-repo precedent): position from
    `window.getSelection().getRangeAt(0).getBoundingClientRect()`, re-read on each update while
    open; render via a portal (`z-popover`) to escape block `overflow` clipping.
  - List + create-on-fly via the shared picker (below); on "Create '<query>'" call
    `createLinkedPage(query)` then insert the chip with the returned id.
- `createLinkedPage(query)` in `inline-page-link/web/internal/` — duplicate of
  `createPageWithSeed` (the same editor↔text cycle constraint applies; the precedent
  deliberately puts this in the consumer). Imports `createBlock`, `PAGE_BLOCK_TYPE` from
  `@plugins/page/plugins/editor/core` and `textBlock` from `@plugins/page/plugins/text/core`
  (sibling import; acyclic — text/editor don't depend on inline-page-link). `parentId:null`,
  `data:{title:query,icon:null}`, omit rank; seed a text block; return `page.id`.

### 4. Shared page-picker list — moved into `editor/web`

Extract the list/filter/render currently inlined in `page-link-block.tsx` into a reusable,
list-only component **in `@plugins/page/plugins/editor/web`** (it already owns `pagesResource`,
`pageData`, `Block`, `BlockTypeList`; both `page-link` and `inline-page-link` already import this
barrel → zero new edges; avoids a page-link↔inline-page-link sibling coupling):

```tsx
PageList({ query, onSelect(pageId), onCreate?(query) })  // renders filtered pages + optional
                                                          // "Create '<query>'" row when empty/always
```

`page-link` keeps its `PagePicker` popover but renders `<PageList>` inside; the `[[` typeahead
renders `<PageList>` in its caret popover and drives `query` from editor text.

### 5. `inline-page-link` server: global backlinks extractor

Generalize the extractor registry so inline links in *any* text-bearing block are indexed
without enumerating block types:

- `extractor.ts`: make `PageLinkExtractor.type` **optional**. Doc: an extractor with no `type`
  is a *global* extractor that runs on every block.
- `reindex.ts`: in addition to the `type→extract` map, collect the type-less extractors into a
  list; for each block run the type-specific extractor (if any) **plus** all global extractors,
  unioning into the existing `targets` Set (dedupe is automatic; existing `page-link` block edge
  + inline edge to the same target collapse to one).
- `inline-page-link/server/index.ts` contributes one global extractor: defensively
  `safeParse(data)` as `{text?:string}`, scan `text` with the `block-\d+-[a-z0-9]+` token regex,
  return the matched ids. No new server wiring (reindex already fires on `blocksChanged`).
- Token regex + scan helper live in `inline-page-link/core` (shared by web node and server
  extractor — single source of truth for the format).

### 6. Auto-open the block picker (the two-step fix)

`page-link-block.tsx`: add an `autoOpen` prop to `PagePicker`, `useState(autoOpen)` for `open`.
The `pageId === ""` (freshly inserted) branch passes `autoOpen`. `useState` initializes once per
mount → opens on insert, respects a later user-close, and the "page not found" branch passes
`autoOpen={false}`. No `defineBlock` change.

## Files

**New — `plugins/page/plugins/inline-page-link/`**
- `package.json`, `core/index.ts` (token regex + `scanPageLinkTokens(text)`),
  `web/index.ts`, `web/components/page-link-inline-node.tsx`,
  `web/components/inline-page-link-plugin.tsx`, `web/internal/create-linked-page.ts`,
  `server/index.ts`.

**Modified**
- `plugins/page/plugins/editor/web/components/block-text-editor.tsx` — extension-driven
  `nodes` + render contributed `Plugin`s.
- `plugins/page/plugins/editor/web/components/value-sync-plugin.tsx` — tokenized
  value↔editor (mirror `markdown.ts`).
- `plugins/page/plugins/editor/web/internal/block-text-extensions.ts` (new) +
  `editor/web/index.ts` export.
- `plugins/page/plugins/editor/web/components/page-list.tsx` (new shared list) +
  `editor/web/index.ts` export.
- `plugins/page/plugins/page-link/web/components/page-link-block.tsx` — use `PageList`;
  `autoOpen` for the empty state.
- `plugins/page/plugins/links/server/internal/extractor.ts` — optional `type`.
- `plugins/page/plugins/links/server/internal/reindex.ts` — run global extractors per block.

## Reuse (don't reinvent)
- `markdown.ts` algorithms (`serializeEditorToMarkdown`, `applyMarkdownToEditor`) — copy shape.
- `slash-menu-plugin.tsx` — typeahead skeleton (CRITICAL commands, Esc-latch, return-false-when-closed).
- `pagesResource`, `pageData` (`editor/core`); `link-chip`, `popover`, `search`, `row`,
  `placeholder` primitives.
- `createPageWithSeed` shape for `createLinkedPage`.

## Verification
1. `./equin build`; open `http://att-1780939137-v16m.localhost:9000` → Pages app.
2. **`[[` inline:** in a text block type `see [[`, confirm a caret-anchored menu opens with the
   page list; arrows/Enter select; an inline chip appears mid-sentence and is clickable
   (navigates to the page). Reload the page → the chip persists (token round-trips). Verify the
   `[[query` text is fully replaced (no leftover token text).
3. **Create-on-fly:** type `[[ZZZ-new` (no match) → "Create 'ZZZ-new'" → a new page is created,
   chip links to it, and it opens/edits.
4. **Backlinks:** on the linked target page, confirm the Backlinks section lists the source page
   for both an inline `[[` link and a `/link` block. `query_db` the `page_links` table to confirm
   one edge per (source,target) even when both link kinds point to the same target.
5. **Block picker one-step:** `/link` → the page picker opens immediately (no extra click).
   Select a page; reopen `/link`, press Esc → stays closed (no reopen loop).
6. Run `./equin check` (plugin-boundaries, eslint, plugins-doc-in-sync, migrations-in-sync).
7. Scripted check via `e2e/screenshot.mjs` for the `[[` menu open/insert if needed.

## Risks
- **Parse/serialize must be exact inverses** — else value round-trip clears the editor + drops
  caret. Covered by the `block-\d+-[a-z0-9]+` regex ↔ `[[${id}]]` serialize pairing and keeping
  the node's `getTextContent()` empty.
- **Caret-anchored positioning** is the only novel UI; budget for a portal + per-update rect read.
- **Literal-text hijack**: a user manually typing `[[block-…]]` would render as a chip. The
  id-shaped regex makes this astronomically unlikely; acceptable.
