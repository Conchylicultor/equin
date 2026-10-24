# Story Builder — App Shell (T4)

> Implements **T4 — Story app shell** from
> [`2026-06-03-app-story-builder-plan-v2.md`](./2026-06-03-app-story-builder-plan-v2.md)
> (see the "shell" section). Builds on the already-landed **T2 marker**
> (`story/marker`) and **T3 render-substrate** (`story-core` + `render`).

## Context

There is no place to browse or author stories. The render substrate (`story-core`
IR + `Story.Renderer`/`Story.Content` dispatch slots + `<StoryRender>`) and the
story capability marker (`storiesResource`, `useStories`/`useIsStory`,
`markStory`/`unmarkStory`) both exist but are inert — nothing mounts them.

T4 adds the **`/story` app**: a gallery of story-marked pages with a "New story"
action, plus a focused editor (editable title header + the reused `<BlockEditor>`
for authoring + a view switcher with optional split-preview). This is the first
user-visible Story Builder milestone — **authoring must work end-to-end**. No
renderer plugins exist yet, so the render views show the substrate's visible
"No renderer available" fallback; the switcher's renderer segments are generated
dynamically from `Story.Renderer.useContributions()` and will fill in
automatically (zero shell changes) as Slides/Blog land in T5/T6.

## Decision: the view switcher is fully dynamic (no hardcoded renderers)

The switcher is a single `SegmentedControl` whose options are a fixed leading
**Author** mode plus one segment **per `Story.Renderer` contribution** —
`[{ id: "author", label: "Author" }, ...Story.Renderer.useContributions()]`.
The shell never names "slides"/"blog" (collection-consumer clean — `Author` is a
generic editor mode, not a contributor id). With zero renderers today the control
shows only **Author**; the no-renderer fallback is reachable now via the
split-preview pane (which mounts `<StoryRender>` regardless of renderer count).
As renderer plugins register, their segments appear automatically.

## Plugin layout (one new sub-plugin)

```
plugins/apps/plugins/story/plugins/shell/
  package.json                          # @singularity/plugin-apps-story-shell
  web/
    index.ts                            # Apps.App({id:"story",…}) + Pane.Register ×2
    panes.tsx                           # storyGalleryPane, storyDetailPane, useStoryDetailResolve
    internal/create-story.ts            # create page block + seed text block + markStory → pageId
    components/
      story-layout.tsx                  # Apps.App component — mounts <FullPane/>
      story-gallery.tsx                 # gallery surface: cards + "New story"
      story-editor.tsx                  # editor surface: header + switcher + split + body
      story-header.tsx                  # editable title (mirrors page-header.tsx)
      story-view-switcher.tsx           # SegmentedControl [Author, …renderers] + split toggle
```

Only `web/index.ts` auto-registers on build. Panes live **in the shell** (unlike
sonata, which split them into `library` to break a `library → shell` cycle): the
shell imports editor/marker/render but nothing imports the shell back, so there is
no cycle. Add the sub-plugin name to no registry — codegen discovers it.

## `web/index.ts` — app + pane registration

Mirror `sonata/shell/web/index.ts:1` and `sonata/library/web/index.ts`:

```ts
import { Apps } from "@plugins/apps/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { MdAutoStories } from "react-icons/md";
import { StoryLayout } from "./components/story-layout";
import { storyGalleryPane, storyDetailPane } from "./panes";

export default {
  contributions: [
    Apps.App({ id: "story", icon: MdAutoStories, tooltip: "Story",
               component: StoryLayout, path: "/story" }),
    Pane.Register({ pane: storyGalleryPane }),
    Pane.Register({ pane: storyDetailPane }),
  ],
} satisfies PluginDefinition;
```

`StoryLayout` is self-contained (the framework passes no props) and just renders
`<FullPane/>` inside `h-full min-h-0` (mirror `sonata-layout.tsx`). No context
provider needed — there is no app-global state to share in T4.

## `panes.tsx` — gallery + editor panes

Mirror `sonata/library/web/panes.tsx:30`:

```ts
export const storyGalleryPane = Pane.define({
  id: "story-gallery", segment: "", appPath: "/story", chrome: false,
  component: StoryGallery,
});
export const storyDetailPane = Pane.define({
  id: "story-detail", segment: "s/:pageId", chrome: false,
  input: type<{ title: string }>(),
  resolve: useStoryDetailResolve,          // required — segment has :pageId
  component: StoryEditor,
});
```

`useStoryDetailResolve({ pageId })` — gate on the page existing (mirror
`useSonataPlayerResolve`): read `useResource(pagesResource)`, `found = !pending &&
data.some(p => p.id === pageId)`, `pending = result.pending`. No async hydration
needed (blocks load lazily inside `<BlockEditor>`/`<StoryRender>`).

Navigation: open from a card with
`openPane(storyDetailPane, { pageId }, { mode: "root", input: { title } })`;
the editor's `‹ Stories` back button calls `clearRoute()` (empty route → gallery,
also restores a deep-linked `/story/s/:id`).

## `internal/create-story.ts` — new story recipe

`createPageWithSeed` lives in pages' **internal** dir (not a barrel), so replicate
it here (mirror `pages/.../internal/create-page-with-seed.ts:7`), adding the
marker step:

```ts
export async function createStory(): Promise<string> {
  const page = await fetchEndpoint(createBlock, {}, {
    body: { parentId: null, type: PAGE_BLOCK_TYPE, data: { title: "", icon: null } },
  });
  await fetchEndpoint(createBlock, {}, {
    body: { parentId: page.id, type: textBlock.type, data: textBlock.schema.parse({ text: "" }) },
  });
  await markStory(page.id);          // upgrade the page → it surfaces in the gallery
  return page.id;
}
```

Imports: `createBlock, PAGE_BLOCK_TYPE` (`page/editor/core`), `textBlock`
(`page/text/core`), `fetchEndpoint` (`infra/endpoints/web`), `markStory`
(`story/marker/web`).

## `story-gallery.tsx` — gallery surface

- Data: `useStories()` → `StoryMark[]`; `useResource(pagesResource)` → `Block[]`.
  For each mark, `find` its page by `id`; **skip marks whose page is missing**
  (fail-safe, no crash). Read `pageData(page)` → `{ title, icon, iconSvgNodes }`.
- Cards (v1: title + relative time + page icon): render via `Text`
  (`primitives/text/web`) and `PageIcon` (`page/editor/web`),
  `formatRelativeTime(page.updatedAt)` (`primitives/relative-time/web`). Click →
  `openPane(storyDetailPane, { pageId: page.id }, { mode: "root", input: { title } })`.
- "New story" action button → `const id = await createStory();
  openPane(storyDetailPane, { pageId: id }, { mode: "root", input: { title: "" } })`.
- Empty state: a muted `Text` placeholder when no stories yet.
- Use the `Row` primitive (`primitives/row/web`) or a simple grid; keep all
  typography in `Text` to satisfy the `no-adhoc-typography` lint.

## `story-editor.tsx` — focused editor surface

Owns all view state (per the plan: view/split are internal; renderer choice
persists via the marker). Layout `flex h-full min-h-0 flex-col`:

1. Top bar: `‹ Stories` button (`clearRoute()`), `<StoryHeader pageId/>`,
   `<StoryViewSwitcher .../>` (right-aligned).
2. Body (`flex-1 min-h-0`):
   - `view === "author"` & no split → `<BlockEditor pageId/>` in a scroll container.
   - `view === <rendererId>` & no split → `<StoryRender pageId rendererId={view}/>`.
   - split on → two columns: `<BlockEditor pageId/>` | `<StoryRender pageId
     rendererId={activeRendererId}/>`.

State:
- `view: string` (default `"author"`), `split: boolean` (default `false`).
- `activeRendererId` = `view !== "author" ? view : (defaultRendererId ?? "")`.
  `""` matches no contribution → `StoryRender` shows the `NoRenderer` fallback.
- Persist renderer choice: when `view` is set to a renderer id, call
  `markStory(pageId, rendererId)` to store `defaultRendererId`; read it back from
  `useStories().find(m => m.pageId === pageId)?.defaultRendererId ?? null`.
- `pageId` from `storyDetailPane.useParams()`.

`<BlockEditor>` props are `{ pageId, onOpenPage? }`
(`editor/web/components/block-editor.tsx:85`); `onOpenPage` can be omitted in T4
(no in-story page navigation yet).

## `story-header.tsx` — editable title

Mirror `pages/.../components/page-header.tsx:8` but title-only (the icon-button is
a Pages-internal component we don't import): `useResource(pagesResource)` → find
page → `pageData(page)`; `useEditableField({ value: data?.title ?? "", onSave })`
(`primitives/editable-field/web`) with `useEndpointMutation(updateBlock)` saving
`{ params: { id: pageId }, body: { data: { ...pageData(page), title: next } } }`.
Optionally render a read-only `<PageIcon nodes={data?.iconSvgNodes}/>` beside it.

## `story-view-switcher.tsx`

```tsx
function StoryViewSwitcher({ view, onView, split, onToggleSplit }) {
  const renderers = Story.Renderer.useContributions();   // dynamic — never hardcoded
  const options = [
    { id: "author", label: "Author", icon: <MdEdit className="size-3.5" /> },
    ...renderers.map((r) => ({
      id: r.id, label: r.label,
      icon: r.icon ? <r.icon className="size-3.5" /> : undefined,
    })),
  ];
  return (
    <div className="flex items-center gap-2">
      <SegmentedControl options={options} value={view} onChange={onView} />
      <IconButton icon={MdVerticalSplit} tooltip="Split preview"
        aria-pressed={split} onClick={onToggleSplit} />
    </div>
  );
}
```

`SegmentedControl` from `primitives/toggle-chip/web`; `IconButton` from
`primitives/icon-button/web`. With zero renderers the control is just `[Author]`;
toggling split reveals the `NoRenderer` fallback in the preview pane — the live
proof the substrate works before any renderer exists.

## Cross-plugin imports (boundary-checked — runtime barrels only)

- `@plugins/apps/web` — `Apps`
- `@plugins/layouts/plugins/full-pane/web` — `FullPane`
- `@plugins/primitives/plugins/pane/web` — `Pane`, `openPane`, `clearRoute`, `type`
- `@plugins/page/plugins/editor/web` — `BlockEditor`, `PageIcon`
- `@plugins/page/plugins/editor/core` — `pagesResource`, `createBlock`,
  `updateBlock`, `pageData`, `PAGE_BLOCK_TYPE`, type `Block`
- `@plugins/page/plugins/text/core` — `textBlock`
- `@plugins/apps/plugins/story/plugins/marker/web` — `useStories`, `markStory`
- `@plugins/apps/plugins/story/plugins/render/web` — `StoryRender`, `Story`
- `@plugins/primitives/plugins/live-state/web` — `useResource`
- `@plugins/infra/plugins/endpoints/web` — `fetchEndpoint`, `useEndpointMutation`
- `@plugins/primitives/plugins/editable-field/web` — `useEditableField`
- `@plugins/primitives/plugins/toggle-chip/web` — `SegmentedControl`
- `@plugins/primitives/plugins/icon-button/web` — `IconButton`
- `@plugins/primitives/plugins/text/web` — `Text`
- `@plugins/primitives/plugins/relative-time/web` — `formatRelativeTime`

No Pages-app imports (gallery reuses `pagesResource` + `useStories` directly);
no editor/marker internals. Graph stays a DAG.

## Critical files (reference / reuse)

- `plugins/apps/plugins/sonata/plugins/shell/web/index.ts:1` — `Apps.App` shape.
- `plugins/apps/plugins/sonata/plugins/shell/web/components/sonata-layout.tsx` — `<FullPane/>` mount.
- `plugins/apps/plugins/sonata/plugins/library/web/panes.tsx:30` — `Pane.define`/`resolve`/`clearRoute`/`openPane`.
- `plugins/apps/plugins/pages/plugins/page-tree/web/internal/create-page-with-seed.ts:7` — create-with-seed recipe.
- `plugins/apps/plugins/pages/plugins/page-tree/web/components/page-header.tsx:8` — editable title via `useEditableField` + `updateBlock`.
- `plugins/page/plugins/editor/web/components/block-editor.tsx:85` — `<BlockEditor>` props.
- `plugins/apps/plugins/story/plugins/render/web/{slots.ts,components/story-render.tsx,components/renderer-picker.tsx}` — `Story`, `<StoryRender>`, dynamic `useContributions()` precedent.
- `plugins/apps/plugins/story/plugins/marker/web/{index.ts,hooks.ts}` — `useStories`, `markStory`, `StoryMark`.

## Build & verify

1. `./equin build` — codegen registers the new `web` index plugin. **No new
   migration** (the marker owns the only DB table, already landed in T2).
2. `./equin check plugin-boundaries` and `./equin check migrations-in-sync`.
3. Screenshot the app:
   `bun e2e/screenshot.mjs --url http://att-1781104727-e7vf.localhost:9000/story --out /tmp/story`.
4. Manual loop:
   - `/story` rail icon → gallery (empty state) → **New story** → lands in the editor.
   - Type text; `/` slash menu inserts blocks; `---` divider; Tab to nest —
     authoring works end-to-end and persists (reload the editor URL).
   - Switcher shows only **Author** (no renderers yet); toggle **split** → preview
     pane shows the visible "No renderer available" fallback (substrate proof).
   - `‹ Stories` back → the new story appears as a card (title + relative time).
   - `query_db` `SELECT * FROM page_blocks_ext_story` confirms the marker row.

## Out of scope (later tasks)

Renderers (T5 slides, T6 blog), content widgets (T7 image/code), and Pages
integration (T8). Each lands as a pure additive contribution — when a renderer
registers, its segment appears in this shell's switcher with **zero changes here**,
which is the milestone's whole point.
