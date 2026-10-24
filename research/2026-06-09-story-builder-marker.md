# Story Builder — `marker` capability (T2)

> Implements task **T2 — Story marker** from
> [`2026-06-03-app-story-builder-plan-v2.md`](./2026-06-03-app-story-builder-plan-v2.md)
> ("`marker` — the story capability" section).

## Context

Story Builder treats a "story" as an *upgraded page* — a normal `page`-type block
in the existing block editor — rather than a separate entity. There is currently
no way to mark which pages are stories or store per-story render metadata.

This task adds that **capability marker** and nothing else: a side-table on the
editor's `page_blocks` table (via the `entity-extensions` primitive, so the editor
is untouched), a push live-state resource, set/clear endpoints, and
`useIsStory`/`useStories` read hooks. **No UI** — verified via the endpoints +
`query_db`. This plugin owns the **only new DB migration** in the whole Story
Builder rollout.

It is independent of the divider work (T1) and depends on nothing; it is kept
linear (lands after divider) only to serialize the rollout, not for any code
dependency.

### Why this shape

- A story is just a `type:"page"` block, so marking it = attaching a 1:1 side-row
  keyed by the block id. `entity-extensions` is the sanctioned primitive for
  "child plugin attaches typed fields to a parent entity without coupling the
  parent" (`plugins/infra/plugins/entity-extensions/CLAUDE.md`).
- The marker row stores `default_renderer_id` (nullable) — the per-story
  persisted renderer choice (Slides/Blog) that later tasks (shell, pages-integration)
  read/write. Marking with no preference leaves it `NULL`.

### Mirror precedent (copy shape byte-for-byte)

- **`plugins/tasks/plugins/auto-start/`** — the marker pattern named in the task:
  `defineExtension` table + push resource + `useX` hook.
- **`plugins/tasks/plugins/task-preprompt/`** — same pattern **plus** its own
  set/clear endpoints + routes (auto-start routes through the parent `tasks`
  plugin; we want self-owned endpoints, so this is the precise template).

Both use a `shared/` (web+server private DRY) layout with **no `core/`**. The v2
design doc sketched a `core/{index,schema}.ts`, but no planned consumer imports
`marker/core` — `pages-integration/web` and `shell/web` both import
`@plugins/apps/plugins/story/plugins/marker/web`. Following the mirror precedent,
schemas + endpoint contracts live in `shared/`; types consumers need are
re-exported through the `web`/`server` barrels.

## Plugin tree to create

```
plugins/apps/plugins/story/                         # NEW namespace (collapsed, no barrel)
  package.json                                      # @singularity/plugin-apps-story, singularity.collapsed:true
  CLAUDE.md                                         # stub; build fills the AUTOGEN block
  plugins/
    marker/
      package.json                                  # @singularity/plugin-apps-story-marker
      CLAUDE.md                                     # stub; build fills the AUTOGEN block
      shared/
        schemas.ts          # StoryMarkSchema, StoryMarksPayloadSchema, storiesResource (resourceDescriptor)
        endpoints.ts        # setStoryMark (PUT), clearStoryMark (DELETE) — defineEndpoint contracts
        index.ts            # re-export of the two above
      server/
        index.ts            # Resource.Declare(storiesResource) + httpRoutes; re-export handle + mutations
        internal/
          tables.ts         # defineExtension(_blocks, "story", { defaultRendererId })  → page_blocks_ext_story
          resource.ts       # storiesResource = defineResource({ mode:"push" }) keyed by pageId
          mutations.ts      # getStoryMark, setStoryMark(pageId, mark|null)
          routes.ts         # handleSetStoryMark, handleClearStoryMark (implement(...))
      web/
        index.ts            # exports hooks + mutations + StoryMark type; NO contributions (no UI)
        hooks.ts            # useIsStory(pageId), useStories()
        internal/
          api.ts            # markStory(pageId, defaultRendererId?), unmarkStory(pageId)
```

Only `marker/web` + `marker/server` have barrels, so only those auto-register on
`./equin build`. The `story` namespace + `marker` are otherwise pure
directories.

## Implementation detail

### `shared/schemas.ts`
```ts
import { z } from "zod";
import { resourceDescriptor } from "@plugins/primitives/plugins/live-state/core";

export const StoryMarkSchema = z.object({
  pageId: z.string(),
  defaultRendererId: z.string().nullable(),
  updatedAt: z.coerce.date(),
});
export type StoryMark = z.infer<typeof StoryMarkSchema>;

// Keyed by pageId → O(1) useIsStory lookup; Object.values for useStories.
export const StoryMarksPayloadSchema = z.record(z.string(), StoryMarkSchema);
export type StoryMarksPayload = z.infer<typeof StoryMarksPayloadSchema>;

export const storiesResource = resourceDescriptor<StoryMarksPayload>(
  "stories",
  StoryMarksPayloadSchema,
  {},
);
```

### `shared/endpoints.ts`
```ts
import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

const SetStoryMarkBodySchema = z.object({
  defaultRendererId: z.string().nullable().optional(),
});

export const setStoryMark = defineEndpoint({
  route: "PUT /api/stories/:pageId",
  body: SetStoryMarkBodySchema,
});
export const clearStoryMark = defineEndpoint({
  route: "DELETE /api/stories/:pageId",
});
```

### `server/internal/tables.ts`  — the only migration
```ts
import { text } from "drizzle-orm/pg-core";
import { _blocks } from "@plugins/page/plugins/editor/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";

// page_blocks_ext_story(parent_id PK FK→page_blocks CASCADE, default_renderer_id text NULL, created_at, updated_at)
export const storyMark = defineExtension(_blocks, "story", {
  defaultRendererId: text("default_renderer_id"), // nullable: marking with no preference
});
export const _storyMarkExt = storyMark.table; // re-exported so drizzle-kit's glob picks it up
```

### `server/internal/resource.ts`
Mirror `task-preprompt/server/internal/resource.ts`: `defineResource({ key:"stories", mode:"push" })`,
loader selects all ext rows and folds into a `{ [pageId]: StoryMark }` record.

### `server/internal/mutations.ts`
```ts
export async function getStoryMark(pageId: string) { return storyMark.get(pageId); }

// Upsert on mark, delete on null; notify the push resource either way.
export async function setStoryMark(
  pageId: string,
  mark: { defaultRendererId: string | null } | null,
): Promise<void> {
  if (mark) await storyMark.upsert(pageId, { defaultRendererId: mark.defaultRendererId });
  else await storyMark.delete(pageId);
  storiesResource.notify();
}
```
No explicit page-exists check — mirrors `task-preprompt`; the FK to `page_blocks`
enforces it and fails loud (a 500 on a bogus pageId is the correct, debuggable
signal, not something to silence).

### `server/internal/routes.ts`
```ts
export const handleSetStoryMark = implement(setStoryMark, async ({ params, body }) => {
  await setStoryMark_mut(params.pageId, { defaultRendererId: body.defaultRendererId ?? null });
});
export const handleClearStoryMark = implement(clearStoryMark, async ({ params }) => {
  await setStoryMark_mut(params.pageId, null);
});
```
(`setStoryMark_mut` = the mutation import; named to avoid the endpoint/mutation collision.)

### `server/index.ts`
`Resource.Declare(storiesResource)` contribution + `httpRoutes` for both endpoints;
re-export `storyMark`, `getStoryMark`, `setStoryMark`, `storiesResource` (mirror
`task-preprompt/server/index.ts`).

### `web/hooks.ts`
```ts
export function useIsStory(pageId: string | null | undefined): boolean {
  const result = useResource(storiesResource);
  if (!pageId || result.pending) return false;
  return pageId in result.data;
}
export function useStories(): StoryMark[] {
  const result = useResource(storiesResource);
  return result.pending ? [] : Object.values(result.data);
}
```

### `web/internal/api.ts`
```ts
export async function markStory(pageId: string, defaultRendererId: string | null = null) {
  await fetchEndpoint(setStoryMark, { pageId }, { body: { defaultRendererId } });
}
export async function unmarkStory(pageId: string) {
  await fetchEndpoint(clearStoryMark, { pageId });
}
```

### `web/index.ts`
Export `useIsStory`, `useStories`, `markStory`, `unmarkStory`, and the `StoryMark`
type. **No `contributions`** (no UI yet) — a barrel with just exports + a
`definePlugin` default export is valid per barrel-purity rules.

## Critical files

- Create: everything under `plugins/apps/plugins/story/` (above).
- Reference / mirror (do not modify):
  - `plugins/tasks/plugins/task-preprompt/{shared,server,web}/*` — primary template.
  - `plugins/tasks/plugins/auto-start/server/internal/resource.ts` — push-resource loader.
  - `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts` — `defineExtension`.
  - `plugins/page/plugins/editor/server/index.ts:36` — `_blocks` export (table `page_blocks`).
  - `plugins/infra/plugins/endpoints/core` (`defineEndpoint`) / `endpoints/server` (`implement`).
- The editor plugin and `entity-extensions` are **not** modified — that's the point.

## Boundary compliance (`./equin check plugin-boundaries`)

- `marker/server` imports only runtime barrels: `page/editor/server` (`_blocks`),
  `infra/entity-extensions/server`, `infra/endpoints/server`, `database/server`,
  `framework/server-core/core`.
- `marker/web` imports `primitives/live-state/web`, `infra/endpoints/web`, and its
  own `../shared/*`.
- `shared/` is plugin-private (R10): only `marker/web` + `marker/server` import it;
  no cross-plugin import of `shared/`.
- No `core/` barrel (named deviation from the v2 sketch — see "Why this shape").

## Verification (no UI)

1. `./equin build` — registers the two new barrels, generates + applies the
   `page_blocks_ext_story` migration, regenerates docs/CLAUDE autogen blocks.
2. `./equin check migrations-in-sync` + `./equin check plugin-boundaries`
   (the migration must be committed; boundaries must pass).
3. Create a page to mark — find a real `page_blocks` row of `type:"page"`:
   ```sql
   -- via query_db
   SELECT id, type FROM page_blocks WHERE type = 'page' LIMIT 5;
   ```
   (If none exist, create one through the Pages app first, or seed via the editor
   `createBlock` endpoint.)
4. Exercise the endpoints against the worktree
   (`http://<worktree>.localhost:9000`):
   - `PUT /api/stories/<pageId>` with `{"defaultRendererId":"slides"}` → 200.
   - `query_db`: `SELECT * FROM page_blocks_ext_story;` shows one row with
     `default_renderer_id = 'slides'`.
   - `PUT /api/stories/<pageId>` with `{}` → row persists, `default_renderer_id` NULL.
   - `DELETE /api/stories/<pageId>` → row gone.
   - `PUT` with a non-existent pageId → loud FK error (expected fail-loud).
5. Confirm the migration file is the only schema change introduced by this task.

## Out of scope (later tasks)

`story-core`, `render` slots, renderers, content, the `/story` shell, and
`pages-integration` (the "Upgrade to story" action + embedded preview). This task
ships the capability green-but-inert: nothing reads `storiesResource` yet, which
is expected and acceptable per the rollout.
