# Story Builder — Implementation Plan (v2)

> Supersedes [`2026-06-03-app-story-builder-plan.md`](./2026-06-03-app-story-builder-plan.md).
> Companion to the vision doc [`2026-06-03-app-story-builder-vision.md`](./2026-06-03-app-story-builder-vision.md).
> v2 rewrites the plan after (a) a rebase that turned `page/editor` into a
> Notion-grade editor with a page-as-block model, and (b) a UX discussion that
> reframed a "story" as an **opt-in capability layered onto any page**, not a
> separate entity.

## Context

Story Builder (`/story`) lets you author a story as a nested block tree and
**render the same tree through pluggable renderers** (v1: Slides + Blog),
edit-left / preview-right, live. The tree is the artifact; renderers are views.
Adding a renderer must require **zero core changes** — that is the product thesis.

This is also a deliberate **create-app case study**: a running build log captures
each decision and every error/boundary-check failure, so the new-app *process*
becomes a documented artifact (see "Process track").

### What the rebase changed (use these, don't rebuild)
- `page/editor` is now a full Notion-grade editor: `/` slash menu, markdown
  shortcuts (`- ` bullet, `> ` toggle, ` ``` ` code, `[] ` to-do), Tab/Shift-Tab
  nesting, drag-to-reorder, multi-select + copy/paste, "turn into". 7 block types
  (text, bulleted-list, to-do, toggle, code-block, image, page-link).
- **A page IS a block** of `type:"page"` carrying `{title,icon}`
  (`PAGE_BLOCK_TYPE`, `pageData()` in `editor/core/schemas.ts`). Created via the
  generic `createBlock`. No separate document entity.
- `BlockEditor` props are now `{ pageId, onOpenPage? }`
  (`editor/web/components/block-editor.tsx:85`).
- `blocksResource` is **scoped per page** (`{ pageId }`,
  `editor/core/resources.ts:15`) — the old all-blocks broadcast is gone, so live
  split-preview is cheap and correct.
- A Notion-like **`pages` app** now exists
  (`plugins/apps/plugins/pages`) with `PageDetail.Section` and
  `PageTree.RowActions` contribution slots we plug into.

## Core model: a story is an *upgraded page*

Story-ness is an opt-in capability, not a storage namespace:
- A story is a normal page (block `type:"page"`), so we reuse the **entire** block
  editor for authoring — zero editor changes.
- The Story plugin owns a `page_blocks_ext_story` side-table via the
  **entity-extensions** primitive (`defineExtension(_blocks, "story", {...})`,
  `entity-extensions/server/internal/define-extension.ts:83`). Marking a page
  upgrades it; the marker stores story metadata (e.g. default renderer).
- The Story app contributes an **"Upgrade to story"** action + an embedded story
  view into the existing Pages app via its public slots — **Pages app untouched**.
- Only upgraded pages surface as stories (in the Story gallery / with renderers),
  so Pages and Story content don't intermingle. Shared substrate, scoped views.

This honors the vision ("everything is composable blocks; renderers are lenses")
*and* keeps Story Builder a focused, separately-deployable app.

## Architecture (layered DAG)

```
story-core (core)   StoryNode IR + buildStoryTree + structural "break" role     ← leaf
   ▲ produced from blocks                              consumed by ▼
render (web)        OWNS Story.Renderer + Story.Content slots; <StoryRender pageId rendererId/>
   ▲                          ├── renderers/slides   (Story.Renderer)
   │                          ├── renderers/blog     (Story.Renderer)
   │                          └── content/{text,image,code} (Story.Content) + visible fallback
marker (web+server) story entity-extension; storiesResource; useIsStory; set/clear
pages-integration (web)  PageTree.RowActions "Upgrade to story" + PageDetail.Section embedded view
shell (web)         /story app: Apps.App + gallery + focused editor (Author/Slides/Blog switcher + split)
```
`render` owns the slots; `renderers`/`content`/`shell`/`pages-integration` import
it; `marker` attaches to the editor table; nobody imports Pages/editor internals.
No cycles.

## Plugin tree

```
plugins/page/plugins/divider/                  # NEW generic block type (see "Divider")
  core/{index,divider-block}.ts                # defineBlock + DIVIDER_TYPE const
  web/{index.ts, components/divider-block.tsx} # Editor.Block "divider", '---' markdown prefix, "Divider" slash label

plugins/apps/plugins/story/                    # empty namespace, "collapsed": true
  plugins/
    story-core/   core/{index,types,build-story-tree}.ts
    render/       web/{index.ts, slots.ts, components/{story-render,renderer-picker,unsupported-content}.tsx}
    renderers/    (umbrella, "collapsed")
      slides/     web/{index.ts, components/slides-renderer.tsx}
      blog/       web/{index.ts, components/blog-renderer.tsx}
    content/      (umbrella, "collapsed")
      text/       web/{index.ts, components/text-content.tsx}
      image/      web/{index.ts, components/image-content.tsx}
      code/       web/{index.ts, components/code-content.tsx}
    marker/       core/{index,schema}.ts  server/{index.ts, internal/{tables,resource}.ts, endpoints.ts}  web/{index.ts, hooks.ts}
    pages-integration/ web/{index.ts, components/{upgrade-action,story-section}.tsx}
    shell/        web/{index.ts, components/{story-layout,story-gallery,story-editor,story-header}.tsx, panes.tsx}
```
Only plugins with a `web/index.ts`/`server/index.ts` auto-register on
`./equin build`. Namespace + umbrellas + `story-core` have none.

## `story-core` (pure core, no React)

```ts
// types.ts
export type StoryRole = "content" | "break";   // "break" = a divider; renderers split/hr on it
export interface StoryNode {
  id: string; type: string; data: unknown;
  role: StoryRole; depth: number; index: number;
  children: StoryNode[];
}
// build-story-tree.ts
export function buildStoryTree(blocks: readonly Block[], pageId: string): StoryNode[]
//   filter pageId → sort Rank.compare → buildTree → recurse stamping depth/index/role
//   role = (type === DIVIDER_TYPE) ? "break" : "content"
```
`story-core` is the *single* place allowed to map block types → IR roles, so
renderers stay type-agnostic (they read `node.role`, never name "divider").
Imports: `primitives/rank/core`, `primitives/tree/core`, `page/editor/core`
(type `Block`), `page/divider/core` (`DIVIDER_TYPE`).

## `render` — slots + reusable render surface

```ts
// slots.ts
export const Story = {
  Renderer: defineDispatchSlot<
    { story: StoryNode[]; activeRendererId: string }, string,
    { id: string; label: string; icon?: IconType }
  >("story.renderer", { key: (p) => p.activeRendererId, fallback: NoRenderer, docLabel: (c) => c.label }),
  Content: defineDispatchSlot<{ node: StoryNode }, string>(
    "story.content", { key: (p) => p.node.type, fallback: UnsupportedContent }),
};
```
- `Story.Renderer` — contributed by slides/blog; enumerated for the picker via
  `.useContributions()` (reads `{id,label,icon}`; `component` sealed). **`match`
  must equal `id`** (sonata convention).
- `Story.Content` — contributed by text/image/code. Fallback
  `UnsupportedContent` renders a **visible** muted placeholder
  ("⛔ <type> — not shown in this view"); never hides content (fail-loud).
- `<StoryRender pageId rendererId/>` — subscribes `useResource(blocksResource,{pageId})`,
  `buildStoryTree`, then `<Story.Renderer.Dispatch/>`. Reusable by both the app
  editor and the Pages embedded section, parameterized only by `pageId`.

## Renderers

Both receive `{ story: StoryNode[] }`, render structure from `depth`+`role`, and
delegate leaf content to `<Story.Content.Dispatch node={…} />`. Neither imports a
block handle.
- **Slides** — if the story has any top-level `role:"break"` node, slides = the
  groups *between* breaks; otherwise each top-level node = a slide. A slide's own
  content + its children (bullets, indented descendants) via `Story.Content`.
  Local prev/next state, 16:9 surface.
- **Blog** — one continuous article; `depth` → heading level (0 = section heading,
  deeper = sub-heading/paragraph); `role:"break"` → `<hr>`. Recurse the forest.

## Content renderers (v1: text, image, code)

Each contributes `Story.Content` keyed by type; imports only that block's **core**
handle (no editor/Lexical pulled in):
- `text` → `textBlock.parse(node.data).text` (`page/text/core`).
- `image` → `imageBlock` payload `{attachmentId,width,alt}`; serve via attachments.
- `code` → `codeBlock` payload `{code,language}`; render with the
  `primitives/syntax-highlight` `<HighlightedCode>`.
Everything else (bullet/to-do/toggle/page-link) → the visible `UnsupportedContent`
fallback. (Bullet/to-do/toggle share the `{text}` payload, so they're a near-free
follow-up if we later want them rendered.)

## `marker` — the story capability

- **server**: `export const storyMark = defineExtension(_blocks, "story", { defaultRendererId: text(...) /* nullable */ })`
  (`_blocks` from `@plugins/page/plugins/editor/server`). A push
  `storiesResource` loading all ext rows (mirror
  `auto-start/server/internal/resource.ts:7`). `set`/`clear` endpoints calling
  `storyMark.upsert/delete` then `storiesResource.notify()`.
- **web**: `useIsStory(pageId)` and `useStories()` (filter `storiesResource` by
  `parentId`, mirror `auto-start/web/hooks.ts:4`); `markStory`/`unmarkStory`
  mutations.

## `pages-integration` — contribute into the Pages app (no Pages changes)

Imports `PageTree`/`PageDetail` from
`@plugins/apps/plugins/pages/plugins/page-tree/web` and `marker`/`render`:
- `PageTree.RowActions({ id:"story", component: UpgradeAction })` — toggles the
  story marker on a page (`{pageId,title}`).
- `PageDetail.Section({ id:"story", component: StorySection })` — when the page is
  a story: an inline `<StoryRender pageId rendererId/>` preview + a
  `<RendererPicker/>` + "Open in Story Builder" link; when not: a subtle "Make
  this a story" button (calls `markStory`).

## `shell` — the `/story` app

`Apps.App({ id:"story", icon, tooltip:"Story", component: StoryLayout, path:"/story" })`.
Full-surface pane app (mirror sonata: mount `<FullPane/>` from
`@plugins/layouts/plugins/full-pane/web`) with two panes:
- **gallery pane** (`segment: ""`) — cards for pages that are story-marked
  (`useStories()` ∩ `pagesResource`, read title/icon via `pageData`). "New story"
  = `createBlock(type:page,{title,icon})` + seed empty text block (mirror
  `pages/.../internal/create-page-with-seed.ts:27`) + `markStory`. Card click →
  open editor pane. (v1 cards: title + relative time; renderer-driven thumbnails
  are a near-free follow-up once renderers exist.)
- **editor pane** (`segment: "s/:pageId"`) — `‹ Stories` back, editable
  `StoryHeader` (title via `updateBlock`, mirror `page-header.tsx:8`), the **view
  switcher** `[Author] Slides Blog` (+ split toggle). Author = `<BlockEditor
  pageId/>`; Slides/Blog = `<StoryRender pageId rendererId/>`; split pins Author
  beside the active renderer. View/split = internal state; renderer choice
  persists per story via the marker's `defaultRendererId`.

Copy the ~40-line `Picker` shape from `sonata-layout.tsx:11-54` for the view
switcher (unexported there; do not import across apps).

## Divider block (`plugins/page/plugins/divider/`)

Generic editor block (works in Pages too), not story-specific:
- `defineBlock({ type:"divider", schema: z.object({}) })`, export `DIVIDER_TYPE`.
- `Editor.Block({ match:"divider", block, component: DividerBlock, label:"Divider",
  markdownPrefixes:["---"] })` — mirror the non-text block structure of
  `code-block`/`image` (dedicated component, no `BlockTextEditor`). Renders a thin
  `<hr>`-style rule; selectable/deletable like any block.
- `story-core` maps it to `role:"break"`; renderers interpret (slide break / `<hr>`).

## Cross-plugin imports (boundary-checked — runtime barrels only)
- **divider/core** → `web-sdk/core`? no (core has none). `divider/web` →
  `web-sdk/core`, `page/editor/web` (Editor, BlockRendererProps).
- **story-core/core** → `primitives/rank/core`, `primitives/tree/core`,
  `page/editor/core` (type Block), `page/divider/core` (DIVIDER_TYPE).
- **render/web** → `web-sdk/core`, `primitives/slot-render/web`,
  `primitives/live-state/web`, `page/editor/core` (blocksResource), `story-core/core`.
- **renderers/{slides,blog}/web** → `web-sdk/core`, `story/render/web` (Story),
  `story-core/core`. No block-handle import.
- **content/{text,image,code}/web** → `web-sdk/core`, `story/render/web` (Story),
  `story-core/core`, and the one block core (`page/text/core` | `page/image/core`
  | `page/code-block/core`); code also `primitives/syntax-highlight/web`; image
  also the attachments serve URL helper.
- **marker/server** → `page/editor/server` (`_blocks`),
  `infra/entity-extensions/server`, `infra/endpoints/server`, `database` (db),
  `primitives/live-state/server`. **marker/web** → `primitives/live-state/web`,
  `infra/endpoints/web`, `marker/core`.
- **pages-integration/web** → `web-sdk/core`,
  `apps/plugins/pages/plugins/page-tree/web` (PageTree, PageDetail),
  `story/marker/web`, `story/render/web`.
- **shell/web** → `web-sdk/core`, `apps/web` (Apps),
  `layouts/plugins/full-pane/web` (FullPane), `primitives/pane/web`,
  `page/editor/web` (BlockEditor), `page/editor/core` (pagesResource, createBlock,
  updateBlock, pageData), `story/marker/web`, `story/render/web`, `story-core/core`.

## Critical files (reference / reuse)
- `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts:83` — `defineExtension`.
- `plugins/tasks/plugins/auto-start/server/internal/resource.ts:7`, `web/hooks.ts:4` — marker resource + hook pattern.
- `plugins/apps/plugins/pages/plugins/page-tree/web/slots.ts:9` (PageDetail/PageTree), `web/index.ts:26` (contributions), `components/{backlinks-section,delete-page-action}.tsx` — contribution precedents.
- `plugins/apps/plugins/pages/plugins/page-tree/web/internal/create-page-with-seed.ts:27`, `components/page-header.tsx:8` — create-with-seed + editable header patterns.
- `plugins/page/plugins/editor/{web/components/block-editor.tsx:85, core/resources.ts:15, core/schemas.ts}` — BlockEditor props, per-page resource, page model.
- `plugins/page/plugins/{code-block,image}` — non-text block structure to mirror for `divider`.
- `plugins/apps/plugins/sonata/plugins/shell/web/{slots.ts, components/sonata-layout.tsx}` — dispatch-slot + Picker + FullPane app shape.

## Gotchas / risks
- **Two contributions per block type going forward**: an `Editor.Block` (edit) and
  a `Story.Content` (view). Inherent to separating edit from view — document in
  the shell CLAUDE.md.
- **Defensive parse** in `Story.Content` renderers (`*.parse` may throw on
  transient/empty data); the slot-render item error boundary contains it to one
  leaf, but prefer a safe-parse fallback to avoid a visible boundary while typing.
- **`useResource` needs `NotificationsProvider`** above it; app-global, but confirm
  on first `/story` load.
- **Migration**: the `marker` side-table is the only new DB table; generated by
  `./equin build` (never `drizzle-kit` directly) and committed.
- **Renderer `match` === `id`** must stay in lockstep in slides/blog.

## Build & verify
1. `./equin build` — codegen registers the new `web`/`server` index plugins;
   applies the `page_blocks_ext_story` migration.
2. `./equin check --plugin-boundaries` (+ `--migrations-in-sync`).
3. Screenshot `http://<worktree>.localhost:9000/story` (`e2e/screenshot.mjs`).
4. Manual loop:
   - `/story` rail icon → gallery → "New story" → focused editor.
   - Type blocks; `/` insert image/code; `---` divider; Tab to nest.
   - Toggle Author ↔ Slides ↔ Blog; confirm divider splits slides / becomes `<hr>`;
     confirm an unsupported block shows the visible placeholder.
   - Split toggle: type left, preview reflows live right.
   - In the **Pages** app: a page's row → "Upgrade to story"; confirm it appears in
     the Story gallery and the page-detail "Story" section renders the preview.

## Process track (case study)
Running build log at `research/2026-06-09-story-builder-build-log.md`: one entry per
step — decision, any boundary/build failure, the fix, and precedent-mirroring
notes — so the create-app process is documented for the next app.

## Implementation order
1. `divider` block type (independent; verify it works in the Pages editor).
2. `story-core` (IR + adapter). 3. `render` (slots + `<StoryRender>` + fallback).
4. `content/text` → first end-to-end render. 5. `marker` (capability).
6. `shell` (gallery + editor + switcher). Build → full Author→Render loop on stories.
7. `renderers/slides` + `renderers/blog`. 8. `content/{image,code}`.
9. `pages-integration` ("upgrade" + embedded view).
10. Boundary/migration checks + screenshot verification + finalize build log.
Each renderer/content plugin added after the loop works = live proof that
extension is a zero-core-change sub-plugin.
```

## Rollout — self-contained landable sub-tasks

Each task is its own worktree/branch: builds green, passes `./equin check`,
and leaves `main` working. The slots (`render`) and capability (`marker`) are
inert-but-green alone; every renderer/content plugin is a pure additive
contribution — so almost everything after the shell ships independently.

```
T1 divider ──→ T3 render-substrate ─┐
                                     ├─→ T4 story-app-shell ─→ T5 first-lens ─┬─→ T6 blog
T2 marker ───────────────────────────┘           │                           ├─→ T7 image+code
                        └──────────────→ T8 pages-integration
```

- **T1 — Divider block** (`page/divider`). Deps: none. Generic editor block; demo
  `---` in any Pages page. Lowest risk, lands first. Parallel with T2.
- **T2 — Story marker** (`story/marker`). Deps: none. Entity-extension
  `page_blocks_ext_story` + `storiesResource` + set/clear endpoints +
  `useIsStory/useStories`. **Owns the only migration.** No UI; verify via endpoint
  + `query_db`. Parallel with T1.
- **T3 — Render substrate** (`story-core` + `render`). Deps: T1. IR + the two slots
  + `<StoryRender>` + visible `UnsupportedContent` fallback. Pure infra, no
  contributors yet (green but inert). *Bundled: render is meaningless without the
  IR; keeps T4 small.* (Optional: fold into T4 to avoid landing inert code.)
- **T4 — Story app shell** (`story/shell`). Deps: T2 + T3. `/story` gallery + focused
  editor (header + Author/Slides/Blog switcher + split). With no renderers yet,
  Slides/Blog show the "No renderer" fallback — author works end-to-end. First
  visible app.
- **T5 — First lens** (`content/text` + `renderers/slides`). Deps: T3 (compile) + T4
  (to demo). Makes Author→Slides real. The payoff.
- **T6 — Blog renderer** (`renderers/blog`). Deps: T5. Tiny additive PR.
- **T7 — Image + Code content** (`content/image`, `content/code`). Deps: T5. Two
  independent small adds (optionally two PRs).
- **T8 — Pages integration** (`pages-integration`). Deps: T2 + T3. "Upgrade to story"
  row action + embedded story section in the Pages page-detail.

**Parallelism:** T1 ∥ T2 immediately; after T4, {T5 then T6/T7} and T8 run
concurrently — each touches only its own plugin dir, no merge conflicts.
