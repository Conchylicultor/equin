# Notion-like Pages app with cross-linked pages

## Context

The block/page editor already exists and is solid: `page_documents` + `page_blocks`
tables, a full REST surface, push live-state resources, a dispatch slot
(`Editor.Block`) for block types, and a `<BlockEditor documentId={…} />` component.
But it has **no product around it** — it is mounted only as a debug harness
(`plugins/page/plugins/debug`) against one hardcoded get-or-create document
(`DEBUG_DOC_ID = "doc-debug"`), with a single block type (`text`).

We want a real Notion-like app: many pages that nest, that link to one another,
with a surface to browse / create / open / rename / delete, a sidebar page-tree,
and cross-page links + backlinks. This is a concrete step toward the
"Notion-like WeChat" vision — pages become a first-class composition surface that
agents and users build on, reusing the existing block plugins and primitives.

**Scope decisions (confirmed with user):**
- **Phase the cross-link surfaces.** Ship multi-page + block-level "link to page"
  + backlinks first (low risk, reuses existing slots). Inline `@`-mentions come in
  a later phase because they require refactoring the bespoke text-block editor.
- **No page-embed for now.** Link-to-page (click-through) only; live/preview
  embed is explicitly out of scope.
- **Nested sub-pages.** Pages form a tree (parent + rank on documents), Notion-style.

## Current state (verified)

- Domain + editor: `plugins/page/plugins/editor`
  - Tables `plugins/page/plugins/editor/server/internal/tables.ts`:
    `page_documents{id,title,createdAt,updatedAt}`,
    `page_blocks{id,documentId,parentId,type,data jsonb,rank,expanded,…}`.
  - Resources `…/server/internal/resources.ts`: `documentsLiveResource` (all docs),
    `blocksLiveResource` (**all blocks of all documents**, client filters by id —
    a fan-out problem at multi-page scale).
  - Endpoints `…/core/endpoints.ts`: documents CRUD + block create/update/delete/
    move/split/merge/indent/outdent (all already exist, just unused outside debug).
  - Slot `Editor.Block` (`…/web/slots.ts`) — dispatch by `block.type`; block types
    contribute `{ match, block: BlockHandle, component }`. `defineBlock` in
    `…/core/define-block.ts`.
  - `<BlockEditor documentId>` (`…/web/components/block-editor.tsx`) is already
    multi-document-shaped; it just needs a real `documentId` source.
- Text block: `plugins/page/plugins/text` — a **bespoke** Lexical `PlainTextPlugin`
  composer (`nodes: []`, own `ValueSyncPlugin`/`KeyboardPlugin`), **not** the generic
  `text-editor` primitive. → inline mentions need this generalized (Phase 3).
- Debug harness: `plugins/page/plugins/debug` — get-or-create `doc-debug`, mounts
  `<BlockEditor>`. Will stay as-is (still useful), independent of the new app.

### Load-bearing facts confirmed
- `defineResource<T,P>` is **parameterized** (`loader(params)`, `notify(params)`)
  and supports `dependsOn` derived/cascading resources
  (`plugins/framework/plugins/server-core/core/resources.ts`). → per-document block
  scoping and a push-based backlinks resource are natively supported.
- Server-side collection exists: `defineServerContribution` + `collectContributions`
  (same file's sibling `contributions.ts`). → a per-block-type link-extractor
  registry on the server is clean and respects collection-consumer separation.
- App scaffolding: `Apps.App` slot + `AppShellLayout` (sidebar+toolbar+miller).
  Forge (`plugins/apps/plugins/forge`) is the exact template. `create-app` rule:
  new app at `plugins/apps/plugins/<name>/`, empty top-level barrel, shell is a
  sub-plugin contributing `Apps.App`.

## Target architecture — plugin layout

```
plugins/page/                              # domain umbrella (extended)
  plugins/editor/        [MODIFY]  documents get parentId/rank/expanded/icon;
                                   blocks resource scoped per-document;
                                   emit a blocksChanged trigger event
  plugins/text/          [MODIFY]  Phase 3: host contributed inline nodes;
                                   add server extractor for [[id]] tokens
  plugins/page-link/     [NEW]     "link to page" block type (Phase 2)
  plugins/links/         [NEW]     backlinks index: page_links table,
                                   extractor registry, reindex, backlinks resource
  plugins/mention/       [NEW]     Phase 3: inline @-mention node + typeahead

plugins/apps/plugins/pages/                # NEW product surface (create-app)
  web/index.ts                     empty namespace plugin
  plugins/shell/         [NEW]     Apps.App entry + Pages.Sidebar/Toolbar slots
  plugins/page-tree/     [NEW]     sidebar TreeList + panes (root + /page/:id)
                                   + page-detail (header, editor, sections slot)
```

Rationale: the `page` umbrella owns *domain* (documents, blocks, links, block
types) — reusable beyond this app. `apps/pages` owns only the *product surface*
(rail entry, sidebar tree, panes), consuming editor/links endpoints + resources,
exactly as Forge's `catalog`/`publish` consume other plugins.

---

## Phase 1 — Multi-page product (browse / create / open / rename / delete + nesting)

### 1a. Documents become a tree
Add to `page_documents` (`plugins/page/plugins/editor/server/internal/tables.ts`),
mirroring `page_blocks` byte-for-byte so the tree primitives apply unchanged:
- `parentId text references page_documents(id) onDelete cascade` (nullable = root)
- `rank rankText` (from `@plugins/primitives/plugins/rank`)
- `expanded boolean default true`
- `icon text` (nullable; optional emoji/icon for the row)
- index on `(parentId, rank)`.

Update Zod (`…/core/schemas.ts` `DocumentSchema`) + the document endpoints
(`…/core/endpoints.ts`, handlers in `…/server/internal/`):
- `createDocument` body accepts optional `parentId`, `rank`, `icon` (default rank
  via `nextRankUnder(_documents, _documents.parentId, parentId)`).
- `updateDocument` (PATCH `/api/documents/:id`) accepts `parentId`, `rank`,
  `expanded`, `icon` (currently title-only) — this powers rename, reparent/reorder
  (DnD), expand/collapse, and icon edit through one endpoint.
- `documentsLiveResource` loader: order by `rank` (kept global — the sidebar needs
  the whole tree); call `documentsLiveResource.notify()` on every doc mutation.

### 1b. Scope blocks per document (fix the fan-out)
Change `blocksResource` (`…/core/resources.ts` descriptor) + `blocksLiveResource`
(`…/server/internal/resources.ts`) to be **parameterized by `{ documentId }`**:
- loader `({ documentId }) => select … where documentId = … order by rank`.
- every block mutation handler already loads the block (so it knows `documentId`)
  → call `blocksLiveResource.notify({ documentId })`.
- client `BlockEditor` (`…/web/components/block-editor.tsx`): subscribe
  `useResource(blocksResource, { documentId })` and **drop** the client-side
  `.filter(b => b.documentId === documentId)`.
- Debug harness keeps working (passes its own `documentId`).

### 1c. The `pages` app shell  (`plugins/apps/plugins/pages/plugins/shell`)
Clone Forge's shell verbatim:
- `web/slots.ts`: `Pages.Sidebar` / `Pages.Toolbar` (`AppShellSidebarItem` /
  toolbar item render slots).
- `web/components/pages-layout.tsx`:
  `<AppShellLayout sidebarSlot={Pages.Sidebar} toolbarSlot={Pages.Toolbar} />`.
- `web/index.ts`: `Apps.App({ id:"pages", icon: MdDescription, tooltip:"Pages",
  component: PagesLayout, path:"/pages" })`; `export { Pages } from "./slots"`.
- top-level `plugins/apps/plugins/pages/web/index.ts`: empty namespace plugin.

### 1d. Sidebar page-tree + panes  (`plugins/apps/plugins/pages/plugins/page-tree`)
- `web/panes.tsx`:
  - `pagesRootPane` — `segment:"pages"`, `chrome:false`, `width:320`, renders the
    sidebar tree body (or leave the tree purely in the sidebar slot and make root
    a welcome/empty pane — pick one; tree lives in the sidebar slot per Forge).
  - `pageDetailPane` — `defaultAncestors:[pagesRootPane]`, `segment:"page/:pageId"`
    (static prefix required), `chrome:{ title: <loaded page title> }`. Body:
    `<PageHeader pageId/>` (icon + inline title bound to `updateDocument` via
    `useEditableField`) + `<BlockEditor documentId={pageId} />` +
    `<PageDetail.Section.Render>` (extensible section host, e.g. backlinks).
- `web/components/pages-sidebar.tsx`: `<SidebarPaneSection title="Pages">` wrapping
  `<TreeList>` (`@plugins/primitives/plugins/tree/web`) fed by `documentsResource`:
  - `rows` = documents (already `{id,parentId,rank,expanded}`),
  - `onSelect` → `openPane(pageDetailPane,{pageId},{mode:"push"})`,
  - `onToggleExpanded` → `updateDocument({id,expanded})`,
  - `onMove` → `updateDocument({id,parentId,rank})` (DnD reparent/reorder; rank via
    `computeDrop` from the tree primitive),
  - `onCreate` → `createDocument({parentId,rank})` then open the new page,
  - `Row` = `PageRow` (icon + title + hover actions: add child, rename, delete),
    selection via `pageDetailPane.useChainEntry()?.params.pageId`.
  - `addLabel:"New Page"`, `toolbar:{ search:{ accessor:(r)=>r.title } }`.
- Delete (`PageRow` action) → `deleteDocument` (FK-cascades blocks **and** child
  pages + `page_links`). **Subtree delete is destructive → confirm dialog.**
- `web/index.ts` contributes `Pane.Register(pagesRootPane)`,
  `Pane.Register(pageDetailPane)`, and `Pages.Sidebar({ component: PagesSidebar })`.

Deliverable: a Pages app in the rail with a nested sidebar tree; create / rename /
reparent / delete / open all work; each page is a real `<BlockEditor>`.

---

## Phase 2 — Cross-page links (link-to-page block + backlinks)

### 2a. `page-link` block type  (`plugins/page/plugins/page-link`)
- `core`: `pageLinkBlock = defineBlock({ type:"page-link", schema:{ pageId:string } })`.
- `web`: `Editor.Block({ match:"page-link", block: pageLinkBlock, component: PageLinkBlock })`.
  Renderer shows the target page's icon+title (from `documentsResource`) as a
  clickable row → `openPane(pageDetailPane,{pageId},{mode:"push"})`; an empty block
  opens a page picker (search `documentsResource`, optional "create new page").
- `server`: contribute `PageLinks.Extractor({ type:"page-link", extract:(d)=>[d.pageId] })`.

### 2b. Backlinks index  (`plugins/page/plugins/links`)
- `server/internal/tables.ts`: `page_links{ sourceDocumentId, targetDocumentId,
  PK(source,target) }`, both FK → `page_documents(id) onDelete cascade`.
- Server collection slot: `PageLinks = { Extractor: defineServerContribution<{
  type:string; extract:(data:unknown)=>string[] }>("page.links.extractor") }`.
  Consumers never name block types — the reindexer dispatches by `block.type` over
  `collectContributions(PageLinks.Extractor)` (collection-consumer separation).
- `reindexDocument(documentId)`: load the doc's blocks, run the matching extractor
  per block, dedupe targets (drop self + non-existent), diff against existing
  `page_links where source=documentId`, apply inserts/deletes, then
  `backlinksResource.notify({ pageId })` for every affected target (old ∪ new).
- Reactivity (push, no polling): the **editor** declares
  `defineTriggerEvent("page.blocksChanged",{documentId})` and emits it from each
  block mutation handler; the **links** plugin binds a job
  `trigger(blocksChanged, reindexJob)` (`@plugins/infra/plugins/events` +
  `…/jobs`). Editor depends only on `events` (infra) — not on `links`.
- `backlinksResource = defineResource<BacklinkRow[], {pageId}>({
  key:"page-backlinks", mode:"push", loader:({pageId}) => select source docs where
  target=pageId join documents })`.
- `web`: `<Backlinks documentId>` lists referencing pages (title+icon, click →
  open pane); contributed into `PageDetail.Section` (defined by `page-tree`) so the
  page-detail pane shows a "Linked from" section with zero coupling.

Deliverable: insert a "link to page" block → it renders as a clickable chip and the
target page's detail shows a backlinks section, updated live on edit.

---

## Phase 3 — Inline `@`-mentions (text-block refactor)

The page text block is a bespoke `PlainTextPlugin` composer. To host an inline
mention chip it must (a) include contributed Lexical nodes and (b) serialize them
back into its plain `data.text` string.

- Generalize the text block (`plugins/page/plugins/text`) to drive the existing
  node-extension registry already shipped by the text-editor primitive
  (`registerNodeExtension`/`getNodeExtensions`,
  `plugins/primitives/plugins/text-editor/web/internal/node-extensions.ts` +
  `…/markdown.ts`): put `getNodeExtensions().map(e=>e.node)` in `initialConfig.nodes`
  and route `ValueSyncPlugin` through the shared serialize/deserialize so inline
  nodes round-trip as text tokens (e.g. `[[page-id]]`). Keep the custom
  `KeyboardPlugin` cross-block split/merge/indent semantics unchanged.
- `plugins/page/plugins/mention`:
  - `registerNodeExtension({ node: PageMentionNode, deserializePattern:/\[\[([a-z0-9-]+)\]\]/g,
    serializeNode → "[[id]]", createNodeFromMatch })`. `PageMentionNode` is an
    inline `DecoratorNode` (clone `paste-images`' `ImageNode`) storing `pageId`;
    `decorate()` renders a chip (title from `documentsResource`) → `openPane`.
  - an `@`-typeahead plugin contributed into the text block's plugin slot: on `@`
    show a page picker (search `documentsResource`, optionally create a new page),
    insert the mention node.
  - `server`: `PageLinks.Extractor({ type:"text", extract:(d)=>parse [[id]] from d.text })`
    so mentions feed the same backlinks index built in Phase 2.
- Optional cross-surface nicety: a `ActiveData.Tag` inline contribution
  (`display:"inline"`, pattern `[[id]]`) so mention chips also render inside any
  `<Markdown>` (assistant text, notes, etc.) with zero per-host wiring.

Deliverable: type `@`, pick a page, get an inline clickable chip that also shows up
in the target's backlinks.

---

## Reused primitives (do not reinvent)

| Need | Reuse |
|------|-------|
| App rail entry + shell | `Apps.App`, `AppShellLayout`, `SidebarPaneSection`, `sidebarNavItem` |
| Sidebar tree (DnD, search, create) | `@plugins/primitives/plugins/tree/web` `TreeList`, `buildTree`, `computeDrop` |
| Ordering | `@plugins/primitives/plugins/rank` `nextRankUnder` / `rankText` |
| Panes + routing + nav | `Pane.define` / `Pane.Register` / `useOpenPane` |
| Inline title rename | `@plugins/primitives/plugins/editable-field/web` `useEditableField` |
| Per-document live blocks + backlinks | parameterized `defineResource` (+ `dependsOn`) |
| Per-block-type link extractors | `defineServerContribution` + `collectContributions` |
| Reactive reindex (no polling) | `@plugins/infra/plugins/events` `defineTriggerEvent` + `…/jobs` `trigger` |
| Inline mention node (Phase 3) | `text-editor` `registerNodeExtension` + `paste-images` `ImageNode` template |
| Extensible page-detail sections | `defineRenderSlot` (`PageDetail.Section`), mirrors `TaskDetail.Section` |

## Critical files

- Modify: `plugins/page/plugins/editor/server/internal/{tables,resources}.ts`,
  `…/editor/core/{schemas,endpoints,resources}.ts`,
  `…/editor/server/internal/handle-*.ts` (notify params + blocksChanged emit),
  `…/editor/web/components/block-editor.tsx` (param subscribe).
- New: `plugins/apps/plugins/pages/**`, `plugins/page/plugins/page-link/**`,
  `plugins/page/plugins/links/**`, (Phase 3) `plugins/page/plugins/mention/**` +
  `plugins/page/plugins/text/server/**`.

## Risks / notes
- **Per-document resource migration** touches all block mutation handlers — mechanical
  but every handler must `notify({documentId})`. Verify `useResource(resource, params)`
  client signature (live-state web) before wiring.
- **Subtree delete is destructive** (FK cascade through child pages, blocks, links) —
  gate behind a confirm dialog; consider a future "trash" instead of hard delete.
- **Terminology**: code keeps `document`; UI says "Page". Keep consistent labels.
- `pageDetailPane` segment must have a static prefix (`page/:pageId`), not bare `:id`.

## Verification
1. `./equin build` (first build after schema change needs
   `--migration-name pages_tree`).
2. Open `http://att-1780504206-2hsa.localhost:9000/pages`.
3. Phase 1: create a page, rename, create a sub-page (nesting), drag to reparent,
   collapse/expand, type text blocks, reload (persisted), delete (confirm cascade).
4. Phase 2: add a "link to page" block → click navigates; open the target → its
   backlinks section lists the source; edit/remove the link → backlinks update live.
5. Phase 3: type `@`, pick a page → inline chip; verify it also appears in backlinks.
6. Scripted check with `e2e/screenshot.mjs` (`--click`/`--out`) for create + link +
   backlink flows. Confirm `blocksResource` only pushes the open page's blocks
   (debug resource endpoint `/api/resources/_debug` or `query_db`).
```
