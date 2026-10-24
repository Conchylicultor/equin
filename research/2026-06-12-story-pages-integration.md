# Story ↔ Pages Integration (`pages-integration`) — Implementation Plan

> Implements **T8** of [`2026-06-03-app-story-builder-plan-v2.md`](./2026-06-03-app-story-builder-plan-v2.md)
> ("pages-integration" section). Depends on the already-landed `marker` (T2) and
> `render` (T3) sub-plugins.

## Context

A story is just an *upgraded page* (a normal `page` block with a
`page_blocks_ext_story` marker side-table). The `marker` and `render` substrates
are live, but today there is **no way from inside the Pages app** to:

- turn an existing Pages page into a story (or remove story-ness), or
- see the story renderings of a page without leaving for the `/story` app.

This plan adds a new sub-plugin `plugins/apps/plugins/story/plugins/pages-integration`
that plugs into the Pages app's **public contribution slots** — `PageTree.RowActions`
and `PageDetail.Section` — to provide both. **The Pages app is not modified**; the
integration lives entirely in the Story namespace and is purely additive (mirrors
how `page-tree` itself contributes `BacklinksSection` / `DeletePageAction` into its
own slots). Removing the plugin removes the feature with zero residue.

Intended outcome:
- A row action in the page tree that toggles **"Upgrade to story" / "Remove story"**.
- An embedded **Story** section in the page-detail pane: when the page is a story,
  a renderer picker + live preview + an "Open in Story Builder" link; when it
  isn't, a subtle "Make this a story" affordance.

## Dependencies — verified present (do not rebuild)

All APIs below are landed and stable.

**`@plugins/apps/plugins/story/plugins/marker/web`**
- `useIsStory(pageId: string | null | undefined): boolean`
- `useStories(): ResourceResult<StoryMark[]>` — each `StoryMark` is `{ pageId, defaultRendererId: string | null, updatedAt }`
- `markStory(pageId: string, defaultRendererId?: string | null): Promise<void>` — upserts the marker (persists `defaultRendererId`)
- `unmarkStory(pageId: string): Promise<void>` — clears the marker
- Mutations notify `storiesResource`, so `useIsStory`/`useStories` re-render automatically — **no local state needed.**

**`@plugins/apps/plugins/story/plugins/render/web`**
- `<StoryRender pageId={string} rendererId={string} />` — subscribes the per-page `blocksResource`, builds the IR, dispatches to the renderer; shows a visible "No renderer" fallback when `rendererId` matches nothing (fail-loud).
- `<RendererPicker activeId={string | null} onSelect={(id: string) => void} />` — `SegmentedControl` over `Story.Renderer.useContributions()`; renders a muted "No renderers" caption when none are contributed.

**`@plugins/apps/web`**
- `navigate(url: string): void` — THE sanctioned cross-app navigation primitive (enforced by `no-raw-history-nav`). Resolves `/story/s/<pageId>` to the Story app's `storyDetailPane` (segment `s/:pageId`) without importing the unexported pane object. Precedent: `plugins/debug/plugins/crashes/web/components/crashes-view.tsx:87` (`navigate(\`/tasks/t/${c.taskId}\`)`).

**`@plugins/apps/plugins/pages/plugins/page-tree/web`** — slot owners we contribute to:
- `PageTree.RowActions` → component receives `{ pageId: string; title: string }`
- `PageDetail.Section` → component receives `{ pageId: string }`
- Both are `defineRenderSlot`; contributions are `Slot({ id, component })` (no order field). Precedents: `components/delete-page-action.tsx`, `components/backlinks-section.tsx`.

## Plugin structure (new files only)

```
plugins/apps/plugins/story/plugins/pages-integration/
  package.json                       # mirror marker/package.json
  web/
    index.ts                         # default PluginDefinition; the two contributions
    components/
      upgrade-action.tsx             # PageTree.RowActions  → toggle marker
      story-section.tsx              # PageDetail.Section    → preview / affordance
```

No `core/`, `server/`, or `shared/` — this is a pure web contributor. Only `web/index.ts`
auto-registers on `./equin build`.

### `package.json` (mirror `marker/package.json`)

```json
{
  "name": "@singularity/plugin-apps-story-pages-integration",
  "private": true,
  "version": "0.0.1",
  "description": "Contributes into the Pages app: an Upgrade/Remove-story row action and an embedded Story section (renderer picker + live preview + Open-in-Story-Builder)."
}
```

### `web/index.ts` (mirror `page-tree/web/index.ts` shape)

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PageDetail, PageTree } from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { UpgradeAction } from "./components/upgrade-action";
import { StorySection } from "./components/story-section";

export default {
  description:
    "Pages integration for Story: 'Upgrade to story' / 'Remove story' row action + embedded story section (renderer picker, live preview, Open in Story Builder).",
  contributions: [
    PageTree.RowActions({ id: "story", component: UpgradeAction }),
    PageDetail.Section({ id: "story", component: StorySection }),
  ],
} satisfies PluginDefinition;
```

## Component design

### `UpgradeAction` — `PageTree.RowActions` (toggle)

Receives `{ pageId, title }`. Mirror `delete-page-action.tsx` button chrome
(plain `<button>` with the same Tailwind classes, `size-4` icon, `e.stopPropagation()`
so the row doesn't select). **No confirm dialog** — toggling the marker is
non-destructive (page content is untouched), unlike delete; a confirm would be
ceremony. Wrap in `WithTooltip` from `@plugins/primitives/plugins/tooltip/web` for
the label.

```tsx
export function UpgradeAction({ pageId, title }: { pageId: string; title: string }) {
  const isStory = useIsStory(pageId);
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    void (isStory ? unmarkStory(pageId) : markStory(pageId));
  };
  // <WithTooltip tip={isStory ? "Remove story" : "Upgrade to story"}>
  //   <button …same classes as DeletePageAction…><MdAutoStories className="size-4" /></button>
  // </WithTooltip>
}
```
Icon: `MdAutoStories` from `react-icons/md` (same icon the Story app uses). `title`
is unused for logic but kept in the signature to satisfy the slot contract (could
feed a richer tooltip later).

### `StorySection` — `PageDetail.Section` (preview / affordance)

Receives `{ pageId }`. Reads `useIsStory(pageId)` and `useStories()` (find the mark
by `pageId` to get `defaultRendererId` — mirrors `story-editor.tsx:27-29`).

**When NOT a story** — a subtle, low-emphasis affordance:
```tsx
<button onClick={() => void markStory(pageId)}>
  <MdAutoStories /> Make this a story
</button>
```
Muted styling (ghost/`text-muted-foreground`), nothing more. Avoid stealing focus
from the page editor.

**When a story** — wrap in a `Stack` with a `SectionLabel` "Story" eyebrow
(`@plugins/primitives/plugins/section-label/web`):
- `<RendererPicker activeId={activeId} onSelect={(id) => void markStory(pageId, id)} />`
  — selecting persists `defaultRendererId` via `markStory` (no local state; the
  resource notify re-renders the section with the new active id).
- `<StoryRender pageId={pageId} rendererId={activeId ?? ""} />` — the live preview
  (constrain height, e.g. a bordered `max-h` scroll container so it sits calmly
  inside the detail pane).
- An **"Open in Story Builder"** link → `navigate(\`/story/s/${pageId}\`)`. Use a
  ghost `Button`/`IconButton` or `link-chip`; `MdAutoStories` / `MdOpenInNew` icon.

**Renderer-default decision (active id):**
`activeId = mark.defaultRendererId ?? renderers[0]?.id ?? null`, where `renderers =
Story.Renderer.useContributions()`. This deliberately **diverges** from the shell
editor (which uses `defaultRendererId ?? ""`, showing the "No renderer" fallback
until the user picks). Rationale: an *embedded* preview should show something
useful immediately, so it falls back to the first contributed renderer when the
story has no saved default. The picker highlights that same id, so picker and
preview never disagree. The fallback is **not** persisted — only an explicit pick
calls `markStory`. (If you'd rather mirror the shell exactly and show the "pick a
renderer" fallback, drop the `?? renderers[0]?.id` term — one-line change.)

## Cross-plugin imports (all legal runtime barrels — boundary-checked)

`pages-integration/web` imports:
- `@plugins/framework/plugins/web-sdk/core` (`PluginDefinition`)
- `@plugins/apps/plugins/pages/plugins/page-tree/web` (`PageTree`, `PageDetail`)
- `@plugins/apps/plugins/story/plugins/marker/web` (`useIsStory`, `useStories`, `markStory`, `unmarkStory`)
- `@plugins/apps/plugins/story/plugins/render/web` (`StoryRender`, `RendererPicker`, `Story`)
- `@plugins/apps/web` (`navigate`)
- primitives: `tooltip/web`, `section-label/web`, `spacing/web` (`Stack`), `ui-kit/web` (`Button`/`cn`), `icon-button/web` (optional), `react-icons/md`

No `shared/`-deep, no editor/Pages internals, no cross-plugin re-exports. Graph stays
a DAG: `pages-integration` → {`page-tree`, `marker`, `render`, `apps`}; none of those
import back.

## Critical files (reference / mirror)

- `plugins/apps/plugins/pages/plugins/page-tree/web/index.ts:16` — contribution-array shape.
- `plugins/apps/plugins/pages/plugins/page-tree/web/slots.ts` — slot prop contracts.
- `plugins/apps/plugins/pages/plugins/page-tree/web/components/delete-page-action.tsx` — row-action button chrome + `stopPropagation`.
- `plugins/apps/plugins/pages/plugins/page-tree/web/components/backlinks-section.tsx` — section contributor shape.
- `plugins/apps/plugins/story/plugins/shell/web/components/story-editor.tsx:27-40,72` — find-mark / `markStory`-on-select / `StoryRender` wiring to mirror.
- `plugins/apps/plugins/story/plugins/render/web/components/renderer-picker.tsx` — `RendererPicker` props.
- `plugins/debug/plugins/crashes/web/components/crashes-view.tsx:87` — `navigate()` cross-app link precedent.
- `plugins/apps/plugins/story/plugins/marker/package.json` — package.json to mirror.

## Build & verify

1. `./equin build` — codegen registers the new `web/index.ts`. **No new DB
   migration** (marker already owns the only side-table); `pages-integration` is
   web-only.
2. `./equin check plugin-boundaries` — confirm the new imports are all legal
   runtime barrels and introduce no cycle.
3. `./equin check type-check` — type/lint clean.
4. Manual loop at `http://<worktree>.localhost:9000/pages` (use `e2e/screenshot.mjs`):
   - Open a page → page-detail shows the **Story** section with a subtle "Make this
     a story" affordance.
   - In the page **tree**, the row's hover actions include the story toggle; click
     "Upgrade to story".
   - Page-detail Story section flips to: renderer picker + live `<StoryRender>`
     preview + "Open in Story Builder".
   - Pick a renderer → preview updates and the choice persists (reload: picker keeps
     it; verify `query_db` on `page_blocks_ext_story.default_renderer_id`).
   - Click "Open in Story Builder" → lands on `/story/s/<pageId>` in the Story app.
   - Back in Pages, click "Remove story" (row action) → section reverts to the
     affordance; confirm the page still appears normally in Pages (content intact)
     and drops out of the `/story` gallery.

   Scripted check example:
   ```bash
   bun e2e/screenshot.mjs \
     --url http://<worktree>.localhost:9000/pages \
     --click "Upgrade to story" --out /tmp/story-upgrade
   ```
