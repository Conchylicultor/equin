# Favorites / Starred Pages

## Context

The Pages app has no way to favorite a page or surface frequently-used pages for
quick access. As page trees grow, finding the few pages you use constantly means
scrolling/expanding the whole tree every time. This adds a Notion-style
**Favorites** section pinned to the top of the Pages sidebar, plus a star toggle
in two places (sidebar row hover + the open page's header), with
**drag-to-reorder** within Favorites independent of the tree's own ordering.

Decisions (confirmed with user):
- Star toggle exposed in **both** the sidebar row (hover) and the page header.
- Favorites are **drag-to-reorder** (own rank, independent of page-tree rank).

## Design

Pages are blocks (`type="page"`) in the single `page_blocks` table
(`plugins/page/plugins/editor/server/internal/tables.ts`, exported as `_blocks`).
There is no per-user concept — single-tenant local app. So "starred" is a flag on
the page itself.

Storage uses the **entity-extensions** primitive, mirroring `tasks/auto-start`:
presence of a side-table row = starred (no boolean column). A `rank` column makes
Favorites independently orderable. A push **live-state** resource feeds both the
sidebar section and the toggles, so every surface updates reactively on any change.

New plugin: **`plugins/apps/plugins/pages/plugins/starred/`** (web + server + shared).
It contributes:
1. A second `Pages.Sidebar` section ("Favorites"), ordered above "Pages" via the
   reorder config override.
2. A `PageTree.RowActions` star toggle (mirrors `delete-page-action.tsx`).
3. A `PageDetail.HeaderActions` star toggle in the page header.

`PageDetail.HeaderActions` is a **new generic slot** added to page-tree. We cannot
edit `page-header.tsx` to import the starred plugin: page-tree is a dependency of
starred (starred imports `pageDetailPane` + `PageTree`), so the reverse import
would form a cycle (forbidden — the cross-plugin graph must be a DAG). A generic
slot keeps the dependency one-way: page-tree defines + renders the slot (no
reference to starred); starred contributes to it.

## Storage

`page_blocks_ext_starred(parent_id TEXT PK FK→page_blocks.id CASCADE, rank TEXT NOT NULL, created_at, updated_at)`

- Row present ⇒ starred. New star appends via `nextRankIn(_pageBlocksStarredExt)`.
- Reorder = `upsert(pageId, { rank })` with a rank computed client-side via
  `Rank.between(prev, next)`.

## New files: `plugins/apps/plugins/pages/plugins/starred/`

### `package.json`
Standard private workspace package (copy `auto-start/package.json` shape), name
`@singularity/plugin-apps-pages-starred`.

### `shared/resources.ts`
```ts
import { z } from "zod";
import { resourceDescriptor } from "@plugins/primitives/plugins/live-state/core";
import { RankSchema } from "@plugins/primitives/plugins/rank/core";

export const StarredPageRowSchema = z.object({ parentId: z.string(), rank: RankSchema });
export type StarredPageRow = z.infer<typeof StarredPageRowSchema>;

export const starredPagesResource = resourceDescriptor<StarredPageRow[]>(
  "pages-starred", z.array(StarredPageRowSchema), [],
);
```

### `shared/endpoints.ts`
```ts
import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Toggle: server computes the append rank when starring; deletes when unstarring.
export const putPageStarred = defineEndpoint({
  route: "PUT /api/pages/:pageId/starred",
  body: z.object({ starred: z.boolean() }),
});

// Reorder: client computes the new rank (Rank.between of new neighbors).
export const movePageStarred = defineEndpoint({
  route: "POST /api/pages/:pageId/starred/move",
  body: z.object({ rank: z.string() }),
});
```
> Confirm `defineEndpoint` is exported from `endpoints/core` (delete-page-action
> imports the consumer side from `endpoints/web`); `task-preprompt/shared/endpoints.ts`
> is the reference for the import path actually used.

### `server/internal/tables.ts`
```ts
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { rankText } from "@plugins/primitives/plugins/rank/server";
import { _blocks } from "@plugins/page/plugins/editor/server";

export const pageBlocksStarred = defineExtension(_blocks, "starred", {
  rank: rankText("rank").notNull(),
});
export const _pageBlocksStarredExt = pageBlocksStarred.table; // re-export for drizzle-kit glob
```

### `server/internal/resource.ts`
```ts
import { asc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { defineResource } from "@plugins/framework/plugins/server-core/core";
import { StarredPageRowSchema, type StarredPageRow } from "../../shared/resources";
import { _pageBlocksStarredExt } from "./tables";

export const starredPagesServerResource = defineResource({
  key: "pages-starred",
  mode: "push",
  schema: z.array(StarredPageRowSchema),
  loader: async (): Promise<StarredPageRow[]> => {
    const rows = await db.select().from(_pageBlocksStarredExt)
      .orderBy(asc(_pageBlocksStarredExt.rank));
    return rows.map((r) => ({ parentId: r.parentId, rank: r.rank }));
  },
});
```
> Verify the exact `defineResource`/`Resource.Declare` import path against
> `auto-start/server/internal/resource.ts` (server-core barrel).

### `server/internal/mutations.ts`
```ts
import { nextRankIn, Rank } from "@plugins/primitives/plugins/rank/server"; // confirm Rank export path (likely rank/core)
import { pageBlocksStarred, _pageBlocksStarredExt } from "./tables";
import { starredPagesServerResource } from "./resource";

export async function setPageStarred(pageId: string, starred: boolean) {
  if (starred) await pageBlocksStarred.upsert(pageId, { rank: await nextRankIn(_pageBlocksStarredExt) });
  else await pageBlocksStarred.delete(pageId);
  starredPagesServerResource.notify();
}

export async function movePageStarred(pageId: string, rank: string) {
  await pageBlocksStarred.upsert(pageId, { rank: Rank.from(rank) });
  starredPagesServerResource.notify();
}
```

### `server/internal/routes.ts`
```ts
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { putPageStarred, movePageStarred } from "../../shared/endpoints";
import { setPageStarred, movePageStarred as moveMutation } from "./mutations";

export const handlePutPageStarred = implement(putPageStarred,
  async ({ params, body }) => { await setPageStarred(params.pageId, body.starred); });
export const handleMovePageStarred = implement(movePageStarred,
  async ({ params, body }) => { await moveMutation(params.pageId, body.rank); });
```

### `server/index.ts`
```ts
import { Resource } from "@plugins/framework/plugins/server-core/core";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { starredPagesServerResource } from "./internal/resource";
import { handlePutPageStarred, handleMovePageStarred } from "./internal/routes";
import { putPageStarred, movePageStarred } from "../shared/endpoints";

export default {
  description: "Starred-pages side-table, live resource, and toggle/reorder endpoints.",
  contributions: [Resource.Declare(starredPagesServerResource)],
  httpRoutes: {
    [putPageStarred.route]: handlePutPageStarred,
    [movePageStarred.route]: handleMovePageStarred,
  },
} satisfies ServerPluginDefinition;
```

### `web/internal/use-star.ts` (shared toggle hook)
Small hook used by both toggle buttons so the read+toggle logic lives once:
```ts
export function useStar(pageId: string) {
  const result = useResource(starredPagesResource);
  const { mutateAsync } = useEndpointMutation(putPageStarred);
  const isStarred = !result.pending && result.data.some((r) => r.parentId === pageId);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    return mutateAsync({ params: { pageId }, body: { starred: !isStarred } });
  };
  return { isStarred, toggle, pending: result.pending };
}
```

### `web/components/star-button.tsx` (presentational, shared)
One `<button>` (copy `delete-page-action.tsx` button classes), `MdGrade` (filled)
when starred / `MdStarBorder` (outline) when not. Props: `{ pageId }`. Uses `useStar`.

### `web/components/star-row-action.tsx`
`({ row }: ItemActionProps<Block>) => <StarButton pageId={row.id} />`.
Import `ItemActionProps` from `@plugins/primitives/plugins/data-view/web`, `Block`
from `@plugins/page/plugins/editor/core`.

### `web/components/star-header-action.tsx`
`({ pageId }: { pageId: string }) => <StarButton pageId={pageId} />` for the
`PageDetail.HeaderActions` slot.

### `web/components/favorites-sidebar.tsx`
- `useResource(starredPagesResource)` + `useResource(pagesResource)`; build a
  `Map<id, Block>` from pages.
- Hide entirely (`return null`) while pending or when `starred.data.length === 0`.
- Render inside `<SidebarPaneSection title="Favorites" icon={MdGrade}>`.
- Wrap rows in `<SortableList items={ids} onMove={...} orientation="vertical">`, each
  row a `<SortableItem id={id}>` containing the existing `Row` primitive (icon =
  `PageIcon` from page data; `onClick` → `openPane(pageDetailPane, { pageId }, { mode: "push" })`;
  `selected` = matches `pageDetailPane.useRouteEntry()?.params.pageId`).
- `onMove(activeId, overId)`: `arrayMove` the id list to the new order, find the
  moved id's new prev/next neighbors, look up their `Rank` from the starred rows,
  compute `Rank.between(prevRank ?? null, nextRank ?? null)`, then
  `void fetchEndpoint(movePageStarred, { pageId: activeId }, { body: { rank: rank.toString() } })`.
  (Fire-and-forget — the WS push self-heals; SortableList already renders an
  optimistic order during the drag.)

### `web/index.ts`
```ts
export default {
  description: "Favorites/starred pages for the Pages app: sidebar section + star toggles.",
  contributions: [
    Pages.Sidebar({ id: "favorites", title: "Favorites", icon: MdGrade, component: FavoritesSidebar }),
    PageTree.RowActions({ id: "star", component: StarRowAction }),
    PageDetail.HeaderActions({ id: "star", component: StarHeaderAction }),
  ],
} satisfies PluginDefinition;
```
Imports `Pages` from `@plugins/apps/plugins/pages/plugins/shell/web`, `PageTree` +
`PageDetail` + `pageDetailPane` from `@plugins/apps/plugins/pages/plugins/page-tree/web`.

## Edits to existing files

### `plugins/apps/plugins/pages/plugins/page-tree/web/slots.ts`
Add a generic header-actions slot (no reference to starred):
```ts
export const PageDetail = {
  Section: defineRenderSlot<{ component: ComponentType<{ pageId: string }> }>("pages.detail.section"),
  HeaderActions: defineRenderSlot<{ component: ComponentType<{ pageId: string }> }>("pages.detail.header-actions"),
};
```

### `plugins/apps/plugins/pages/plugins/page-tree/web/panes.tsx`
In `PageDetailBody`, make the breadcrumb strip a flex row with the breadcrumb on
the left and the header-actions slot right-aligned:
```tsx
<div className="mx-auto flex w-full max-w-3xl items-center gap-sm px-lg">
  <div className="min-w-0 flex-1"><PageBreadcrumb pageId={pageId} /></div>
  <PageDetail.HeaderActions.Render>{(s) => <s.component pageId={pageId} />}</PageDetail.HeaderActions.Render>
</div>
```
(`PageDetail` is already imported in panes.tsx.)

### Reorder config overrides (after first build regenerates the `.origin.jsonc`)
`Pages.Sidebar` and the new slots are `defineRenderSlot`s → automatically
reorderable; default order comes from the committed override `.jsonc` files. After
`./equin build` regenerates the origins, edit the overrides and copy each new
`@hash` from the matching `.origin.jsonc`:

- `config/apps/pages/shell/pages.sidebar.jsonc` → items:
  `["apps.pages.starred:favorites", "apps.pages.page-tree:pages"]` (Favorites first).
- `config/apps/pages/page-tree/pages.tree.row-actions.jsonc` → put
  `"apps.pages.starred:star"` before `"apps.pages.page-tree:delete"`.
- `config/apps/pages/page-tree/pages.detail.header-actions.jsonc` → new file; will
  be generated for the new slot (single item — no manual ordering needed).

> Never edit `.origin.jsonc` (auto-generated). The `reorder:configs-authored` /
> `config-origins-in-sync` checks fail on a stale `@hash`.

## Build & migration flow

1. `./equin build` — regenerates the migration for `page_blocks_ext_starred`,
   the plugin registry, and the reorder `.origin.jsonc` files. NEVER run drizzle-kit
   or the migration runner manually.
2. Apply the three reorder-config override edits above (copy the fresh `@hash`es).
3. `./equin build` again; confirm `./equin check` passes (especially
   `migrations-in-sync`, `reorder:configs-authored`, `plugins-registry-in-sync`,
   `plugin-boundaries`, `type-check`).

## Verification

App at `http://att-1781566675-zfcc.localhost:9000/pages`.

- **DB** (`mcp__singularity__query_db`): after starring a page,
  `SELECT * FROM page_blocks_ext_starred;` shows a row with the page's id + a rank;
  after unstarring, the row is gone.
- **UI** (Playwright, `e2e/screenshot.mjs` or a scripted run):
  1. Hover a sidebar page row → star outline appears next to delete; click → fills,
     and a "Favorites" section appears above "Pages".
  2. Open a page → star button in the header (breadcrumb row); toggling it keeps the
     sidebar Favorites section in sync (live resource).
  3. Star 3 pages, drag to reorder within Favorites → order persists across refresh
     (DB-backed, not localStorage) and is independent of the tree order.
  4. Unstar the last favorite → Favorites section disappears entirely.
  5. Delete a starred page → it drops out of Favorites (FK CASCADE removes the
     side-table row; resource re-notifies).

## Critical files (reference)
- `plugins/tasks/plugins/auto-start/` — exact entity-extension + push-resource + notify pattern.
- `plugins/tasks/plugins/task-preprompt/{shared/endpoints.ts,server/internal/routes.ts,server/index.ts}` — typed endpoint + httpRoutes wiring.
- `plugins/apps/plugins/pages/plugins/page-tree/web/components/delete-page-action.tsx` — row-action button shape.
- `plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx` — `SidebarPaneSection`, `Row`, `pageData`, `PageIcon`, `openPane` usage.
- `plugins/primitives/plugins/sortable-list/web` — `SortableList`/`SortableItem` (`onMove(activeId, overId, event)`).
- `plugins/primitives/plugins/rank/core` — `Rank.between(prev, next)`, `RankSchema`; `rank/server` — `nextRankIn`, `rankText`.
