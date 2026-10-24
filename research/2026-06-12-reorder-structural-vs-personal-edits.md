# Structural vs Personal reorder edits

## Context

Today every in-app reorder drag writes to the **per-worktree user config layer**
(`~/.singularity/config/<worktree>/…`) — i.e. it is always a *personal*
customization. There is no way to express the other intent: *"this reorder should
become the committed default for everyone"* (the **git layer**,
`config/<plugin>/<slot>.jsonc`). The only way to promote a layout into git today is
to hand-author the JSONC override and re-stamp its hash.

We want to **capture the intent at edit time** (personal vs default-for-everyone),
route "default-for-everyone" edits into a **reviewable holding area**, and let the
user **manually apply** them — writing the committed `config/` override in the
worktree so it rides the normal review → `./equin push` flow.

Confirmed constraints / decisions:
- **No auto-push, no async sync job** for v1. Apply is a manual, in-app action.
- **Worktree-local staging** (decided). Structural edits are made, reviewed, and
  applied *within a worktree session* — exactly where review + push already live.
  The main app's reorder stays personal-only for now. App-wide staging is a clean
  additive step later (see *Future: app-wide*).
- The "only reorder, never theme/token/other configs" guarantee must be
  **structural** — enforced by a descriptor flag, not by naming reorder in the
  staging/CLI code (collection-consumer separation).

Why worktree-local (not central/app-wide): the artifact a structural edit produces
— a written `config/<plugin>/<slot>.jsonc` that rides `./equin push` — is
worktree-local. The central runtime has **no Postgres** (secrets/auth use an
encrypted flat file + HTTP routes; new central plugins need `central-core`
approval), and a table on the main `singularity` DB has a **bootstrap deadlock**
(it doesn't exist on main until the feature is merged) plus an unprecedented
cross-worktree write. Co-locating staging with the worktree DB, the review pane,
and the `config/` write it produces is one transactional domain (mirrors
`tasks/plugins/auto-start`).

## Architecture (data flow)

```
edit-mode + scope="everyone"            scope="personal" (unchanged)
        │                                       │
ReorderInner.commitTree(tree)                   ▼
        │                               useSetConfig → user layer
        ▼                               (~/.singularity/config/<wt>/…)
stageReorderDefault endpoint
        ▼
reorder_staged_default table (worktree DB)  ──notify──▶ live-state resource
        ▼                                                     │
review "Reorder Defaults" section ◀───────────────────────────┘
        │ Apply                          │ Discard
        ▼                                ▼
git-layer writer:                   delete row
  config/<plugin>/<slot>.jsonc
  (restamped // @hash)  →  rides ./equin push
```

The tree handed to `commitTree` is **already materialized over the live catalog**
(via `materializeTree`), so it is catalog-reconciled at capture time. The server
apply writes it verbatim with a fresh hash; render-time `applyTree` self-heals any
later drift (orphan entryKeys skipped, new contributions natural-order appended).
No server-side catalog reconcile is needed (and `applyTree` is web-only anyway).

## Phase 1 — `promotableToGit` flag (config_v2 core)

Mirror the existing optional `scope?: "app"` field exactly.

- **`plugins/config_v2/core/internal/types.ts`** — add to `ConfigDescriptor`:
  ```ts
  // When true, an in-app edit may be staged as a committed git-layer default
  // (the reorder "default for everyone" path) instead of a per-user override.
  readonly promotableToGit?: boolean;
  ```
- **`plugins/config_v2/core/internal/define-config.ts`** — add `promotableToGit?: boolean`
  to opts and to the frozen return. No schema-builder change (metadata, not a field).
  The `isConfigDescriptor` duck-type guard in `config-origin-gen.ts` is unaffected.
- **`plugins/reorder/shared/directive.ts`** — pass `promotableToGit: true` in the
  `defineConfig(...)` call inside `reorderDirectiveDescriptor`. Isomorphic (core-only
  deps), so both runtimes' descriptor instances carry the flag. **Does not shift any
  origin hash** (it's not a default value) → no `config-origins-in-sync` churn.

## Phase 2 — New staging sub-plugin `plugins/reorder/plugins/staging/`

Owns the staging table, the runtime git-layer writer, and the stage/apply/discard
endpoints + a live resource. Structural precedent to mirror end-to-end:
`plugins/tasks/plugins/auto-start/`. Keeps reorder/server's dependency surface thin
(database/server, live-state, endpoints live only in this leaf).

**2a. Table — `staging/server/internal/tables.ts`** (standalone `pgTable`, precedent
`plugins/improve/server/internal/tables.ts`):
```ts
export const _reorderStagedDefault = pgTable("reorder_staged_default", {
  slotId: text("slot_id").primaryKey(),            // last-write-wins per slot
  pluginId: text("plugin_id").notNull(),           // dot-form; server derives path
  items: jsonb("items").notNull(),                 // materialized ReorderTree
  authorId: text("author_id"),                     // conversation id or null
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```
Export `_reorderStagedDefault` from `staging/server/index.ts` so `./equin build`
autogenerates the migration. Target DB = the worktree's own `db` from
`@plugins/database/server`.

**2b. Shared resource descriptor — `staging/shared/resources.ts`** (mirror
`auto-start/shared/resources.ts`): `stagedReorderDefaultsResource =
resourceDescriptor<StagedReorderDefault[]>("reorder-staged-defaults", schema, [])`.
Keep `items` loosely typed (`z.array(z.unknown())`) here — canonical `ReorderTree`
validation runs at **apply** time, so one bad row never blanks the resource.

**2c. Push resource — `staging/server/internal/resource.ts`** (mirror
`auto-start/server/internal/resource.ts`): `defineResource({ key:
"reorder-staged-defaults", mode: "push", schema, loader: () => db.select()… })`,
declared via `Resource.Declare(...)` in the server barrel. Every mutation calls
`stagedReorderDefaultsResource.notify()`.

**2d. Endpoints — `staging/core/endpoints.ts`** (`defineEndpoint`, precedent
`plugins/tasks/core/endpoints.ts`):
- `stageReorderDefault` — `POST /api/reorder/staged-defaults`, body
  `{ slotId, pluginId, items }`. Upsert (last-write-wins on `slotId`).
- `applyReorderDefault` — `POST /api/reorder/staged-defaults/:slotId/apply`.
- `discardReorderDefault` — `DELETE /api/reorder/staged-defaults/:slotId`.
- (List is served by the live resource via `useResource`; no GET endpoint needed.)

**2e. Runtime git-layer writer — `staging/server/internal/git-layer-writer.ts`**
(no runtime git writer exists today; mirror `jsoncConfigProxy.write` in
`plugins/config_v2/server/internal/jsonc-proxy.ts` — atomic tmp + rename,
`mkdirSync` recursive):
```ts
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { computeHash, stringifyConfigValue } from "@plugins/config_v2/core";
// hierarchyPath = asPath(asPluginId(pluginId))
// originPath  = join(REPO_ROOT, "config", hierarchyPath, `${slotId}.origin.jsonc`)
// overridePath= join(REPO_ROOT, "config", hierarchyPath, `${slotId}.jsonc`)
```
Steps: read `<slot>.origin.jsonc` → strip `// @hash` header → `parseJsonc(body)` =
origin's full document → build `{ items: <staged tree> }` → `hash =
computeHash(parsedOriginBody)` → write `// @hash ${hash}\n` +
`stringifyConfigValue(fullDoc)` + `\n` atomically.

> **Critical:** the override's `// @hash` must equal the hash of the **origin body**,
> not of the override — this is what `config-origins-in-sync` compares. Restamping
> against the live origin means the override is born in-sync (check stays green).

**2f. Handlers — `staging/server/internal/handlers.ts`** (`implement(...)`, precedent
`plugins/tasks/server/internal/handle-get.ts`):
- `stageReorderDefault`: build `reorderDirectiveDescriptor(slotId)` (from
  `@plugins/reorder/shared/directive`, isomorphic) and assert
  `descriptor.promotableToGit === true`, else `HttpError(403)`. **This is the
  structural enforcement** — a hand-crafted request for a non-reorder slot is
  refused. Upsert row → `notify()`.
- `applyReorderDefault`: load row (404 if absent) → **validate `items` against
  `descriptor.schema.safeParse({ items })`; on failure `HttpError(422)` listing
  issues** (fail-loud; defends against legacy `{order,hidden}` shapes — never silently
  drop) → call git-layer writer → delete row → `notify()`.
- `discardReorderDefault`: delete row → `notify()`.

**2g. Server barrel — `staging/server/index.ts`**: `contributions:
[Resource.Declare(stagedReorderDefaultsResource), implement(stage…), implement(apply…),
implement(discard…)]`; export `_reorderStagedDefault` + the resource.

**2h. Web hook — `staging/web/`**: `useStageReorderDefault` /
`useApplyReorderDefault` / `useDiscardReorderDefault` via
`useEndpointMutation(...)` (precedent `runtime-section.tsx`).

## Phase 3 — Scope signal + edit-time fork (reorder/web)

**3a. Scope store — `plugins/reorder/web/internal/scope-store.ts`** (exact clone of
`edit-mode-store.ts`): module-level `scope: "personal" | "everyone"` (default
`"personal"`), with `get/set/useReorderScope`. Export all three + the type from
`plugins/reorder/web/index.ts`. Reset to `"personal"` on edit-mode exit (wire into
the existing `setEditMode(false)` / Esc path) to avoid a sticky "everyone".

**3b. Scope toggle control** — add to the existing **`plugins/reorder/plugins/edit-mode/`**
sub-plugin (it already owns the pen button and depends only on `reorder/web` + shell).
A second `ActionBar.Item` rendering a segmented Personal/Everyone chip, returning
`null` when `!useEditMode()`. Mirror `pen-button.tsx`.

**3c. Fork in `ReorderInner` — `plugins/reorder/web/internal/dnd-list-middleware.tsx`**:
introduce a single `commitTree(tree)` indirection; replace every
`setConfigRef.current("items", X)` (the 5 write sites: drag/hide/restore/insert/
remove/patch) with `commitTreeRef.current(X)`. Materialization logic
(`materializeTree`, `mapNodeById`) is unchanged — only the sink forks:
```ts
const scope = useReorderScope();
const stage = useStageReorderDefault();           // from staging/web
const commitTree = useCallback((tree: ReorderTree) => {
  if (scope === "everyone") stage.mutate({ slotId, pluginId: reorderPluginIdForSlot(slotId), items: tree });
  else setConfig("items", tree);                  // unchanged personal path
}, [scope, slotId, setConfig, stage]);
```
Thread `slotId` into `ReorderInner` (already known at the `ReorderListMiddleware`
level). Expose `reorderPluginIdForSlot(slotId)` from
`plugins/reorder/web/internal/descriptors.ts` (it already holds `pluginId` per slot
in `reorderDescriptorEntries`). reorder/web → staging/web is a legal parent→child
import; import only the **web barrel** hook, never staging server/internal.

## Phase 4 — Review section `plugins/review/plugins/reorder-defaults/`

New sub-plugin of review, mirroring `plugins/review/plugins/code-review/web/index.ts`:
```ts
ReviewSlots.Section({ id: "reorder-defaults", label: "Reorder Defaults",
  component: ReorderDefaultsSection, summary: ReorderDefaultsSummary });
```
`ReorderDefaultsSection({ conversationId, source })`:
1. `useResource(stagedReorderDefaultsResource)` (from staging's shared/web barrel) —
   live list of staged slots.
2. Per slot: a **before/after reorder diff** + per-slot **Apply** + **Discard**, plus
   **Apply all**. Empty → `Placeholder`. `ReorderDefaultsSummary` shows the count
   (mirror `CodeReviewSummary`).
3. Mutations via `useApplyReorderDefault` / `useDiscardReorderDefault`.

**Diff rendering** — the review section is a *web* component, so the catalog is in
scope. Expose a reorder-owned helper `diffReorderTrees(contributions, before, after)`
from `plugins/reorder/web` (returning `{ entryKey, label, status: "moved"|"hidden"|
"added"|"unchanged" }[]`) so `applyTree` stays private. `before` = current committed
`config/<slot>.jsonc` value (`useConfig(descriptor)` resolves to git layer when no
user override), `after` = staged items. v1 may render simply as two ordered
name-lists with move/hide/add markers.

## Open sub-questions — resolved

- **Live-preview in author's session?** **No.** "Everyone" edits go to the staging
  table, *not* the user layer — so the author's live slots correctly keep showing the
  current effective layout. Previewing would require also writing the user layer,
  conflating the two paths and leaving a phantom personal override. The staged tree is
  shown faithfully in the review diff. Keeping the two write paths strictly disjoint is
  the core invariant.
- **Catalog reconcile on apply?** **Not needed.** Tree is materialized at capture
  (web); apply writes verbatim with restamped hash; render-time `applyTree` self-heals
  drift.
- **Staging scope?** **Worktree-local** (decided).

## Risks & boundary pitfalls

- **Staging plugin is never named by consumers.** Review imports staging's
  core/shared/web barrels generically (resource descriptor, endpoint defs, hooks);
  reorder/web imports only staging's web hook. Git-layer writer, table, handlers stay
  in `server/internal`, never exported across the boundary.
- **Hash anchoring** (§2e) is the subtle failure mode — stamp against origin body, not
  override. Verify the written file's `// @hash` equals `computeHash(originBody)`.
- **Don't route the staged tree through `setConfig`** (that writes the user layer).
- **`reorder:configs-authored` stays green** — apply rewrites an *existing* committed
  override (every reorderable slot already has one). `config-origins-in-sync` stays
  green because the override is restamped against the live origin.
- **Scope stickiness** — reset to personal on edit-mode exit.

## Future: app-wide (not now)

To make staging app-wide later: (1) land the table on main first (separate merge) to
clear the bootstrap; (2) add a sanctioned cross-worktree write path (or a central
HTTP route mirroring the secrets flat-file+route pattern, with `central-core`
approval); (3) key rows by `(worktree, slotId)` and add an "apply target worktree"
selector in the review section. None needed while Apply targets the local `config/`.

## Critical files

- `plugins/config_v2/core/internal/types.ts`, `define-config.ts` — `promotableToGit`
- `plugins/reorder/shared/directive.ts` — set the flag
- `plugins/reorder/web/internal/dnd-list-middleware.tsx` — the `commitTree` fork
- `plugins/reorder/web/internal/{scope-store.ts,descriptors.ts}` — scope signal + `reorderPluginIdForSlot`
- `plugins/reorder/plugins/edit-mode/web/` — scope toggle control
- `plugins/reorder/plugins/staging/**` — NEW: table, resource, endpoints, git-layer writer, handlers, web hooks
- `plugins/review/plugins/reorder-defaults/**` — NEW: review section + diff
- `plugins/config_v2/server/internal/jsonc-proxy.ts` — writer template
- `plugins/tasks/plugins/auto-start/**` — end-to-end precedent for the staging sub-plugin

## Verification

1. `./equin build` — confirm a `reorder_staged_default` migration is generated;
   `./equin check` passes (`config-origins-in-sync`, `reorder:configs-authored`,
   boundary checker).
2. Drive the UI (run skill / `e2e/screenshot.mjs`): enter edit mode, flip scope to
   "Everyone", drag-reorder a slot.
3. `mcp__singularity__query_db` → `SELECT * FROM reorder_staged_default;` — one row,
   `items` = materialized tree, `plugin_id` correct.
4. Confirm **no** `~/.singularity/config/<wt>/…/<slot>.jsonc` was written by the
   "everyone" drag (author's live layout unchanged).
5. Open the review pane → "Reorder Defaults" section lists the slot with before/after
   diff + Apply/Discard.
6. Apply → `config/<plugin>/<slot>.jsonc` written with `// @hash` matching
   `computeHash` of the current `<slot>.origin.jsonc` body; staged row deleted; section
   updates live.
7. Negative tests: stage a non-promotable descriptor → 403; apply a malformed `items`
   (legacy `{order,hidden}`) → 422, no file written.
8. `git status` shows the modified `config/<plugin>/<slot>.jsonc`; rides
   `./equin push`; `./equin check` stays green.
