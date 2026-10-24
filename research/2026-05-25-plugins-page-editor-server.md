# Page Editor — Schema & Server Foundation

## Context

Task 1 from the [page plugin vision](./2026-05-25-plugins-page-vision.md). Lays the DB tables, Zod schemas, resource descriptors, endpoint definitions, server handlers, and live-state resources for the block-based document editor. No web code. All subsequent tasks (editor component, text block, debug pane) depend on this.

## Plugin Structure

```
plugins/page/                                    # umbrella
  package.json
  plugins/editor/                                # editor sub-plugin
    package.json
    core/
      index.ts                                   # barrel
      schemas.ts                                 # Document, Block Zod schemas
      resources.ts                               # resourceDescriptor (client-side)
      endpoints.ts                               # defineEndpoint contracts + body schemas
    server/
      index.ts                                   # ServerPluginDefinition barrel
      internal/
        tables.ts                                # page_documents, page_blocks
        resources.ts                             # defineResource (server-side)
        handle-list-documents.ts
        handle-create-document.ts
        handle-get-document.ts
        handle-update-document.ts
        handle-delete-document.ts
        handle-list-blocks.ts
        handle-create-block.ts
        handle-update-block.ts
        handle-delete-block.ts
        handle-move-block.ts
        handle-split-block.ts
        handle-merge-blocks.ts
        handle-indent-block.ts
        handle-outdent-block.ts
```

## Data Model

```
page_documents { id PK, title, created_at, updated_at }
page_blocks    { id PK, document_id FK→page_documents (cascade),
                 parent_id self-FK (cascade), type, data JSONB,
                 rank rank_text, expanded bool default true,
                 created_at, updated_at }
```

Table names are prefixed `page_` to avoid collisions. `expanded` defaults to `true` (differs from tasks' `false`). `data` defaults to `{}`.

Indexes: composite `(document_id, parent_id, rank)` for the primary query (ordered children within a document), and `(document_id)` for document-scoped lookups.

## Files

### 1. Package files

**`plugins/page/package.json`**
```json
{ "name": "@singularity/plugin-page", "description": "Block-based page editor.", "private": true, "version": "0.0.1" }
```

**`plugins/page/plugins/editor/package.json`**
```json
{ "name": "@singularity/plugin-page-editor", "description": "Block-based document editor — tables, routes, and live state.", "private": true, "version": "0.0.1" }
```

### 2. Tables — `server/internal/tables.ts`

Mirror the agents/tasks-core pattern. Key imports: `rankText` from `@plugins/primitives/plugins/rank/core`, `jsonb` from `drizzle-orm/pg-core`. Self-FK for `parentId` uses the `(): AnyPgColumn => _blocks.id` thunk.

### 3. Zod schemas — `core/schemas.ts`

Pure `z.object()` (no drizzle imports — browser-safe). `data: z.unknown()` keeps the core agnostic of block-type data shapes. `rank: RankSchema` from `@plugins/primitives/plugins/rank/core`.

### 4. Resource descriptors — `core/resources.ts`

```ts
documentsResource = resourceDescriptor<Document[]>("page-documents", z.array(DocumentSchema), []);
blocksResource    = resourceDescriptor<Block[]>("page-blocks", z.array(BlockSchema), []);
```

Single `blocksResource` for all documents (push mode). Clients filter by `documentId`. Fine at this scale; parameterized resources can come later.

### 5. Endpoint contracts — `core/endpoints.ts`

| Route | Body | Response | Notes |
|---|---|---|---|
| `GET /api/documents` | — | `Document[]` | |
| `POST /api/documents` | `{ title? }` | `Document` | |
| `GET /api/documents/:id` | — | `Document` | |
| `PATCH /api/documents/:id` | `{ title? }` | `Document` | |
| `DELETE /api/documents/:id` | — | 204 | Cascades blocks |
| `GET /api/documents/:documentId/blocks` | — | `Block[]` | |
| `POST /api/documents/:documentId/blocks` | `{ parentId?, type, data?, rank? }` | `Block` | |
| `PATCH /api/blocks/:id` | `{ type?, data?, expanded? }` | `Block` | |
| `DELETE /api/blocks/:id` | — | 204 | Children cascade |
| `POST /api/blocks/:id/move` | `{ parentId, rank }` | `Block` | DnD reorder |
| `POST /api/blocks/:id/split` | `{ position }` | `{ original, created }` | |
| `POST /api/blocks/:id/merge` | — | `Block` | Merge into previous sibling |
| `POST /api/blocks/:id/indent` | — | `Block` | Reparent under prev sibling |
| `POST /api/blocks/:id/outdent` | — | `Block` | Reparent to parent's level |

### 6. Server resources — `server/internal/resources.ts`

```ts
documentsLiveResource = defineResource<Document[]>({ key: documentsResource.key, mode: "push", ... });
blocksLiveResource    = defineResource<Block[]>({ key: blocksResource.key, mode: "push", ... });
```

`key` sourced from the core descriptor to keep the string in one place.

### 7. Handler details

All handlers follow the agents pattern: `implement(endpoint, async ({ params, body }) => { ... })`. Import `db` from `@plugins/database/server`, `implement`/`HttpError` from `@plugins/infra/plugins/endpoints/server`.

**CRUD handlers** — straightforward. ID generation: `doc-${Date.now()}-${random}` / `block-${Date.now()}-${random}`. Call `.notify()` after every mutation.

**Split** — reads block data, splits `data.text` at `position`. Updates original, creates new sibling. Rank for the new block: find the next sibling (same parent, rank > current, first one) and use `Rank.between(currentRank, nextSiblingRank)` to place it immediately after the current block (not at the end of siblings).

**Merge** — finds previous sibling (same parent + documentId, rank < current, last one). Concatenates text. Reparents current block's children under previous sibling. Deletes current block.

**Indent** — finds previous sibling. Reparents block as last child of previous sibling via `nextRankUnder`. Sets previous sibling `expanded = true`.

**Outdent** — reparents block as sibling of its parent. Rank via `Rank.between(parentRank, nextParentSiblingRank)` to place it right after the parent.

**Move** — sets `parentId` and `rank` from body. Guards against self-parenting.

### 8. Server barrel — `server/index.ts`

Default export: `ServerPluginDefinition` with `id: "page-editor"`, all 14 routes via `[endpoint.route]: handler`, `contributions: [Resource.Declare(documentsLiveResource), Resource.Declare(blocksLiveResource)]`.

Named exports: `_documents`, `_blocks`, `documentsLiveResource`, `blocksLiveResource`, schemas, types.

### 9. Core barrel — `core/index.ts`

Re-exports: schemas + types, resource descriptors, all endpoint definitions + body schemas + body types.

## Reuse

| Need | Source |
|---|---|
| `rankText` column type | `@plugins/primitives/plugins/rank/core` |
| `nextRankUnder` | `@plugins/primitives/plugins/rank/server` |
| `Rank.between`, `Rank.from`, `RankSchema` | `@plugins/primitives/plugins/rank/core` |
| `defineEndpoint` | `@plugins/infra/plugins/endpoints/core` |
| `implement`, `HttpError` | `@plugins/infra/plugins/endpoints/server` |
| `defineResource`, `Resource` | `@plugins/framework/plugins/server-core/core` |
| `resourceDescriptor` | `@plugins/primitives/plugins/live-state/core` |
| `db` | `@plugins/database/server` |

## Verification

1. `bun install` from repo root (picks up new workspaces)
2. `./equin build --migration-name page-editor-init` — generates migration, builds, restarts
3. Verify tables exist: `mcp__singularity__query_db("SELECT * FROM page_documents")` and `SELECT * FROM page_blocks`
4. Test CRUD via curl or MCP:
   - Create document, create blocks, verify list returns them
   - Split a text block, verify two blocks returned
   - Indent/outdent, verify parentId changes
   - Delete document, verify blocks cascade
5. Verify live-state: `documentsLiveResource` and `blocksLiveResource` push updates after mutations
