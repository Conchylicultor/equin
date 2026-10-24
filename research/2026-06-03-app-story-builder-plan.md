# Story Builder — Implementation Plan (v1)

> Companion to the vision doc: [`2026-06-03-app-story-builder-vision.md`](./2026-06-03-app-story-builder-vision.md).

## Context

Story Builder (`/story`) lets you author a story as a nested block tree, then
**render the same tree through pluggable renderers** (v1: Slides + Blog),
edit-left / preview-right, live. The story tree is the artifact; renderers are
views. Adding a renderer must require **zero core changes** — that is the whole
product thesis.

Two existing pieces make this mostly an *assembly* job, not a from-scratch build:

1. **The "Author" half already exists.** `plugins/page/plugins/editor` is a
   block-tree editor (`<BlockEditor documentId={…} />`) with arbitrary-depth
   ordered nesting (flat table + `parent_id` + fractional `rank`), live data via
   `useResource(blocksResource)`, and an extensible block-type slot
   (`Editor.Block`). A "story" **is** a page document. v1 block type: `text`.
2. **Sonata is the precedent for the "Render" half.** `Sonata.Display` is a
   `defineDispatchSlot` keyed by active id with enumerable `{id,label,icon}`
   metadata so a picker lists renderers without naming any — the exact analog of
   `Story.Renderer`. Sonata also layers a **pure IR leaf plugin** (`score`) that
   views consume; Story mirrors this with `story-core`.

This is also a deliberate **create-app case study**: we keep a running build log
capturing each decision and every error/boundary-check failure, so the
new-app *process* becomes a documented artifact.

### Confirmed decisions (from the user)
- **Reuse `page/editor` in place** (improvements fair game; the live-resource
  broadcast inefficiency — see below — is a *separate* task, not in scope here).
- **Clean boundaries for eventual separate deployment**: depend only on
  framework primitives + the explicitly-reused page `editor`/`text` barrels.
- **v1 renderers: Slides + Blog.**

## Architecture

Layered exactly like Sonata (`score` ← sources, → displays):

```
story-core         pure StoryNode tree IR + buildStoryTree adapter  (leaf, core-only, no React)
   ↑ produced by                                       consumed by ↓
BlockEditor (reused)                              Story.Renderer slot
+ document CRUD (reused)                            ├── slides  (sub-plugin)
                                                    └── blog    (sub-plugin)
                                            leaf content via ↓
                                          Story.Content slot (read-only, keyed by block type)
                                            └── text-content (imports textBlock)
```

**The central seam.** `block.data` is typed `unknown`; only a per-type
`BlockHandle.parse` interprets it, and there is no central runtime handle
registry. Renderers must turn a node into displayable content **without
hardcoding block types**. We solve this with a second dispatch slot:

- **Renderers decide _structure only_** (what's a slide / heading level / page
  break) — derived purely from tree `depth` in v1.
- **Leaf content is delegated** to `<Story.Content.Dispatch node={…} />`, a
  **read-only** dispatch slot keyed by block type. A `text` content renderer is
  contributed once. A new block type ⇒ one new `Story.Content` contribution and
  **zero renderer changes**.

Why not the obvious alternatives:
- *Reuse `Editor.Block.Dispatch` for preview* — rejected. Its `BlockRendererProps`
  carries a mutation `editor: BlockEditorAPI`, and `TextBlock` mounts a full
  editable Lexical composer requiring `BlockEditorProvider`. That's an editor,
  not a view; a preview pane must not mount N editable contenteditables.
- *Renderers import block handles directly* — rejected as primary path: every
  renderer would `switch(node.type)` and `import { textBlock }`, breaking the
  "new block type = zero renderer changes" invariant.

## Plugin tree (`plugins/apps/plugins/story/`)

```
story/                                 # EMPTY namespace plugin (package.json only, "collapsed": true)
  plugins/
    story-core/                        # pure IR leaf (analog of sonata `score`); core/ ONLY, no index.ts
      core/{index,types,build-story-tree}.ts
    shell/                             # owns /story route, layout, defines Story.* slots, StoryProvider
      web/
        index.ts                       # contributes Apps.App; exports { Story } slots + context
        slots.ts                       # Story.Renderer (dispatch), Story.Content (dispatch)
        context.tsx                    # StoryProvider/useStory: activeDocumentId, activeRendererId, derived story
        components/{story-layout,story-picker,picker,no-renderer,unknown-content}.tsx
    renderers/                         # umbrella, "collapsed"
      plugins/
        slides/web/{index.ts,components/slides-renderer.tsx}
        blog/web/{index.ts,components/blog-renderer.tsx}
    content/                           # umbrella, "collapsed"
      plugins/
        text-content/web/{index.ts,components/text-content.tsx}
```

`package.json` names: `@singularity/plugin-apps-story[-<sub>]`. Top-level +
`renderers` + `content` umbrellas get `"singularity": { "collapsed": true }`.
`story-core` mirrors `score`'s package.json (no `collapsed`). Only plugins with
a `web/index.ts` (shell, slides, blog, text-content) auto-register via codegen on
`./equin build`; the namespace + umbrellas + `story-core` have no
`index.ts` and are consumed by import path.

## `story-core` (pure core, no React)

It lives in `core` because `buildStoryTree` only normalizes **structure** — it
does **not** parse `block.data` (which would need per-type handles). The web
shell calls `useResource(blocksResource)` then hands the plain `Block[]` to this
pure function.

`core/types.ts`:
```ts
export interface StoryNode {
  id: string;
  type: string;       // block.type — the Story.Content dispatch key
  data: unknown;      // opaque; only a per-type Story.Content renderer interprets it
  depth: number;      // 0 = top level; renderers map depth → structure
  index: number;      // 0-based sibling index
  children: StoryNode[];
}
```

`core/build-story-tree.ts` — `buildStoryTree(blocks: readonly Block[], documentId: string): StoryNode[]`:
filter by `documentId` → `.sort(Rank.compare)` → `buildTree` → recurse stamping
`depth`/`index`. Mirrors the editor's own sort/flatten
(`editor/web/components/block-editor.tsx:79-85`) so structure matches the editor.

Imports (all permitted runtime barrels): `@plugins/primitives/plugins/rank/core`
(`Rank`), `@plugins/primitives/plugins/tree/core` (`buildTree`, `TreeNode`),
`@plugins/page/plugins/editor/core` (type `Block` only).

## Slots (`shell/web/slots.ts`)

```ts
export const Story = {
  // Renderer picker seam (analog of Sonata.Display)
  Renderer: defineDispatchSlot<
    { story: StoryNode[]; activeRendererId: string }, string,
    { id: string; label: string; icon?: IconType }
  >("story.renderer", { key: (p) => p.activeRendererId, fallback: NoRenderer, docLabel: (c) => c.label }),

  // Read-only per-block-type leaf content (read-only analog of Editor.Block; NO editor API)
  Content: defineDispatchSlot<{ node: StoryNode }, string>(
    "story.content", { key: (p) => p.node.type, fallback: UnknownContent }),
};
```
- `Story.Renderer` contributed by `slides`, `blog`. Enumerated for the picker via
  `Story.Renderer.useContributions()` (reads `Extra`; `component` stays sealed).
  **`match` must equal `id`** (sonata convention) so the picker's selected id is
  the dispatch key.
- `Story.Content` contributed by `text-content`.

## Shell layout

`context.tsx` — `StoryProvider` holds `activeDocumentId`, `activeRendererId`;
calls `useResource(blocksResource)` and `useMemo`s
`buildStoryTree(result.data, activeDocumentId)` (guard `result.pending`). Default
renderer = first `Story.Renderer.useContributions()[0]?.id` (same defaulting as
`sonata-layout.tsx:77`). Live preview is free: `blocksResource` pushes on every
edit, re-deriving `story` and re-rendering the active renderer.

`story-layout.tsx` (mirrors `sonata-layout.tsx` shape):
```tsx
<div className="flex h-full min-h-0 flex-col …">
  <div className="flex items-center gap-x-6 border-b px-6 py-3">       {/* toolbar */}
    <StoryPicker activeId={activeDocumentId} onSelect={setActiveDocument} />
    <div className="ml-auto flex items-center gap-2">
      <span>View</span>
      <Picker items={renderers.map(r=>({id:r.id,label:r.label,icon:r.icon}))}
              activeId={effectiveRendererId} onSelect={setActiveRenderer} empty="No renderers" />
    </div>
  </div>
  <div className="flex min-h-0 flex-1">
    <div className="w-1/2 overflow-auto border-r">
      {activeDocumentId ? <BlockEditor documentId={activeDocumentId} /> : <Empty>Select or create a story</Empty>}
    </div>
    <div className="w-1/2 overflow-auto">
      {effectiveRendererId && activeDocumentId
        ? <Story.Renderer.Dispatch story={story} activeRendererId={effectiveRendererId} />
        : <Empty>No preview</Empty>}
    </div>
  </div>
</div>
```
- `StoryPicker` is **new** (page/editor has no document picker — confirmed):
  `useResource(documentsResource)` for the live list; "+" calls
  `fetchEndpoint(createDocument, {}, {body:{}})` then `setActiveDocument(doc.id)`;
  delete affordance calls `deleteDocument`.
- `Picker` is **copied** (~40 lines from `sonata-layout.tsx:11-54`) into the
  shell — it's unexported there, and importing across apps is a boundary
  violation. Factoring it into a shared primitive is out of scope for v1.

## Renderers

Both receive `{ story: StoryNode[] }`, render structure from `depth`, and
delegate leaf content to `<Story.Content.Dispatch node={…} />`. Neither imports
any block handle.
- **Slides** (`renderers/plugins/slides`): depth-0 nodes = slides (16:9 card,
  prev/next local state). Slide's own content = title/lead; `children` =
  bullets, deeper descendants indented.
- **Blog** (`renderers/plugins/blog`): one continuous article; `depth` → heading
  level (0 = section heading, deeper = sub-heading/paragraph). Recurse the
  forest; each node = wrapper + `Story.Content.Dispatch`, then its children.

`content/plugins/text-content/components/text-content.tsx` — the only place
`textBlock` is imported, from the **core** barrel (no Lexical pulled in):
```tsx
import { textBlock } from "@plugins/page/plugins/text/core";
export function TextContent({ node }: { node: StoryNode }) {
  const { text } = textBlock.parse(node.data);   // defensive parse of unknown
  return <span>{text}</span>;
}
```

## Cross-plugin imports (boundary-checked — runtime barrels only)

- **story-core/core** → `primitives/rank/core`, `primitives/tree/core`,
  `page/editor/core` (type `Block`).
- **shell/web** → `web-sdk/core` (PluginDefinition), `apps/web` (Apps),
  `primitives/slot-render/web` (defineDispatchSlot), `primitives/live-state/web`
  (useResource), `infra/endpoints/web` (fetchEndpoint), `page/editor/web`
  (BlockEditor), `page/editor/core` (resources + document CRUD + types),
  `story-core/core`.
- **slides/web**, **blog/web** → `web-sdk/core`, `story/shell/web` (Story),
  `story-core/core` (type). **No block-plugin import.**
- **text-content/web** → `web-sdk/core`, `story/shell/web` (Story),
  `story-core/core` (type), `page/text/core` (`textBlock`) — the only
  block-handle coupling, isolated to this one contribution.

## Critical files (reference / reuse)
- `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts` — slot patterns to mirror.
- `plugins/apps/plugins/sonata/plugins/shell/web/components/sonata-layout.tsx` — layout, `Picker` (copy), dispatch enumeration, Provider mount.
- `plugins/page/plugins/editor/core/index.ts` — `documentsResource`, `blocksResource`, document CRUD, `Block`/`Document` types.
- `plugins/page/plugins/text/core/index.ts` — `textBlock` (imported only by text-content).
- `plugins/primitives/plugins/tree/core/internal/tree.ts` — `buildTree`/`TreeNode`.

## Gotchas / risks
- **`useResource` requires `NotificationsProvider`** above it (throws otherwise).
  App rail is app-global and already mounts it (sonata relies on the same);
  confirm on first load.
- **Two contributions per block type** going forward: an `Editor.Block` (edit) +
  a `Story.Content` (view). Inherent to separating edit from view — document in
  the shell's CLAUDE.md.
- **Defensive parse** in `Story.Content` renderers: `textBlock.parse` may throw on
  transient/empty data; the slot-render item error boundary contains it to one
  leaf, but prefer a safe-parse fallback to avoid a visible boundary while typing.
- **Picker / `match===id`** must stay in lockstep in slides/blog contributions.
- **Out of scope (separate task):** `blocksResource` is keyed `"page-blocks"` in
  push mode and broadcasts *all* blocks for *all* documents to *every* client on
  every edit (client filters by `documentId`). O(total blocks) per edit; fine for
  v1, should later be scoped per-document.

## Build & verify
1. `./equin build` (from the worktree) — codegen auto-registers the four
   `web/index.ts` plugins; applies no migrations (we reuse `page` tables).
2. Screenshot `http://<worktree>.localhost:9000/story` (Playwright helper
   `e2e/screenshot.mjs`).
3. Manual loop: confirm the `/story` rail icon; create a story; type text blocks
   in the left editor; toggle **Slides** ↔ **Blog** on the right; confirm the
   preview updates **live** as you type; `Tab` to nest a block and confirm Slides
   treats depth-1 as a bullet and Blog as a sub-heading/paragraph.
4. `./equin check --plugin-boundaries` to confirm clean boundaries.

## Process / case-study track
Keep a running **build log** at
`research/2026-06-03-story-builder-build-log.md`: one entry per implementation
step capturing the decision taken, any boundary-check or build failure, the fix,
and "the precedent did X so I did X" notes — so the create-app process itself is
documented for the next app.

## Implementation order
1. Scaffold namespace + `story-core` (IR + adapter). Build (no UI yet).
2. `shell`: slots + context + layout + StoryPicker + copied Picker + `Apps.App`.
   Build → `/story` shows editor left, "No renderers" right.
3. `content/text-content`. 4. `renderers/slides`. 5. `renderers/blog`.
   Build after each → renderer appears in picker with zero shell changes (proof
   of the extensibility thesis).
6. Boundary check + screenshot verification + build-log finalize.
