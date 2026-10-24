# Story Builder — Render Substrate (T3)

> Implements **T3** of [`2026-06-03-app-story-builder-plan-v2.md`](./2026-06-03-app-story-builder-plan-v2.md)
> ("story-core" and "render" sections). Builds on the now-landed **divider** (T1)
> and **marker** (T2) plugins.

## Context

Story Builder renders a page's block tree through pluggable renderers (Slides,
Blog, …). The product thesis is **zero core changes to add a renderer**. To honor
that, the block tree must first be turned into a *renderer-agnostic* intermediate
representation, and the renderers/content widgets must plug in through dispatch
slots the core owns.

This task lands that substrate — two new plugins, **pure infra with no
contributors yet**, so it builds green but is inert:

- **`story-core`** — a pure-`core` `StoryNode` IR plus `buildStoryTree`, the
  *single* place allowed to map a block type to a structural role. A `divider`
  block becomes `role:"break"`; everything else is `role:"content"`. Renderers
  read `node.role`/`node.depth` and never name "divider".
- **`render`** — owns the two dispatch slots (`Story.Renderer`, `Story.Content`),
  the reusable `<StoryRender pageId rendererId/>` surface, a `RendererPicker`, and
  **visible** fallbacks for both slots (fail-loud: an unsupported block is shown
  as a muted placeholder, never hidden).

Nothing contributes to the slots yet (renderers/content arrive in T5–T7), and no
app mounts `<StoryRender>` yet (shell is T4). So this PR compiles, passes
`./equin check`, and leaves `main` working — but renders nothing on its own.

## Verified building blocks (reuse, don't rebuild)

- `Block` type + `blocksResource` from `@plugins/page/plugins/editor/core`
  (`schemas.ts:8`, `resources.ts:14`). `Block` has `{ id, pageId, parentId, type,
  data, rank, expanded, … }`. `blocksResource` is `resourceDescriptor<Block[],
  { pageId }>` — already scoped per page.
- `DIVIDER_TYPE` (`= "divider"`) from `@plugins/page/plugins/divider/core`.
- `buildTree<T extends {id,parentId,rank}>(rows): TreeNode<T>[]` and
  `type TreeNode<T> = T & { children: TreeNode<T>[] }` from
  `@plugins/primitives/plugins/tree/core`. **Does not sort** — caller sorts first.
- `Rank.compare(a, b)` from `@plugins/primitives/plugins/rank/core`.
- `defineDispatchSlot<Props, Key, Extra>(id, { key, fallback, docLabel })` +
  `type DispatchSlot` from `@plugins/primitives/plugins/slot-render/web`.
- `useResource(blocksResource, { pageId }) → { pending, data }` from
  `@plugins/primitives/plugins/live-state/web`.
- **Precedent to mirror exactly**: `block-editor.tsx:106-117` (resource → sort by
  `Rank.compare` → `buildTree`) for `buildStoryTree`; sonata `shell/web/slots.ts:68`
  + `library/web/{panes.tsx:149,200, components/display-picker.tsx}` for the slot
  definition, `.Dispatch`, `.useContributions()`, and the `Picker` shape.

## Plugin tree

```
plugins/apps/plugins/story/plugins/
  story-core/                          # pure core, no web/server → does NOT auto-register
    package.json                       # mirror marker/package.json name pattern
    CLAUDE.md                          # stub header; ./equin build fills the reference block
    core/
      index.ts                         # barrel
      types.ts                         # StoryRole, StoryNode
      build-story-tree.ts              # buildStoryTree
  render/                              # web-only → auto-registers (inert: contributions: [])
    package.json
    CLAUDE.md
    web/
      index.ts                         # export Story, StoryRender, RendererPicker; default def (contributions: [])
      slots.ts                         # Story.{Renderer, Content}
      components/
        story-render.tsx               # <StoryRender pageId rendererId/>
        renderer-picker.tsx            # <RendererPicker activeId onSelect/>
        unsupported-content.tsx        # Story.Content fallback (visible)
        no-renderer.tsx                # Story.Renderer fallback (visible)
```

## `story-core/core`

```ts
// types.ts
export type StoryRole = "content" | "break"; // "break" = a divider; renderers split/hr on it
export interface StoryNode {
  id: string;
  type: string;
  data: unknown;
  role: StoryRole;
  depth: number;   // 0 at top level
  index: number;   // sibling index within its parent
  children: StoryNode[];
}

// build-story-tree.ts
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { buildTree, type TreeNode } from "@plugins/primitives/plugins/tree/core";
import type { Block } from "@plugins/page/plugins/editor/core";
import { DIVIDER_TYPE } from "@plugins/page/plugins/divider/core";
import type { StoryNode } from "./types";

export function buildStoryTree(blocks: readonly Block[], pageId: string): StoryNode[] {
  const scoped = blocks.filter((b) => b.pageId === pageId);          // defensive; resource is already scoped
  const sorted = [...scoped].sort((a, b) => Rank.compare(a.rank, b.rank));
  return buildTree(sorted).map((n, i) => toStoryNode(n, 0, i));
}

function toStoryNode(node: TreeNode<Block>, depth: number, index: number): StoryNode {
  return {
    id: node.id,
    type: node.type,
    data: node.data,
    role: node.type === DIVIDER_TYPE ? "break" : "content",          // ← the ONLY block-type→role map
    depth,
    index,
    children: node.children.map((c, i) => toStoryNode(c, depth + 1, i)),
  };
}
```

```ts
// index.ts
export type { StoryRole, StoryNode } from "./types";
export { buildStoryTree } from "./build-story-tree";
```

Notes:
- `buildTree` preserves array order, and the flat array is globally rank-sorted, so
  each parent's `children` come out in rank order (subset preserves order) — no
  per-level re-sort needed (same property `block-editor.tsx` relies on).
- Top-level page blocks whose `parentId` points at the (excluded) page block fall
  through to `buildTree` roots automatically — the page block isn't in the map.

## `render/web`

```ts
// slots.ts
import type { IconType } from "react-icons";
import { defineDispatchSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { StoryNode } from "@plugins/apps/plugins/story/plugins/story-core/core";
import { NoRenderer } from "./components/no-renderer";
import { UnsupportedContent } from "./components/unsupported-content";

export const Story = {
  Renderer: defineDispatchSlot<
    { story: StoryNode[]; activeRendererId: string },
    string,
    { id: string; label: string; icon?: IconType }
  >("story.renderer", {
    key: (p) => p.activeRendererId,
    fallback: NoRenderer,
    docLabel: (c) => c.label,
  }),
  Content: defineDispatchSlot<{ node: StoryNode }, string>("story.content", {
    key: (p) => p.node.type,
    fallback: UnsupportedContent,
  }),
};
```

`<StoryRender>` — mirrors `block-editor.tsx:106-117`:

```tsx
// components/story-render.tsx
export function StoryRender({ pageId, rendererId }: { pageId: string; rendererId: string }) {
  const result = useResource(blocksResource, { pageId });
  const story = useMemo(
    () => (result.pending ? [] : buildStoryTree(result.data, pageId)),
    [result, pageId],
  );
  return <Story.Renderer.Dispatch story={story} activeRendererId={rendererId} />;
}
```

`<RendererPicker>` — self-contained; reads the slot, mirrors sonata's
`display-picker.tsx` button markup (uses `cn` from `@/lib/utils`):

```tsx
// components/renderer-picker.tsx
export function RendererPicker({ activeId, onSelect }: {
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const renderers = Story.Renderer.useContributions();   // {id,label,icon} readable; component sealed
  // empty → muted "No renderers"; else render the {id,label,icon?} chips (active = aria-pressed)
}
```

Fallbacks — **visible**, fail-loud:

```tsx
// components/unsupported-content.tsx   (Story.Content fallback; receives { node })
//   muted placeholder: "⛔ {node.type} — not shown in this view"
// components/no-renderer.tsx           (Story.Renderer fallback; receives { story, activeRendererId }, ignores)
//   muted placeholder: "No renderer available"
```

Barrel:

```ts
// web/index.ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Story } from "./slots";
export { StoryRender } from "./components/story-render";
export { RendererPicker } from "./components/renderer-picker";

export default {
  description:
    "Owns the Story.Renderer + Story.Content dispatch slots, the <StoryRender pageId rendererId/> surface, RendererPicker, and visible unsupported-block / no-renderer fallbacks.",
  contributions: [], // inert: no contributors land in this task
} satisfies PluginDefinition;
```

The slots register by virtue of being **defined and module-loaded** (re-exported
from the barrel) — exactly like sonata's `Sonata` object, whose `contributions`
array also lists only `Apps.App`, never the slots. Contributors (T5+) add
`Story.Renderer({ match, id, … })` / `Story.Content({ match, … })` to their own
arrays — `match` must equal `id` (sonata convention).

## Cross-plugin imports (boundary-checked — runtime barrels only)

- **story-core/core** → `@plugins/primitives/plugins/rank/core`,
  `@plugins/primitives/plugins/tree/core`, `@plugins/page/plugins/editor/core`
  (type `Block`), `@plugins/page/plugins/divider/core` (`DIVIDER_TYPE`).
- **render/web** → `@plugins/framework/plugins/web-sdk/core` (type
  `PluginDefinition`), `@plugins/primitives/plugins/slot-render/web`,
  `@plugins/primitives/plugins/live-state/web`, `@plugins/page/plugins/editor/core`
  (`blocksResource`), `@plugins/apps/plugins/story/plugins/story-core/core`,
  `react-icons` (type `IconType`), `@/lib/utils` (`cn`).

No cycles: `render → story-core` (leaf). Nobody imports Pages/editor *internals*.

## Critical files

- New: the eight files in the plugin tree above.
- Reference/reuse (read before writing):
  `plugins/page/plugins/editor/web/components/block-editor.tsx:106-117`,
  `plugins/page/plugins/editor/core/{schemas.ts:8, resources.ts:14}`,
  `plugins/page/plugins/divider/core/divider-block.ts:7`,
  `plugins/primitives/plugins/{tree,rank}/core/index.ts`,
  `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx:208-294`,
  `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts:68-83`,
  `plugins/apps/plugins/sonata/plugins/library/web/{panes.tsx:149-208, components/display-picker.tsx}`,
  `plugins/apps/plugins/story/plugins/marker/{package.json, CLAUDE.md}` (new-plugin template).

## Gotchas

- **`buildTree` does not sort** — always sort by `Rank.compare` first (as the
  precedent does), or sibling/slide order is wrong.
- **Slots are not contributions** — do not put the slots in `render`'s
  `contributions` array; defining + exporting them is the registration.
- **Defensive at the leaf, not here** — `buildStoryTree` carries `data: unknown`
  untouched; per-type `*.parse` (and its safe-parse fallback) is the content
  renderers' job in T5+, contained by the slot-render item error boundary.
- **`useResource` needs `NotificationsProvider`** above it — provided app-globally;
  there's no app mounting `<StoryRender>` in this task, so nothing to verify yet.
- **No new DB table / migration** — T2 (`marker`) owns the only one.

## Build & verify

This task has no UI of its own; verification is that it compiles, registers, and
passes checks — it is intentionally inert.

1. `./equin build` — codegen registers `render` (web index) and regenerates
   the autogen `CLAUDE.md` reference blocks for both new plugins. `story-core` does
   **not** appear in any registry (pure core), as intended.
2. `./equin check` — must stay green. Specifically:
   - `plugin-boundaries` — confirms the import grammar above (no cycle,
     `render → story-core` only, no internals).
   - `plugins-doc-in-sync` — confirms the generated `CLAUDE.md` / compact docs
     match (run build first, then commit the generated files).
   - `migrations-in-sync` — unaffected (no schema change).
3. Sanity-grep that `DIVIDER_TYPE` is the *only* block-type literal in `story-core`
   (renderers must stay type-agnostic): `rg -n '"divider"|DIVIDER_TYPE'
   plugins/apps/plugins/story/plugins/story-core` → exactly one reference, the role map.

## Out of scope (follow-on tasks)

T4 shell mounts `<StoryRender>`; T5 `content/text` + `renderers/slides` make the
first lens real (and exercise `Story.Content`/`Story.Renderer` for the first time);
T6 blog, T7 image+code, T8 pages-integration. Each is a pure additive contribution
proving the zero-core-change thesis.
