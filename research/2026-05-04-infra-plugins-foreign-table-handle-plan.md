# Plan: foreign-table handle pattern for `defineLink` + `defineExtension`

Companion to [`2026-05-04-plugins-foreign-table-handle.md`](./2026-05-04-plugins-foreign-table-handle.md). The research doc covers the *why* and *what good looks like*; this plan is the *how* — concrete steps, file lists, and a staged execution model.

## Context

Two infra factories — `Attachments.defineLink` and `EntityExtensions.defineExtension` — return raw drizzle `pgTable`s. Consumers re-export the table from their barrels and pass it to free helpers (`syncOwnerAttachments`, `getExtension`, `upsertExtension`). The side-table's schema becomes part of the cross-plugin contract. Today this manifests as one active leak (`_taskAttachments` and `_conversationAttachments` re-exported from `tasks-core`, imported by `tasks` + `conversations`) and one latent leak (`_agentAutoLaunchExt` re-exported from the toggle plugin's barrel).

The fix is to return a typed handle that closes over the table. Once the pgTable is no longer in any consumer barrel, the plugin-boundary checker (`cli/src/checks/plugin-boundaries.ts`, rule R4) mechanically forbids cross-plugin imports of `internal/` paths — making the leak physically impossible.

User decisions baked into this plan:

- **Scope** — migrate every existing consumer of `Attachments.defineLink` (5 sites) and `EntityExtensions.defineExtension` (5 sites), and adopt the hand-rolled `_tasksAutoStartExt` into `defineExtension`. The latent leak doesn't get a second chance.
- **Escape hatch** — handles expose `.table` for intra-plugin raw queries. Cross-plugin imports of the table itself remain blocked by R4 (`internal/` is unbarrelled). This avoids growing the handle into a query DSL just to satisfy `db.select().from(...)` in resource loaders or composed SQL in `queue-ranks.ts`.
- **Execution model** — I implement the two factories + new `EntityExtension`/`AttachmentLink` types + the barrel changes + drizzle-kit discovery contract. Each consumer migration is dispatched to a Sonnet sub-agent with the brief in §3.

## Phase 1 — Core API (I implement this)

### 1a. `Attachments.defineLink` returns a handle

Files:

- `plugins/infra/plugins/attachments/server/internal/define-link.ts`
  - Keep `pgTable` creation and the `linkSources.push(...)` registration (orphan sweep depends on it).
  - Return a frozen `AttachmentLink` object. The pgTable is held as `.table` (not enumerable in JSON.stringify, but a plain property — drizzle-kit doesn't recurse into objects, so the consumer file must re-export it explicitly; see 1d).
  - Methods on the handle:
    - `set(ownerId, ids)` — current `syncOwnerAttachments` behavior verbatim, lifted onto the handle.
    - `add(ownerId, ids)` — `INSERT … ON CONFLICT DO NOTHING`. One round trip. Closes the read-merge-write race in `handle-post-turn.ts`.
    - `list(ownerId)` — inner-join `_attachments`, return `Attachment[]`. Replaces the manual join in `handle-task-attachments.ts`.

```ts
export interface AttachmentLink {
  readonly table: PgTable & { ownerId: AnyPgColumn; attachmentId: AnyPgColumn };
  set(ownerId: string, ids: readonly string[]): Promise<void>;
  add(ownerId: string, ids: readonly string[]): Promise<void>;
  list(ownerId: string): Promise<Attachment[]>;
}
```

- `plugins/infra/plugins/attachments/server/internal/sync-owner-attachments.ts` — delete. Logic moves into the handle's `set`.
- `plugins/infra/plugins/attachments/server/internal/attachments.ts` — unchanged (still `{ defineLink }`).
- `plugins/infra/plugins/attachments/server/index.ts` — drop `syncOwnerAttachments` re-export. Add `export type { AttachmentLink } from "./internal/define-link"`. Keep `_attachments` (the central attachments table itself, not a link table) — it's still the public anchor point.

### 1b. `EntityExtensions.defineExtension` returns a handle

Files:

- `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts`
  - Keep `pgTable` creation. Return a frozen `EntityExtension<Cols>` handle.
  - Methods:
    - `get(parentId)` — current `getExtension` behavior.
    - `upsert(parentId, patch)` — current `upsertExtension` behavior.
    - `delete(parentId)` — `DELETE WHERE parentId = ?`. Three callers need it (auto-start mutations × 2, conversation-category routes × 1).
  - The two free helpers (`getExtension`, `upsertExtension`) get deleted from this file.

```ts
export interface EntityExtension<Cols> {
  readonly table: PgTable & { parentId: AnyPgColumn };
  get(parentId: string): Promise<Row<Cols> | undefined>;
  upsert(parentId: string, patch: Partial<Cols>): Promise<Row<Cols>>;
  delete(parentId: string): Promise<void>;
}
```

- `plugins/infra/plugins/entity-extensions/server/internal/entity-extensions.ts` — wraps `defineExtension` (no behavior change beyond the new return type).
- `plugins/infra/plugins/entity-extensions/server/index.ts` — drop `getExtension` and `upsertExtension` re-exports. Add `export type { EntityExtension }`.

### 1c. Drizzle-kit discovery contract

Drizzle-kit's `server/drizzle.config.ts` schema glob (`tables.ts`, `tables-*.ts`, `schema.ts`, `schema-*.ts` under `plugins/**/server/**/internal/`) walks each file's top-level exports and collects pgTable instances. It does **not** recurse into object properties, so the handle alone is invisible to it.

Convention each consumer file follows:

```ts
// internal/tables-attachments.ts (or schema-attachments.ts)
export const taskAttachments = Attachments.defineLink(_tasks);
// Re-export the pgTable so drizzle-kit picks it up. The leading `_` and the
// `internal/` location keep cross-plugin imports impossible (R4).
export const _taskAttachmentsTable = taskAttachments.table;
```

Same shape for `defineExtension`. The barrel only re-exports the handle (`taskAttachments`), never `_taskAttachmentsTable`.

I will document this convention in both factories' JSDoc and the two CLAUDE.md files (1d).

### 1d. Documentation

- `plugins/infra/plugins/attachments/CLAUDE.md` — replace the `Attachments.defineLink` example with the handle API; add the protocol-vs-DSL paragraph from the research doc; show the `_xxxTable` re-export convention.
- `plugins/infra/plugins/entity-extensions/CLAUDE.md` — already documents the desired API (`agentAutoLaunchExt.upsert(...)`); update prose so the "Mirrors `attachments.defineLink`" line reflects the handle pattern, and show the `_xxxTable` re-export convention.

### 1e. Verification at end of Phase 1

Phase 1 is mechanically incomplete on its own — every existing consumer will fail to compile because the factories' return type changed. That is the point: the type error becomes the to-do list for Phase 2. I do **not** run `./equin build` after Phase 1; I run it once after each Phase 2 batch lands so each batch is independently verified.

## Phase 2 — Per-consumer migrations (Sonnet sub-agents)

Each migration is a self-contained Sonnet task. Batches are sized so each is independently buildable and the final migration leaves the codebase compiling. Order: attachments first (active leak), then entity-extensions (latent + new adoption).

Each agent gets the brief below verbatim, scoped to its files. Agents must not push or commit; they leave the worktree dirty and report back.

### Batch 2.1 — `tasks-core` attachments (active cross-plugin leak)

Files to touch:
- `plugins/tasks-core/server/internal/schema-attachments.ts` — `taskAttachments`, `conversationAttachments` handles + `_taskAttachmentsTable`, `_conversationAttachmentsTable` table re-exports.
- `plugins/tasks-core/server/index.ts` — re-export `taskAttachments`, `conversationAttachments` (handles only). Drop `_taskAttachments`, `_conversationAttachments`.
- `plugins/tasks/server/internal/handle-create.ts:48` — `taskAttachments.set(row.id, body.attachmentIds)`.
- `plugins/tasks/server/internal/handle-update.ts:36` — `taskAttachments.set(id, ids)`.
- `plugins/tasks/server/internal/handle-create-chain.ts:107-112` — replace raw `db.insert(_taskAttachments)…` with `taskAttachments.add(newTask.id, attachments.map(a => a.id))`.
- `plugins/tasks/server/internal/handle-task-attachments.ts:12-22` — replace the manual join + DTO mapping with `return Response.json(await taskAttachments.list(taskId))` (verify the handle returns the same DTO shape; if not, adjust the handle in Phase 1 — the shape is `{ id, filename, mime, size, createdAt }`).
- `plugins/conversations/server/internal/handle-post-turn.ts:35-52` — collapse the read-merge-write into `if (attachmentIds.length > 0) await conversationAttachments.add(id, attachmentIds);`. Race gone.

### Batch 2.2 — `agents` + prompt sub-plugins attachments

Files to touch (none of these `_xxxAttachments` tables are barrel-exported today, so the migration is mostly mechanical renames):
- `plugins/agents/server/internal/tables-attachments.ts` — `agentAttachments` handle + `_agentAttachmentsTable`.
- `plugins/agents/server/internal/handle-update.ts:89` — `agentAttachments.set(id, Array.from(ids))`.
- `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/server/internal/tables-attachments.ts` — `launchPromptAttachments` handle + `_launchPromptAttachmentsTable`.
- `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/server/internal/handle-create.ts:36`, `handle-update.ts:44` — `launchPromptAttachments.set(id, ids)`.
- `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server/internal/tables-attachments.ts` — `quickPromptAttachments` handle + `_quickPromptAttachmentsTable`.
- `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server/internal/handle-create.ts:29`, `handle-update.ts:36` — `quickPromptAttachments.set(id, ids)`.

### Batch 2.3 — `auto-launch/toggle` extension (latent leak)

Files to touch:
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/tables.ts` — `agentAutoLaunch` handle + `_agentAutoLaunchTable`.
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/index.ts` — re-export `agentAutoLaunch` (drop `_agentAutoLaunchExt`).
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/handle-set.ts:15` — `agentAutoLaunch.upsert(agentId, { enabled: body.enabled })`.
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/resource.ts:15` — keep raw `db.select().from(agentAutoLaunch.table)` (load-all for live-state). Use `.table` escape; `getAll`/`entries` on the handle is rejected as a YAGNI DSL.

### Batch 2.4 — `conversation-category` extension

Files:
- `plugins/conversations/plugins/conversation-category/server/internal/tables.ts` — `conversationCategory` handle + `_conversationCategoryTable`.
- `plugins/conversations/plugins/conversation-category/server/index.ts` — re-export the handle (drop `_conversationCategoryExt`).
- `plugins/conversations/plugins/conversation-category/server/internal/routes.ts:63` — `conversationCategory.upsert(...)`. Line 84 `db.delete(...)` → `conversationCategory.delete(conversationId)`.
- `plugins/conversations/plugins/conversation-category/server/internal/classify-job.ts:77-78` — `conversationCategory.get(conversationId)` (replaces raw select). Line 129 `upsertExtension` → `conversationCategory.upsert(...)`.
- `plugins/conversations/plugins/conversation-category/server/internal/resource.ts` — raw `db.select().from(conversationCategory.table)` if it loads all rows; `.get(...)` if single-parent.

### Batch 2.5 — `conversation-progress` extension

Files:
- `plugins/conversations/plugins/conversation-progress/server/internal/tables.ts` — `conversationProgress` handle + `_conversationProgressTable`.
- `plugins/conversations/plugins/conversation-progress/server/index.ts` — re-export the handle (drop `_conversationProgress`).
- `plugins/conversations/plugins/conversation-progress/server/internal/heuristic-job.ts:64`, `:70` — `conversationProgress.get(...)` and `.upsert(...)`.
- `plugins/conversations/plugins/conversation-progress/server/internal/push-job.ts:43` — `.upsert(...)`.
- `plugins/conversations/plugins/conversation-progress/server/internal/resource.ts` — `.table` for raw select if loading all.

### Batch 2.6 — `turn-summary` extension

Files:
- `plugins/conversations/plugins/conversation-view/plugins/turn-summary/server/internal/tables.ts` — `turnSummaries` handle + `_turnSummariesTable`.
- `plugins/conversations/plugins/conversation-view/plugins/turn-summary/server/index.ts` — re-export the handle (drop `_turnSummaries`).
- `plugins/conversations/plugins/conversation-view/plugins/turn-summary/server/internal/job.ts` — switch to handle methods.
- `plugins/conversations/plugins/conversation-view/plugins/turn-summary/server/internal/resource.ts` — `.table` for raw select if needed.

### Batch 2.7 — `queue` extension

Files:
- `plugins/conversations/plugins/conversations-view/plugins/queue/server/internal/tables.ts` — `conversationsQueue` handle + `_conversationsQueueTable`.
- `plugins/conversations/plugins/conversations-view/plugins/queue/server/index.ts` — re-export the handle (drop `_conversationsExtQueue`).
- `handle-demote.ts`, `handle-promote.ts`, `handle-reorder.ts`, `handle-step-down.ts`, `seed-rank-job.ts` — `conversationsQueue.upsert(...)`.
- `queue-ranks.ts` — keeps raw drizzle composition via `conversationsQueue.table` (joins, orderBy, ne/gt/lt, limit). The handle is not a query DSL; this file demonstrates the `.table` escape as designed.
- `resource.ts` — `.table` for raw select.

### Batch 2.8 — Adopt `_tasksAutoStartExt` into `defineExtension`

`plugins/tasks/plugins/auto-start/server/internal/tables.ts:9` is currently a raw `pgTable(...)` rather than a `defineExtension(_tasks, "auto_start", { … })` call. Migrate it:

- `tables.ts` — `tasksAutoStart = EntityExtensions.defineExtension(_tasks, "auto_start", { … })` + `_tasksAutoStartTable` re-export. Compare the generated table name (`tasks_ext_auto_start`) against the existing one — if they differ, hand-edit the generated migration to keep schema stability (no rename surfaced via drizzle).
- `plugins/tasks/plugins/auto-start/server/index.ts` — re-export the handle (drop `_tasksAutoStartExt`).
- `mutations.ts:8`, `:23`, `:28-41` — `.get()`, `.upsert()`, `.delete()` (two delete paths today).
- `resource.ts` — `.table` for raw select if needed.

**Caveat for the agent**: the table name shape is enforced by `defineExtension` as `${parent}_ext_${name}`. The hand-rolled name today is `tasks_ext_auto_start` — verify before running the build, and STOP and report if there's a name mismatch (would cause an unintended `DROP TABLE` + `CREATE TABLE` migration). Do not run `./equin build` until the names are confirmed identical.

## Phase 2 sub-agent brief template

Each batch above ships to a Sonnet agent with this prompt structure (filled in with batch-specific files):

> Migrate consumers of `Attachments.defineLink` / `EntityExtensions.defineExtension` from the raw-pgTable API to the new handle API. The factories now return a typed handle (`AttachmentLink` / `EntityExtension<Cols>`) with methods (`set`/`add`/`list` or `get`/`upsert`/`delete`) and a `.table` property for raw queries. The pgTable must NOT cross any plugin barrel — only handles.
>
> Read `research/2026-05-04-infra-plugins-foreign-table-handle-plan.md` §3 for the full design. Read `plugins/infra/plugins/attachments/server/internal/define-link.ts` (or `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts`) to see the new factory shape.
>
> **Files to change** (verbatim from the relevant batch above): …
>
> **Steps:**
> 1. In each `tables*.ts` / `schema*.ts`, replace `_xxxAttachments`/`_xxxExt` with the handle name (camelCase, no leading `_`). Add a sibling `export const _xxxTable = handle.table` so drizzle-kit still discovers the pgTable.
> 2. Update each call site to use handle methods. For raw queries that don't fit a handle method (live-state resource loaders, complex SQL), use `handle.table`.
> 3. Update each consumer's `server/index.ts` barrel: re-export the handle, drop the old `_xxx` re-export.
> 4. Run `./equin build` from the worktree directory. The build must succeed and the auto-generated migration diff must be empty (the underlying SQL schema is unchanged). If a migration is generated, STOP and report — do not commit it.
> 5. Report back with: files changed, build outcome, migration diff (must be empty), and any surprises.
>
> **Hard rules:**
> - Do not modify other consumers (out of scope for this batch).
> - Do not push, commit, or run `./equin push`.
> - If the build fails or a migration is generated, STOP and report; do not improvise.

I run each batch sequentially, building between batches and resolving any surprises before dispatching the next.

## Verification (end-to-end)

1. `./equin build` — final run, after all batches. Migration diff must be empty (the underlying tables are unchanged; only the TS API moved).
2. `./equin check` — plugin-boundary checker passes. After this refactor, R4 mechanically prevents cross-plugin pgTable imports because no pgTable lives in a barrel.
3. `rg -n '_taskAttachments|_conversationAttachments|_agentAttachments|_launchPromptAttachments|_quickPromptAttachments|_agentAutoLaunchExt|_conversationCategoryExt|_conversationProgress|_turnSummaries|_conversationsExtQueue|_tasksAutoStartExt|syncOwnerAttachments|getExtension|upsertExtension'` — empty result outside `internal/` of the owning plugin (and the historical migration files in `server/src/db/migrations/`).
4. UI smoke tests:
   - Paste image into task description → save → reopen → image still rendered (`set` path on `taskAttachments`).
   - Send a turn in a conversation with a pasted image; send another turn with another image → both link rows present (`add` path on `conversationAttachments`, race-free).
   - Create a task via the chain form (improve / new-child-task) with attachments → attachments listed in detail pane (`add` + `list`).
   - Toggle agent auto-launch on/off → state survives reload (`upsert` + live-state read via `.table`).
   - Promote/demote/reorder a conversation in the queue → ranks update (`upsert` + `queue-ranks.ts` raw composition via `.table`).
   - Send a turn → category chip appears + persists (`get` + `upsert` + `delete`).
   - Tasks auto-start toggle → state survives reload (`get` + `upsert`; `delete` covered by the auto-start UI path).

## Out of scope

- Renaming the orphan-sweep registry (`linkSources` / `getRegisteredLinks`) — already correctly hidden.
- SQL migrations — the underlying tables, FK shape, and constraints are unchanged.
- Wire/upload protocol — `POST /api/attachments` and the markdown ref format `![](/api/attachments/<id>)` are unchanged.
- Adding a `remove` method to `AttachmentLink` — no caller needs it; trivial to add later.
- Lint rule that forbids `.table` access from outside the defining plugin — the boundary checker already blocks cross-plugin `internal/` imports, which is sufficient. A targeted lint rule can land later if a real misuse appears.
