# Migrate Story editor toolbar onto the PaneToolbar primitive

## Context

The Story Builder editor (`StoryEditor`) hand-rolls its top bar as a
`<div className="… border-b … pr-floating-bar">` with the back button,
`StoryHeader`, and `StoryViewSwitcher` written inline. This is the exact
anti-pattern the `no-adhoc-pane-toolbar` lint rule bans — a toolbar that is
invisible to the slot system: not extensible, not error-isolated, not
reorderable. It is currently **grandfathered** in the rule's allowlist
(`plugins/primitives/plugins/pane-toolbar/lint/index.ts`) as a tracked follow-up.

Sonata already completed the identical migration (its player toolbar). This plan
mirrors that precedent byte-for-byte: route the bar through `definePaneToolbar`,
move each bar element into a reorderable Start/End slot contribution, and remove
the story-editor allowlist entry so the rule guards it too.

## Precedent (mirror exactly)

- `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts:189` —
  `export const SonataToolbar = definePaneToolbar("sonata.toolbar");`
- `plugins/apps/plugins/sonata/plugins/library/web/index.ts:22-24` — contributes
  zero-prop components to `SonataToolbar.Start`.
- `plugins/apps/plugins/sonata/plugins/library/web/components/player-toolbar-items.tsx`
  — zero-prop toolbar items that read shared state from `useSonata()` context.
- `plugins/apps/plugins/sonata/plugins/library/web/panes.tsx:169` — the surface
  renders `<SonataToolbar.Host />` at the top.

## The one design decision: shared `view`/`split` state

`StoryEditor` keeps `view` and `split` as local `useState` and threads them as
props into `StoryViewSwitcher`, while the body (BlockEditor / StoryRender split)
reads the same state. Once the switcher becomes a zero-prop slot contribution it
can no longer receive props. Mirror Sonata: lift this state into a small
**context provider** that both the toolbar contributions and the body consume.

## Files to change

### 1. New: `plugins/apps/plugins/story/plugins/shell/web/toolbar.ts`
Define the toolbar host (its own file so the slots register at import and to keep
the barrel pure — `index.ts` may not contain a `const`):
```ts
import { definePaneToolbar } from "@plugins/primitives/plugins/pane-toolbar/web";

/** Story editor top toolbar (sanctioned render-slot host). Start: ← Stories +
 *  title; End: view switcher. Both zones reorderable. */
export const StoryToolbar = definePaneToolbar("story.toolbar");
```

### 2. New: `plugins/apps/plugins/story/plugins/shell/web/context.tsx`
`StoryEditorProvider` + `useStoryEditor()` holding the state currently inside
`StoryEditor` (moved verbatim, including the marker read for
`defaultRendererId`, the `onView` persistence via `markStory`, and the
`activeRendererId` derivation):
```ts
interface StoryEditorContextValue {
  pageId: string;
  view: string;
  setView: (next: string) => void;   // persists renderer choice via markStory
  split: boolean;
  toggleSplit: () => void;
  activeRendererId: string;          // derived (view !== "author" ? view : default ?? "")
}
```
Provider takes `pageId`, owns `useState` for `view`/`split`, reads `useStories()`.

### 3. New: `plugins/apps/plugins/story/plugins/shell/web/components/story-toolbar-items.tsx`
Three zero-prop contributions (mirror `player-toolbar-items.tsx`), each reading
`useStoryEditor()`:
- `BackToStories` — `Button variant="outline" size="xs"` + `MdChevronLeft`,
  `onClick={() => clearRoute()}` (no context needed).
- `StoryTitleItem` — `const { pageId } = useStoryEditor(); return <StoryHeader pageId={pageId} />;`
- `ViewSwitcherItem` — reads `view/setView/split/toggleSplit` from context and
  renders the existing presentational `StoryViewSwitcher` with those props.

`StoryHeader` and `StoryViewSwitcher` stay **presentational and prop-driven** —
only thin context-reading wrappers are added (same shape as Sonata).

### 4. Rewrite: `plugins/apps/plugins/story/plugins/shell/web/components/story-editor.tsx`
Strip the hand-rolled bar. The surface becomes provider + Host + body:
```tsx
export function StoryEditor() {
  const { pageId } = storyDetailPane.useParams();
  return (
    <StoryEditorProvider pageId={pageId}>
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <StoryToolbar.Host />
        <StoryEditorBody />
      </div>
    </StoryEditorProvider>
  );
}
```
`StoryEditorBody` reads `pageId/view/split/activeRendererId` from
`useStoryEditor()` and renders the existing split / author / renderer body
(lines 65-84 of the current file, unchanged logic). Its `border-r` on the split
editor pane is fine — the rule only fires on `border-b` + `pr-floating-bar`
together.

### 5. Edit: `plugins/apps/plugins/story/plugins/shell/web/index.ts`
Register the contributions in the `contributions: [...]` array and re-export the
toolbar (the shell is the natural owner — it already owns the pane and editor):
```ts
StoryToolbar.Start({ id: "back", component: BackToStories }),
StoryToolbar.Start({ id: "title", component: StoryTitleItem }),
StoryToolbar.End({ id: "view-switcher", component: ViewSwitcherItem }),
```
Add `export { StoryToolbar } from "./toolbar";`. Barrel purity holds (imports +
re-export of own file + single default export).

### 6. Edit: `plugins/primitives/plugins/pane-toolbar/lint/index.ts`
Remove the grandfathered allowlist entry
`"plugins/apps/plugins/story/plugins/shell/web/components/story-editor.tsx"`
(lines 14-16 of the doc comment and line 30) so the rule now guards it.

## Layout notes

- `StoryToolbar.Host` chrome (`border-b pl-chrome pr-floating-bar h-chrome-bar
  gap-sm`) replaces the old `border-b … py-md pl-lg pr-floating-bar` — minor,
  intentional standardization (identical to Sonata).
- Zone mapping: Start = back + title (title keeps its `min-w-0 flex-1` so the
  input fills and pushes End right via the Host's `ml-auto`); End = view
  switcher.

## Verification

1. `./equin build` (regenerates `web.generated.ts`, runs checks incl.
   `eslint` / `type-check` / `plugins-doc-in-sync`).
2. `./equin check eslint` — confirm `no-adhoc-pane-toolbar` passes with the
   allowlist entry removed (proves the migration is real, not re-exempted).
3. Open `http://att-1781435531-7h0l.localhost:9000/story`, open a story, and via
   `e2e/screenshot.mjs` confirm: back button returns to gallery, title edits
   save, the Author/renderer segments + split toggle work as before.
4. Toggle global edit mode (reorder pen in the top toolbar) and confirm the
   toolbar items are now draggable — the concrete proof they became real slot
   contributions.

## Out of scope

- No behavior change to `StoryHeader`, `StoryViewSwitcher`, `StoryRender`, or the
  marker/persistence logic — only relocation into context + slots.
- No new toolbar items; renderer segments still come from `Story.Renderer`
  contributions (collection-consumer clean, unchanged).
