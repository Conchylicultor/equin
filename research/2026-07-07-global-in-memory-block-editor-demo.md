# In-memory block-editor mode + website editor demo

## Context

The public website app (`plugins/apps/plugins/website`) planned an embedded
block-editor toy on the landing page — a small live editor visitors can type in
to feel the product — but it was deferred. The design doc
([2026-07-07-plugins-website-equin-public-site.md](./2026-07-07-plugins-website-equin-public-site.md),
"Demos → editor-toy") records why: `BlockEditor` is bound to a persistent
`pageId` (reads `blocksResource`, writes server endpoints), so a throwaway demo
would either mutate shared rows per visitor or need cleanup jobs. The doc's
identified clean direction is an **in-memory / non-persisting editor mode**,
which also benefits the editor generally (drafts, previews, tests) — the task
asked the executing agent to validate that.

**Validated.** The alternatives are worse:
- *Ephemeral per-visitor page* — reuses all server logic but writes DB rows on a
  public site (unbounded growth), needs a page-create flow and a sweep job. The
  doc already rejected this; it is the wrong shape for a public deployment.
- *Hydrate `blocksResource` + no-op `mutate`* — the optimistic overlay is
  `data = pendingOps.reduce(apply, serverTruth)`, and pending ops are only
  dropped when a **server push** confirms them (`isConfirmedBy`). With no server
  there is no push, so the pending list grows unbounded; `useResource` also needs
  a live WS resource that doesn't exist, and the direct bulk/paste endpoint calls
  would still hit the server. Leaky and hacky.

The clean seam is a dedicated **in-memory block store** that is itself the source
of truth (synchronous, authoritative writes — no overlay, no confirmation). This
is feasible because the editor's write logic is *already* pure and client-side.

## Key findings (persistence map)

- **One seam.** `BlockEditorProvider` (`plugins/page/plugins/editor/web/block-editor-context.tsx`)
  is the **only** file that touches persistence. Everything downstream (block
  renderers, Lexical, DnD, selection, menus) consumes `useBlockEditor()` and never
  imports `fetchEndpoint`/`blocksResource`.
- **Op/patch path is already pure.** Typing, Enter/split, Backspace/merge,
  slash-menu convert, indent/outdent, lists, to-dos, callout/color, formatting,
  insert, delete — all flow through `optimistic.dispatch(BlockOverlayOp)` whose
  reducer `applyOverlayOp` (`web/internal/optimistic-block-ops.ts`) is pure and
  runs the **same** `applyBlockOp` the server runs. These work in memory for free.
- **Only 5 write paths hit the server directly** (bypass the overlay, rely on the
  WS push to re-render): single-block `move` (`moveBlock`), `bulkDelete`,
  `bulkMove`, `bulkDuplicate`, `paste`. `bulkDuplicate`/`paste` mint ids + ranks
  **server-side** (`insertForest` in `server/internal/forest.ts`).
- **Bulk/paste logic is almost pure already.** `rankWindow` and `serializeSubtree`
  (`server/internal/forest.ts`) are pure rank/tree algebra; `insertForest` is pure
  except its `executor.insert` calls. All rank primitives (`Rank.nBetween/from/
  compare`) come from the shared `@plugins/primitives/plugins/rank/core` module,
  available client-side. `subtreeIds`/`selectionRoots`/`isDescendant` are in
  `tree/core`. So the authoritative insert logic can be **extracted to pure
  `core/`** and shared by the server handlers *and* the memory store — zero
  divergence.
- **Rich text is storage-agnostic.** Block text is the plugin's own `RichText`
  runs model (`core/rich-text.ts`), not serialized Lexical state. Lexical is only
  the transient editing surface. Swapping persistence never touches it.
- **Attachment blocks need a server.** image/video/audio/file/bookmark/embed/cover
  call `uploadAttachment`/scrapers directly — outside the block-ops pipeline. The
  demo must exclude them from the palette (curated text palette, confirmed) **and**
  gate the raw file-drop/paste-file path.

## Design

Three parts: (A) a shared pure forest-insert core, (B) a `BlockStore` seam with
server + memory implementations, (C) the `BlockEditor` prop surface + palette
filter, (D) the demo plugin.

### A. Shared pure forest-insert core

New `plugins/page/plugins/editor/core/block-forest.ts`, operating on the reducer's
JSON-pure `BlockNode` currency (rank as string — the shape `applyBlockOp` already
uses, adapted via existing `toNodes`/`fromNodes` on the client and `rowToNode` on
the server):

- `rankWindow(nodes, parentId, afterId, excludeIds): [string|null, string|null]`
  — moved from `server/internal/forest.ts`, generalized to `BlockNode[]`.
- `serializeSubtree(nodes, rootId): SerializedBlock` — moved from server (already pure).
- `planForestInsert({ pageId, parentId, rootRanks, forest }): { nodes: BlockNode[]; rootIds: string[] }`
  — the pure core of `insertForest`: mint ids (`crypto.randomUUID()`, available
  both runtimes) + child ranks (`Rank.nBetween`), recurse, compute inherited
  `pageId` (child of a `type="page"` node scopes to that node's id, else inherits).
  Returns new node descriptors instead of inserting.

**Re-point the server** (`server/internal/forest.ts`): `insertForest` becomes
`planForestInsert(...)` + a thin loop of `executor.insert(_blocks).values(node)`;
`rankWindow`/`serializeSubtree` delegate to the core versions (adapting
`BlockRow`→`BlockNode` via the existing `rowToNode`). No behavior change — verified
by the existing server tests plus new `core/block-forest.test.ts`.

### B. `BlockStore` seam

New `plugins/page/plugins/editor/web/block-store.ts` defining the interface the
provider consumes for **all** reads/writes:

```ts
export interface BlockStore {
  data: Block[];
  pending: boolean;
  frozenIds: ReadonlySet<string>;
  dispatch: (v: BlockOverlayOp) => void;          // op + patch
  move: (id: string, dest: { parentId: string | null; rank: Rank }) => void;
  bulkDelete: (ids: string[]) => void;            // apply only; recording stays in provider
  bulkMove: (args: { ids: string[]; parentId: string | null; afterId: string | null }) => void;
  bulkDuplicate: (ids: string[]) => Promise<string[]>;
  paste: (args: { blocks: SerializedBlock[]; afterId: string | null; parentId?: string | null }) => Promise<string[]>;
}
```

Two implementations, same shape:

- **`useServerBlockStore(pageId)`** — extracts today's code verbatim: the
  `useOptimisticResource(blocksResource, …)` instance (data/pending/dispatch,
  `frozenIds` from `inFlight`), and the 5 direct endpoint calls (`moveBlock`,
  `bulkDeleteBlocks`, `bulkMoveBlocks`, `bulkDuplicateBlocks`, `pasteBlocks`).
- **`useMemoryBlockStore({ pageId, initialBlocks })`** — `useState<Block[]>`, thin
  over the shared pure helpers:
  - `pending: false`, `frozenIds: EMPTY` (writes are synchronous — no in-flight).
  - `dispatch(v)`: `setRows(cur => applyOverlayOp(cur, v))`, catching
    `OpNoLongerApplies` → return `cur`. **Byte-identical op/patch semantics to the
    server** (same reducer).
  - `move`: `applyBlockOp(toNodes(cur), { kind: "move", … })` via `fromNodes`.
  - `bulkDelete`: filter out `subtreeIds(cur, id)`.
  - `bulkMove`: `selectionRoots` + `rankWindow` + `Rank.nBetween` + set parent/rank
    on roots (single synthetic page → no cross-page `pageId` recompute needed).
  - `bulkDuplicate`/`paste`: `serializeSubtree` the roots (duplicate) / take the
    forest (paste) → `planForestInsert` under the resolved parent/after → append →
    return `rootIds` (resolved synchronously via `Promise.resolve`).

**Provider change:** `BlockEditorProvider` picks a store by mode and delegates all
writes to it. Recording/undo (`recordStructural`, `commitRow`, `diffBlocks`,
`patchesFromDiff`), focus management, and `makeBlockAPI` are pure and storage-
agnostic — they stay put and call `store.dispatch`/`store.move`/`store.bulkDelete`.
Undo/redo (patch → `store.dispatch` → `applyOverlayOp`) works in memory unchanged.

### C. `BlockEditor` prop surface + palette filter

Discriminated props on `BlockEditor` (`web/components/block-editor.tsx`):

```ts
type BlockEditorProps =
  | { pageId: string; /* persistent (default) */ … }
  | { persist: false; initialContent?: SerializedBlock[]; enabledBlockTypes?: readonly string[]; … };
```

- Memory mode generates a stable synthetic `pageId` (`useMemo(() => crypto.randomUUID(), [])`)
  — rows still carry a `pageId`, and `keyboard-plugin.tsx`'s indent/outdent
  (`node.parentId !== pageId`) and `insert`'s `parentId: pageId` keep working
  unchanged. `initialContent` (portable `SerializedBlock[]`, no ids) is materialized
  once at mount via `planForestInsert` under that synthetic page.
- **Palette filter:** thread an optional `enabledBlockTypes` predicate through the
  `BlockEditor` context; `useInsertableBlocks`/`filterBlockTypes` (already exported
  from the barrel) and the slash / add-block menus apply it. General capability,
  not demo-specific.
- **Gate attachment paths in memory mode:** when `persist === false`, skip the
  file-drop / paste-file attachment handling in `block-editor.tsx`
  (`onFileDrop`/`resolvePastedBlock`) so a dropped image can't reach
  `uploadAttachment`.

### D. Demo plugin

`plugins/apps/plugins/website/plugins/demos/plugins/editor-toy/` (mirrors the
`theme-toy` sibling):
- `web/index.ts` — contributes `Website.Section` (order ~40, after theme-toy's 30).
- `web/seed.ts` — the `SerializedBlock[]` seed doc (equin-flavored: a heading, a
  paragraph, a short to-do list, a callout) + the text-block allowlist.
- `web/components/editor-toy.tsx` — a framed `Surface`/`Card` with a heading and
  `<BlockEditor persist={false} initialContent={SEED} enabledBlockTypes={TEXT_BLOCKS} contentClassName=… />`.
  Optional "Reset" that remounts to reseed.
- `package.json`, `CLAUDE.md`.

The demo mounts with no `NotificationsProvider` dependency (memory store never
calls `useResource`); `BlockEditor` supplies its own Undo/MultiSelect/Selection
providers, and block renderers for the text family are pure client-side.

## Critical files

Create:
- `plugins/page/plugins/editor/core/block-forest.ts` (+ `block-forest.test.ts`)
- `plugins/page/plugins/editor/web/block-store.ts` (interface + `useServerBlockStore` + `useMemoryBlockStore`)
- `plugins/apps/plugins/website/plugins/demos/plugins/editor-toy/{package.json,CLAUDE.md,web/index.ts,web/seed.ts,web/components/editor-toy.tsx}`

Modify:
- `plugins/page/plugins/editor/web/block-editor-context.tsx` — consume `BlockStore`; keep recording/undo/focus/makeBlockAPI; add `enabledBlockTypes` to the context.
- `plugins/page/plugins/editor/web/components/block-editor.tsx` — discriminated props (`persist`/`initialContent`/`enabledBlockTypes`); gate attachment file-drop/paste when `persist === false`.
- `plugins/page/plugins/editor/server/internal/forest.ts` — delegate `insertForest`/`rankWindow`/`serializeSubtree` to `core/block-forest.ts`.
- The slash / add-block menus (`web/components/slash-menu-plugin.tsx`, `add-block-menu.tsx`) — apply the `enabledBlockTypes` filter.
- Autogenerated registries regenerate via `./equin build`.

## Key reuse (paths)

- Pure reducer + adapters: `core/block-ops.ts` (`applyBlockOp`), `web/internal/optimistic-block-ops.ts` (`applyOverlayOp`, `applyPatch`, `toNodes`, `fromNodes`, `OpNoLongerApplies`).
- Diff/undo: `core/block-diff.ts` (`diffBlocks`, `patchesFromDiff`).
- Rank/tree: `@plugins/primitives/plugins/rank/core` (`Rank.nBetween/from/compare`), `@plugins/primitives/plugins/tree/core` (`subtreeIds`, `selectionRoots`, `isDescendant`).
- Serialize: `web/serialize-blocks.ts` (`serializeForest`), `core/serialized-block.ts`.
- Demo pattern: `plugins/apps/plugins/website/plugins/demos/plugins/theme-toy/`.
- Server insert logic being extracted: `server/internal/forest.ts`, `handle-paste-block.ts`, `handle-bulk-move-block.ts`, `handle-bulk-duplicate-block.ts`.

## Verification

- **Pure tests** (`bun test plugins/page/plugins/editor/core/block-forest.test.ts`):
  `planForestInsert` id/rank minting + `pageId` inheritance (incl. under a
  `type="page"` node), `rankWindow` positioning, `serializeSubtree` round-trip.
  Confirm server `insertForest` still passes its existing suite after re-pointing.
- **Build + checks:** `./equin build`, then `./equin check` (boundaries,
  registry sync, lints, type-check).
- **Manual, `http://<worktree>.localhost:9000/website`:** scroll to the demo and
  exercise the full editor — type, Enter/split, Backspace/merge, formatting toolbar,
  slash-menu to add heading/list/to-do/callout/code, indent/outdent, multi-select
  delete, drag-reorder, duplicate, paste. All must work.
  - Confirm **nothing persisted**: `query_db` shows no new `page_blocks` rows; the
    logs / network show no `/api/pages/.../blocks/*` calls; reload → the seed doc
    returns unchanged.
  - Confirm the palette excludes image/video/file/etc., and a dropped image file
    does not trigger an upload.
- **Screenshots:** `bun e2e/screenshot.mjs` scripted run — type into the demo,
  capture before/after; plus a static landing snapshot showing the demo section.

## Rebase onto main (integration notes)

Landed after main gained server-owned rank authority, the sync-status cloud, and
the sub-page/`TurnInto` action. Four seams had to absorb those:

- **`move` is positional, not a rank.** Main moved rank authority to the server
  (`MoveBlockBody = {parentId, targetId, zone}`) because `page_blocks`' single
  `(parent_id, rank)` space is projected disjointly by several live resources.
  `BlockStore.move` now takes a `BlockMoveDest` carrying BOTH the wire intent and
  the provider's `computeDrop` rank prediction: the server store ships only the
  intent; the memory store — its own rank authority over a forest it holds whole
  — applies the prediction directly. Neither half is redundant.
- **`BlockDocProvider` grew the save-state trio** (`onSaveState`/`getSaveState`/
  `retryFlush`), so `LocalYjsProvider` implements it as a constant
  `IDLE_SAVE_STATE`. Both doc hooks return the same `CollabBlockDoc`, and the
  shared `CollabBinding` is the one per-block `useReportSync` reporter.
- **`Editor.TurnInto` is server-backed by construction** (it re-partitions
  `page_id` across a page boundary), so the block-actions menu gates the whole
  zone on `serverSync` — the same rule as `allowAttachments`, not a per-contributor
  exception.
- **`insertFirst` / `BlockEditorHandle`** (main's page-title Enter affordance) are
  storage-agnostic — `beforeId` is a pure-reducer insert — so `ref` sits on the
  shared half of the `BlockEditorProps` union and works in memory mode too.

One silent auto-merge defect was caught here: our extraction had downgraded
`forest.ts`'s `Rank` import to `import type`, while main's new `rankAdjacentTo`
(appended to that file) calls `Rank.between`/`Rank.from` at runtime.

## Follow-ups (out of scope)

- Fold the remaining 5 direct write paths (`move`/`bulkMove`/`bulkDuplicate`/`paste`)
  into the server store's optimistic pipeline for network confirmation, and record
  `bulkMove`/`bulkDuplicate`/`paste` on the undo stack (existing editor follow-up,
  now easier with the shared `planForestInsert`).
- An in-memory "new page draft" affordance (type before committing) — a natural
  second consumer of `persist={false}`, validating the generality claim.
