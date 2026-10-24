# Page editor → per-block CRDT (Plan B)

> **Supersedes** [`2026-06-19-page-crdt-yjs-migration.md`](./2026-06-19-page-crdt-yjs-migration.md)
> (Architecture A: one `Y.Doc` per page). That plan is retained for history but is
> no longer the chosen direction — see *Why per-block, not per-page* below.

## Context

Two problems, one design.

1. **The bug.** Typing fast in a text block jumps the caret and scrambles text
   ("Generalization of Notion" → "Generationlization of No"). Root cause
   (`web/components/value-sync-plugin.tsx`): text autosave round-trips through a
   serialized `RichText`-JSON string + integer caret-offset restore, and the
   optimistic confirmation predicate `isPatchReflected`
   (`web/internal/optimistic-block-ops.ts`) checks `parentId|type|rank|expanded`
   but **never `data.text`** — so a structurally-matching-but-textually-stale
   push collapses the overlay to old text mid-typing and Lexical rebuilds from
   the stale string. Any CRDT binding eliminates this **structurally**: remote/
   echoed changes apply as a relative-position *merge*, never a full rebuild.

2. **The architectural question.** In Yjs the `Y.Doc` is the single source of
   truth, but Notion (and this app) models a page as a *collection of blocks*, not
   a monolithic document. The resolution: **a document is not a CRDT — it is a
   *composition* of CRDTs.** A page has two kinds of state that want different
   semantics, and we split them:
   - **Inter-block structure** (which blocks exist, their tree + order) — stays
     **relational** in `page_blocks` (`parentId` + fractional `rank`), converging
     by fractional-index + `(rank, id)` tiebreak + last-writer-wins per row. This
     is the existing model, kept **unchanged**.
   - **Intra-block rich text** (the characters/marks inside one block) — becomes a
     **per-block `Y.Doc`** (one `Y.XmlText`), an independent sync/merge/persistence
     unit bound to that block's Lexical instance.

`Y.Doc` is a unit of *sync*, not a unit of *product*. We pick its granularity =
**the block**, which is exactly the granularity at which we want to lazy-load,
move across pages, and (later) permission and transclude.

**Concurrency target** (decided): convergence across *one user's own tabs/devices*
and *concurrent agent writes* — consistent with the single-instance-per-user ADR
([`research/2026-07-02-global-adr-single-instance-per-user.md`](./2026-07-02-global-adr-single-instance-per-user.md)).
No live remote cursors / sub-100ms multi-user echo required. This is why content
sync can ride the existing **live-state** path instead of a bespoke Yjs provider.

## Why per-block, not per-page (Plan B vs A)

Architecture A already keyed blocks by id inside one page `Y.Doc`
(`getMap("blocks")` + `getMap("text")`) with a ~500ms projection to `page_blocks`.
Plan B moves the content docs *out* of a page-level doc into one doc per block, and
keeps the **tree authoritative in SQL** rather than in a Yjs blocks-map:

| | A — one doc / page | **B — one doc / block (chosen)** |
|---|---|---|
| Structure authority | Yjs `blocks` map (rows are a lagging projection) | **`page_blocks` rows (live, authoritative)** |
| Hydration | whole page `Y.Doc` at open | **skeleton is already-loaded rows; each block's content doc hydrates on mount (virtualized → lazy)** |
| Cross-page move | transplant `Y.XmlText` between two page docs | **one `parentId` row update; content doc travels by block id** |
| Structural pipeline | replaced by Y-transactions (`applyBlockOp` becomes a Y-mutation) | **`applyBlockOp` + optimistic-mutation + op/patch endpoints kept 100% unchanged** |
| Transport | custom `yjs-transport` WS + `y-protocols` | **reuse live-state (blob ingest + keyed push)** |
| Structure convergence | LWW per map key | LWW per row (**same guarantee**) + fractional index |
| References / per-block perms (future) | hard (text buried in page doc) | **natural (each content doc is its own unit)** |

Costs B accepts (all acceptable for the my-devices+agents target): content fan-out
ships **whole-block** state (not deltas) — bounded per block; split/merge move text
across **two** content docs (not one atomic Yjs transaction) — mitigated by
seeding from runs; two undo mechanisms to reconcile into one chronological stack —
see open questions.

## Target architecture

### Structure layer — unchanged

`page_blocks` (`server/internal/tables.ts`) stays the authoritative tree: `id`,
`pageId`, `parentId`, `type`, `rank` (`rankText`), `expanded`, and **non-text**
`data` (todo `checked`, image src, callout color, code, latex…). Every structural
op keeps flowing through the existing pipeline **verbatim**:

- `applyBlockOp` pure reducer (`core/block-ops.ts`) — client + server.
- `useOptimisticResource` overlay/replay/confirm (`optimistic-mutation`).
- Endpoints `POST /blocks/op`, `/blocks/patch`, `/move`, bulk-* — unchanged.
- `Rank.between`/`nBetween` + the `(rank, id)` tiebreak comparator for tied inserts.

`data.text` stops being authoritative for *mounted* text blocks: it becomes a
**projection** of the block's content doc (written back debounced), so all
downstream readers — full-text search, backlinks, history snapshots, reminders,
`read-only-view`, attachments reconcile — keep reading `data.text` from
`page_blocks` with **no change**.

### Content layer — per-block `Y.Doc`

Each text block gets a `Y.Doc` containing one `Y.XmlText` (key `"content"`), bound
to that block's Lexical instance via `@lexical/yjs`. Persisted per block:

```
page_block_docs(block_id pk → page_blocks.id ON DELETE CASCADE,
                state bytea,             -- Y.encodeStateAsUpdate(doc), compacted
                updated_at timestamptz)
```

`state` is the first `bytea` column in the repo → introduce a `bytea` `customType`
following the exact `rankText`/`tsvector` precedent
(`primitives/rank/core/internal/types.ts`). An append log
(`page_block_doc_updates`) is **not** needed for v1 (server holds the merged state;
durability is the single compacted `state` row written in the same tx as ingest).

### Transport — reuse live-state

No new WS protocol. A thin `LiveStateYjsProvider` implements the `@lexical/yjs`
provider interface, backed by two existing primitives:

```
 type in a block
   → Lexical change → @lexical/yjs binding emits a Yjs update (local origin)
   → local Y.Doc applies it INSTANTLY (local-first; no round-trip to render)
   → debounced (~300ms) POST /api/blocks/:id/doc-update   [endpoints blob() codec]
        server: SELECT … FOR UPDATE page_block_docs
                Y.Doc ← state; applyUpdate(incoming); state ← encodeStateAsUpdate
                (lazy-seed from data.text via runsToXmlText on first touch)
                write state bytea  ─┐
   → change-feed STATEMENT trigger  │ (automatic; table is not excluded)
   → live-state keyed push          │  blockContentResource (keyed by blockId)
        value = { blockId, state: base64(bytea), updatedAt }
   → every other tab/device: useResource → applyUpdate(state) into its local doc
        (idempotent + commutative → converge; sender's own echo is a no-op)
   → @lexical/yjs syncs the merge into Lexical — a MERGE, never a rebuild → caret safe
```

Why this is correct without a diff protocol: `Y.applyUpdate(doc, fullState)` is
idempotent and commutative, so broadcasting the whole compacted block state on each
change converges every replica. Whole-block state is small (per block, not per
page) — the per-block grain is what makes this affordable.

`blockContentResource` is a **keyed** live resource (`keyedResourceDescriptor` +
`identityTable: "page_block_docs"`, `keyOf: blockId`) — compiles cleanly via
`query-resource` (`queryResource`), keyed by pk with no mutable `where`, so scoped
`affectedIds` recompute ships only the changed block. Only **mounted** text editors
subscribe (via `virtual-rows`), so subscription = lazy content loading for free.

Content does **not** use `useOptimisticResource` — the local `Y.Doc` *is* the
local-first layer; `useResource` supplies server truth that the doc merges.

## Structural ops that cross content docs

`split` / `merge` are the only ops that move text between blocks. Today they
already operate on **runs** (`op.runs`, `splitRuns`, `mergeRuns` in
`core/rich-text.ts`), not on live CRDT deltas — so they port cleanly:

- **split(pos)** — compute `before`/`after` runs (existing `applyBlockOp`). Set the
  origin block's content doc to `before` runs; **create the new block's content doc
  seeded from `after` runs** (`runsToXmlText`). Structure change is the normal
  `insert`/`split` op through the unchanged pipeline. Caret → relative position in
  the newly focused block's doc.
- **merge** — append the merging block's runs onto the target's content doc at
  `joinOffset = targetLen`; delete the merged block (FK cascade drops its
  `page_block_docs` row). Caret pinned to a relative position at the join.

These are single-caret user ops — effectively never concurrently contended on the
same block — so a non-atomic two-doc transfer is safe. `indent`/`outdent`/`move`/
`delete`/`insert`/`convert`/non-text `update` touch only rows and cannot move a
focused caret.

## Undo/redo

> **Superseded (2026-09-09)** by
> [`2026-09-09-page-data-based-text-undo-entries-v2.md`](./2026-09-09-page-data-based-text-undo-entries-v2.md).
> The per-block `Y.UndoManager` + mirrored-thunk model below shipped and was
> then deleted: a thunk popping a manager is a pointer that silently no-ops once
> the block's doc is destroyed (a deleted block came back from Ctrl+Z without
> its text). Text entries are now DATA — the block's runs before and after a
> typing run — replayed onto whichever host holds the block. Kept for history.

Keep the single chronological document-level stack (`primitives/undo-redo`).
Structural ops push their existing `{undo, redo}` thunks. Each block content doc
gets a `Y.UndoManager` (local origin); a coalesced typing run pushes a thunk
`{ undo: () => um.undo(), redo: () => um.redo() }` at the same commit boundary the
text projection fires. This preserves one interleaved text+structure stack without
a Yjs-wide UndoManager (which B can't have, since structure isn't Yjs). **Open
question** — verify cross-block merge-undo rebinding; fallback to explicit capture
boundaries.

## New / modified code

**Add**
- `plugins/primitives/plugins/collab-doc/core/index.ts` — `runsToXmlText` /
  `xmlTextToRuns` (the only runs↔Yjs bridge; built on the node-walk factored out of
  `editor/web/internal/block-text-extensions.ts`), the `bytea` `customType`, and
  base64 encode/decode helpers.
- `plugins/primitives/plugins/collab-doc/web/index.ts` — `useCollabBlockDoc(blockId)
  → { doc, provider, undoManager }` (the `LiveStateYjsProvider` wired to
  `blockContentResource` + the doc-update endpoint; ref-counted per block).
- `plugins/page/plugins/editor-collab/server/index.ts` +
  `internal/{tables,resource,handle-doc-update,seed,projection}.ts` —
  `page_block_docs` table, `blockContentResource`, the blob ingest handler (merge +
  persist + lazy seed under `SELECT … FOR UPDATE`), and the debounced
  `content doc → data.text` projection (reuses the `handle-patch-blocks.ts` blind
  writer + `notifyStructuralChange`/`blocksChanged`).

**Modify**
- `editor/web/components/block-text-editor.tsx` — swap `RichTextPlugin` +
  `ValueSyncPlugin` → `ContentEditable` + `CollaborationPlugin(id="content",
  providerFactory)` bound to the block's `useCollabBlockDoc`.
- `editor/web/block-editor-context.tsx` — remove the **text** path
  (`commitText`/`commitRow`-for-text); split/merge call the content-doc
  seed/truncate; keep all structural APIs unchanged.
- `editor/web/internal/block-text-extensions.ts` — factor the runs↔nodes node-walk
  into `collab-doc/core`; verify every inline decorator node (page-link,
  inline-date, inline-math) has complete `importJSON`/`exportJSON` (Yjs stores node
  JSON, not the token-text round-trip) — **highest content-loss risk.**

**Delete (final stage)**
- `editor/web/components/value-sync-plugin.tsx`, the `data.text` branch of
  `optimistic-block-ops.ts`, and the `commitText`/`frozenIds`/`isPatchReflected`
  text machinery. **Structure code stays forever** (this is the key divergence from
  A's Stage 5): `applyBlockOp`, the optimistic overlay, and the `op`/`patch`
  endpoints all remain.

**Deps:** `yjs`, `@lexical/yjs` (`@lexical/react` already present). No
`y-protocols` / `y-websocket` (no wire sync protocol — transport is live-state).

## Staged migration (each stage builds, deploys, keeps the app working)

- **Stage 0 — serialization seam, no behavior change.** Add deps; factor the
  node-walk; add `runsToXmlText`/`xmlTextToRuns` with round-trip property tests
  (`runs → xmlText → runs` and `runs → xmlText → lexical → runs` are identity).
  Gate decorator-node fidelity here.
- **Stage 1 — server dark (editor unchanged).** `page_block_docs` + `bytea` type,
  `blockContentResource`, `POST /blocks/:id/doc-update` (merge + persist + lazy
  seed), debounced text projection. Validate headless: POST an update → assert
  `page_block_docs.state`, projected `data.text`, and the content resource all
  reflect it. Editor still uses `ValueSyncPlugin`.
- **Stage 2 — flip text to Yjs (per-block flag) → FIXES THE CURSOR-JUMP.**
  `block-text-editor.tsx` binds to the content doc; delete the text autosave path
  for flagged blocks. Structure path untouched. The moment text binds to the
  per-block `Y.Doc`, the rebuild path is gone → caret is safe.
- **Stage 3 — split/merge + undo.** Content-doc-aware split/merge (seed/truncate
  from runs); wire per-block `Y.UndoManager` thunks into the single undo-redo stack.
- **Stage 4 — default on.** Validate offline/reconnect (Yjs buffers local updates,
  flush on reconnect), multi-tab (one shared live-state socket), and
  agent-writes-while-user-types convergence. `replacePageContent` (history restore)
  reseeds active block docs.
- **Stage 5 — delete legacy text path** (list above). Structure pipeline remains.

## Verification

- **Convergence (headless, two clients):** interleave concurrent `type`/`split`/
  `merge`/`indent`/`move`, sync, assert both local docs **and** the projected
  `page_blocks.data.text` converge identically; property-test `(rank, id)` order.
- **Projection identity:** `seed(data.text) → xmlTextToRuns → patch` reproduces
  `data.text` byte-for-byte and fires `blocksChanged`.
- **Cursor-jump regression:** scripted fast typing while a remote update lands via
  `e2e/screenshot.mjs` against `http://<worktree>.localhost:9000/pages/...` — caret
  never moves, text never reverts.
- **Agent concurrency:** drive a `query_db`/endpoint write to a block while typing;
  assert merge, no loss.
- **Offline/reconnect + multi-tab:** disconnect mid-edit, keep typing, reconnect →
  no loss; two tabs → one `/ws/notifications` socket, both converge.
- Deploy each stage with `./equin build`; verify on
  `http://<worktree>.localhost:9000`.

## Risks & open questions

- **Decorator-node Yjs JSON** (page-link / inline-date / inline-math) — top
  content-loss risk; gated by Stage 0 round-trip tests.
- **Per-block state growth** — Yjs tombstones accumulate in a heavily-edited block's
  `state`. Bounded per block; `encodeStateAsUpdate` already compacts. Revisit only
  if a pathological block appears.
- **Undo across the two mechanisms** — cross-block merge-undo rebinding a recreated
  block's doc (Stage 3 open question).
- **Whole-block-state fan-out** — accepted for my-devices+agents. If true realtime
  multi-user is ever needed, graduate `LiveStateYjsProvider` to a delta WS provider
  behind the same `useCollabBlockDoc` seam — no editor or structure changes.
- **`@lexical/yjs@0.44` provider shape** — confirm the minimal provider interface
  (`connect`/`disconnect`/`awareness`/`on('sync')`) `CollaborationPlugin` requires,
  and that a no-awareness stub is accepted, before Stage 2.
