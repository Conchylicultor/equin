# Page editor → CRDT (Yjs + @lexical/yjs)

## Context

Typing fast in a page text block jumps the cursor and scrambles text
("Generalization of Notion" → "Generationlization of No"). Root cause: text
autosave round-trips through a serialized `RichText`-JSON string and an integer
caret-offset restore (`value-sync-plugin.tsx`), guarded by a fragile pile of
conditions (`frozen`/`frozenIds`/`focusedRef`/`timerRef`/`savePromiseRef`/
`selfWriteRef`/`lastSerializedRef`), plus an optimistic-overlay collapse whose
confirmation predicate `isPatchReflected` (`web/internal/optimistic-block-ops.ts:76`)
checks `parentId|type|rank|expanded` but **never `data.text`**. A
structurally-matching-but-textually-stale server snapshot confirms the in-flight
text patch, collapses the overlay back to old text mid-typing, and
`ValueSyncPlugin` rebuilds Lexical from that stale string and clamps the caret.

A `data`-comparison patch would close this one leak, but caret-safety would still
be load-bearing on ~7 interacting guards and content heuristics — fragile by
construction (two writers to the visible text + a lossy string-rebuild + offset
clamp). **Decision (user): go to a real CRDT now, targeting Yjs + the official
`@lexical/yjs` collaboration binding**, with abstractions designed toward Yjs from
the start rather than a throwaway interim. The cursor-jump becomes *structurally
impossible* because remote/echoed changes apply as relative-position transforms,
never a full rebuild.

This is a staged, multi-PR migration. The bug is eliminated at **Stage 2**.

## Target architecture

**One `Y.Doc` per page.** Two top-level shared types:

- `ydoc.getMap("blocks")` — `Y.Map<blockId, Y.Map>`: the block **tree**. Each
  entry holds `parentId`, `rank` (existing `rankText` fractional index), `type`,
  and `data: Y.Map` for **non-text** type payload (image src, todo checked,
  callout color, code, equation latex, …). Order is `(rank, blockId)`.
- `ydoc.getMap("text")` — `Y.Map<blockId, Y.XmlText>`: per-text-block rich text.

Each `BlockTextEditor` keeps its own Lexical instance and binds it to its block's
`Y.XmlText` via `@lexical/yjs` `CollaborationPlugin` (multiple editors over one
shared doc, distinguished by `id = blockId`). React still renders the tree from
the `blocks` map; the page is **not** collapsed into one Lexical document (the
rich non-text block types make that infeasible and it contradicts the repo's
"row tree, not a Lexical doc, is the source of truth" design).

**Why `Y.Map`-by-rank, not `Y.Array`** (deviation from first sketch): the reducer
and the entire downstream are already rank-ordered, so the projection to
`page_blocks` is a near-identity copy and `applyBlockOp`'s `Rank.between`/
`Rank.nBetween` math ports unchanged. A move/indent is a key write (`parentId`+
`rank`) that converges by per-key LWW — a block can never be duplicated or
orphaned (its identity is the map key), unlike `Y.Array`'s non-atomic move.
Concurrent inserts can mint the same `Rank.between(a,b)`; that is a visual tie,
not corruption — resolved deterministically by the `(rank, blockId)` tiebreak
applied identically in **render, projection, and reducer** (one comparator).

**`expanded` stays local view-state**, NOT in the shared doc (deviation): today
it is treated as per-user state (`setExpanded` records `record:false`); putting
it in the shared map would make one user's collapse flip everyone's. Keep it in
client state / awareness.

**Server is the authority + projection bridge.** An in-memory authoritative
`Y.Doc` per active page relays sync to all clients and persists to Postgres. A
**debounced observer projects the Y.Doc → `page_blocks` rows** (~500ms) and fires
the existing `blocksChanged` event. So the entire downstream ecosystem
(full-text search, backlinks, history snapshots, reminders, read-only renderer,
attachments reconcile, starred/story ext tables) keeps reading `page_blocks`
**unchanged** — only live editing reads the Y.Doc. `data.text` runs remain the
stable contract between Yjs and everything downstream.

**Caret/cursors become native** (Lexical + Yjs relative positions). The custom
`$linearCaretOffset`/`$placeCaretAtLinearOffset` (`block-text-extensions.ts`) is
retained only for the two cross-editor placements (merge join offset, arrow-key
column landing). Remote-user cursors come free via awareness (wired now, rendered
later for multi-user).

**Undo/redo = one `Y.UndoManager` per page** over both `blocks` + `text`, scoped
to local origin. Tracking both shared types in one manager preserves the unified
chronological text+structure stack the editor documents today, replacing the
custom `recordPatchEntry`/`commitRow`/`diffBlocks` apparatus. `captureTimeout`
~500ms matches typing-run coalescing; `stopCapturing()` at structural boundaries
matches "structural ops never coalesce".

## Structural ops as Y.Doc transactions

`applyBlockOp` (`core/block-ops.ts`) stays the **pure spec** of the post-op tree
but now drives a Y-mutation: compute `before→after` `BlockNode[]`, then
`reconcileBlocks` (`server/internal/reconcile.ts`) writes only changed keys into
the `blocks` map inside one `ydoc.transact` (= one undo step). The `BlockEditorAPI`
surface (`split`/`merge`/`indent`/…) is unchanged for its ~40 consumers; only the
implementation moves from optimistic-POST to Y-transaction.

- **Split**: one transaction — truncate origin `Y.XmlText` to `[0,pos)`, create
  the new block entry, insert `[pos,end)` into the new `Y.XmlText` via Yjs delta
  ops (preserving marks + decorator nodes, no re-serialization). Caret via
  relative position; no rebuild.
- **Merge** (the one case where text legitimately enters a focused editor today):
  one transaction — append the merging block's `Y.XmlText` onto the target's at
  `joinOffset = targetLen`, reparent children, delete the merged block's tree +
  text entries. Caret pinned to a relative position at the join. This *replaces*
  the `ValueSyncPlugin`-flows-text-in mechanism with a direct CRDT content move.
- `indent`/`outdent`/`move`/`delete`/`insert`/`convert` touch only `blocks` — they
  cannot move a focused caret.

## Key abstractions (new plugins, one barrel per runtime)

1. **`plugins/primitives/plugins/collab-doc`** — the CRDT-document primitive (only
   client place importing `yjs`).
   - `web`: `CollabProvider` (a `@lexical/yjs`-compatible provider with injected
     transport), `useCollabDoc(docId) → { doc, provider, undoManager }`
     (ref-counted per page), `providerFactoryFor(doc, provider)` for
     `CollaborationPlugin`.
   - `core`: **`runsToXmlText`** + **`xmlTextToRuns`** — the only Yjs↔runs bridge,
     shared by server seed, server projection, and client seed. Built on the
     runs↔nodes node-walk factored out of `block-text-extensions.ts`.
2. **`plugins/primitives/plugins/yjs-transport`** (web) — `createYjsTransport(pageId)
   → { send, onMessage, connect, disconnect, status }` over the existing cross-tab
   `SharedWebSocket` to `/ws/yjs/:pageId`. Keeps `CollabProvider` ignorant of
   equin networking.
3. **`plugins/page/plugins/editor-collab`** (server) — `wsRoutes:
   { "/ws/yjs/:pageId" }` relay; `PageDocRegistry` (hydrate/ref-count/evict); the
   debounced projection (`Y.Doc → page_blocks → blocksChanged`); persistence
   (`page_ydoc`, `page_ydoc_updates` + compactor); seed (rows→Y.Doc). Reuses
   `serializePageContent`, `reconcileBlocks`, the row writers, `notifyStructuralChange`.
4. **Editor changes stay in `page/plugins/editor`**: `block-text-editor.tsx` swaps
   `RichTextPlugin`+`ValueSyncPlugin` → `CollaborationPlugin`; a new internal
   `yjs-block-ops.ts` (`applyBlockOpToDoc(doc, op)`) backs the unchanged
   `BlockEditorAPI`.

**Transport decision** (deviation): build an equin-native provider over
`SharedWebSocket` using `y-protocols/sync`+`awareness` for framing — do **not**
adopt `y-websocket`, which opens its own per-tab socket and bypasses the shared
cross-tab leader, reconnect, and net-diagnostics the app relies on. Server side
is a plain `wsRoutes` entry; `/ws/*` is already proxied by the gateway with
upgrade, so **no gateway and no central-core changes**.

Deps to add: `yjs`, `@lexical/yjs`, `y-protocols` (`@lexical/react` already
present). No CRDT lib is installed today.

## Server persistence & projection

```
page_ydoc(page_id pk → page_blocks, state bytea, updated_at)            -- compacted snapshot
page_ydoc_updates(id bigserial pk, page_id, update bytea, created_at)   -- append log
```

- **Registry**: first WS subscriber hydrates (load `state` + replay log); doc
  resident while ≥1 client connected; flush + compact + evict after a grace
  period. **Invariant: append each update to the log before ack/rebroadcast**, so
  a crash can't lose an update a peer already saw (peer re-syncs on reconnect).
  Handles the gateway hot-restart drain.
- **Seed**: on first open with no `page_ydoc.state`, build `blocks` from
  `serializePageContent(pageId)` and each `Y.XmlText` from `data.text` via
  `runsToXmlText`. Idempotent, per-page, behind a `pageId` advisory lock — **no
  global backfill**; pages migrate lazily on first open.
- **Projection** (debounced ~500ms): doc → `BlockNode[]` (tree ordered by
  `(rank, blockId)`; text via `xmlTextToRuns`) → `reconcileBlocks` vs current rows
  → upsert/delete in one tx (reuse `handle-patch-blocks.ts`'s blind writer) →
  `notifyStructuralChange`. One-directional; relational rows are never >~500ms
  stale, so they double as the safety net if Yjs is ever rolled back.

## Staged migration (each stage builds, deploys, keeps the app working)

- **Stage 0 — deps + serialization seam (no behavior change).** Install deps;
  factor the node-walk out of `block-text-extensions.ts`; add `runsToXmlText`/
  `xmlTextToRuns` with round-trip property tests (`runs→xmlText→runs` and
  `runs→xmlText→lexical→runs` are identity). Verify every inline decorator node
  (page-link, inline-date, inline-math) has complete `importJSON`/`exportJSON`
  (Yjs uses node JSON, not the token-text round-trip) — **highest content-loss
  risk; gate it here.**
- **Stage 1 — server authority + transport + projection, dark (flag off).** New
  `editor-collab` server plugin (`/ws/yjs/:pageId`, registry, `page_ydoc` tables,
  seed, projection), `yjs-transport`, `collab-doc`. Validate with a headless
  client: edit the Y.Doc, assert `page_blocks` + `blocksChanged` reflect it. App
  unchanged.
- **Stage 2 + 3 together, per-page flag — ELIMINATES THE CURSOR-JUMP.** Flip the
  flag = "this page is a Yjs page" for **text and tree at once** (deviation: never
  ship the text-in-Yjs / tree-in-rows split-brain state — it's the riskiest
  partial and the split/merge bridge spanning both worlds is the failure mode).
  - Stage 2 (text): `block-text-editor.tsx` → `ContentEditable` +
    `CollaborationPlugin(id=blockId, shouldBootstrap=false)`; delete the text-path
    `useEditableField` wiring. **The moment text binds to Yjs, the full-rebuild
    path is gone → bug fixed.** (Keep as a separate PR for review.)
  - Stage 3 (tree+undo): structural ops → Y-transactions via `yjs-block-ops.ts`;
    render tree from the `blocks` map; undo/redo → `Y.UndoManager`; split/merge
    become atomic two-XmlText transactions. Delete (for flagged pages) the
    optimistic overlay, `frozenIds`/`textOwners`, `isPatchReflected`/`isReflected`,
    `commitRow`/`commitText`/`recordPatchEntry`, `value-sync-plugin.tsx`.
  - **Fail-loud fallback**: if seed/sync fails, render read-only from `page_blocks`
    (always current via projection) with a reconnect banner — never silently drop
    to the legacy editor (split-brain).
- **Stage 4 — default flag on.** `replacePageContent` (history restore) reseeds
  active Y.Docs (clients re-sync). Optionally render awareness cursors. Validate
  offline/reconnect/multi-tab at scale.
- **Stage 5 — delete legacy.** Remove the flag, `handle-apply-block-op.ts`,
  `handle-patch-blocks.ts`, the `op`/`patch` routes, `optimistic-block-ops.ts`,
  `value-sync-plugin.tsx`, and the dead freeze/confirm code. `page_blocks` +
  `blocksChanged` + projection remain forever.

## Critical files

**Add:** `plugins/primitives/plugins/collab-doc/{web,core}/index.ts`;
`plugins/primitives/plugins/yjs-transport/web/index.ts`;
`plugins/page/plugins/editor-collab/server/index.ts` +
`internal/{page-doc-registry,yjs-ws-handler,projection,persistence,tables,seed}.ts`;
`plugins/page/plugins/editor/web/internal/yjs-block-ops.ts`.

**Modify:** `plugins/page/plugins/editor/web/components/block-text-editor.tsx`;
`plugins/page/plugins/editor/web/block-editor-context.tsx`;
`plugins/page/plugins/editor/web/internal/block-text-extensions.ts` (factor
node-walk; verify decorator JSON); `plugins/page/plugins/editor/server/internal/page-content.ts`
(`replacePageContent` reseeds active docs); keep
`plugins/page/plugins/editor/core` exporting `applyBlockOp`/`reconcileBlocks`.

**Delete (Stage 5):** `value-sync-plugin.tsx`, `optimistic-block-ops.ts` (+test),
`handle-apply-block-op.ts`, `handle-patch-blocks.ts`, the op/patch routes, and the
`commitText`/`commitRow`-text/`frozenIds` code in `block-editor-context.tsx`.

Block ids are stable through the migration (Yjs map keys = row ids), so
`apps/pages/starred` and `apps/story/marker` ext tables are untouched.

## Risks & open questions

- **Decorator-node Yjs JSON** (page-link/inline-date/inline-math) — top
  content-loss risk; gated by Stage 0 round-trip tests.
- **`Y.UndoManager` cross-block merge undo** rebinds a recreated block — verify in
  Stage 3; fallback to manual capture boundaries.
- **Server doc memory** — one resident doc per active page; bound via eviction +
  log compaction.
- **Rank ties** — the `(rank, blockId)` comparator must be applied in render,
  projection, AND reducer or ordering diverges.
- **Open:** confirm `@lexical/yjs@0.44` `providerFactory` returns one shared
  provider across many `id`s (multi-root pattern is version-sensitive — check
  before Stage 2). Projection debounce vs search freshness (500ms; history is
  already 4s — likely fine).

## Verification

- **Convergence:** headless multi-client — apply random concurrent op sequences
  (type/split/merge/indent/move), sync, assert all docs + projected `page_blocks`
  converge identically; property-test `(rank, blockId)` order.
- **Projection identity:** for real pages, `seed(rows) → xmlTextToRuns →
  reconcile` reproduces `page_blocks` byte-for-byte and fires `blocksChanged`.
- **Cursor-jump regression:** scripted fast-typing while a remote update lands —
  caret never moves, text never reverts (the original bug). Use
  `e2e/screenshot.mjs` against `http://<worktree>.localhost:9000/pages/...`.
- **Offline/reconnect:** disconnect mid-edit, keep typing (Yjs buffers), reconnect,
  assert merge with no loss.
- **Multi-tab:** two tabs over the shared socket; edit both; assert convergence +
  a single `/ws/yjs` socket.
- **Undo interleave:** type/split/type/merge then Cmd+Z repeatedly; assert
  chronological text+structure interleaving + correct focus.
- Deploy each stage with `./equin build`; verify on
  `http://<worktree>.localhost:9000`.
