# Block editor: optimistic apply for structural keystroke ops

> Status: plan / awaiting implementation
> Depends on (both already landed): `optimistic-mutation` primitive and the shared
> `applyBlockOp` reducer.

## Context

In the page block editor every structural keystroke (Enter / Tab / Shift+Tab /
Backspace) is a REST round-trip to `POST /api/pages/:pageId/blocks/op`, and the
UI only changes when the `blocksResource` live-state push echoes back. There is
**no optimistic apply**, so fast chained keystrokes operate on a stale snapshot:

- **Enter → Shift+Tab** de-indents the wrong block (the just-inserted block isn't
  mounted yet, so the second keystroke resolves intent against pre-split state).
- **Enter mid-text duplicates the text**: the moved text shows in both rows until
  refresh, and sometimes *persists* — when focus jumps to the new block, the
  origin block's `useEditableField.onBlur` calls `flush()`, which `PATCH`es the
  full pre-split text back, clobbering the server's split.

Both dependencies this needs are now in the repo:

- `useOptimisticResource` (`plugins/primitives/plugins/optimistic-mutation/web`)
  — overlay/replay over `useResource`; proven on queue reorder.
- `applyBlockOp(blocks, op)` (`plugins/page/plugins/editor/core/block-ops.ts`) —
  the pure, byte-deterministic tree reducer **already run on the server** in
  `server/internal/handle-apply-block-op.ts`.

Today the client mints the op and fires it blind (`dispatchOp` →
`fetchEndpoint`); it never runs `applyBlockOp` itself. This task makes the client
apply the *same* reducer optimistically, reconcile against the push, and freeze
per-block text autosave while a structural op on that block is in flight.

## Outcome

Structural keystrokes update the document instantly and compose correctly when
chained, with no text duplication and no autosave clobber, reconciling cleanly
with the authoritative WebSocket push.

## Design

### 1. One predicate for both idempotency and confirmation

`confirmPass` runs **only on a push**, never on `mutate` resolve. So if an op's
own push lands *before* its `mutate` resolves, the op stays in `pending` and the
overlay re-applies it on a base that already reflects it — a **double apply**
(catastrophic for `split`/`insert`: two nodes with the same id → React key
collision; this is the "duplicates text" bug). Content-based confirmation alone
does not close this window, because confirmation never fires on resolve.

Fix: make `apply` idempotent. Capture, at dispatch time, a small **effect
fingerprint** of what the op produces, and reuse a single `isReflected(blocks,
effect)` predicate for **both** the apply-guard (throw `OpNoLongerApplies` when
the base already reflects the op → replay drops it) **and** `isConfirmedBy` (drop
the resolved op once the server snapshot reflects it → no early-clear snap-back).

```ts
// editor/web/internal/optimistic-block-ops.ts (new)
type OpEffect =
  | { kind: "create"; id: string }                                   // split, insert → newId appears
  | { kind: "remove"; id: string }                                   // merge, delete → blockId disappears
  | { kind: "reparent"; id: string; parentId: string | null; rank: string }; // indent/outdent/move → block at parent+rank

function isReflected(blocks: Block[], e: OpEffect): boolean {
  switch (e.kind) {
    case "create":   return blocks.some(b => b.id === e.id);
    case "remove":   return !blocks.some(b => b.id === e.id);
    case "reparent": return blocks.some(b =>
      b.id === e.id && b.parentId === e.parentId && String(b.rank) === e.rank);
  }
}
```

The overlay's `Vars` is a small wrapper, not the bare wire op:

```ts
interface BlockOverlayOp {
  op: BlockOp;          // the wire op sent to the server (unchanged)
  effect: OpEffect;     // captured at dispatch from the predicted next state
  textOwners: string[]; // block ids whose TEXT the op rewrites → freeze autosave
}
```

Wired into `useOptimisticResource<Block[], BlockOverlayOp, { pageId }>`:

- `apply(blocks, { op, effect })` → `isReflected(blocks, effect)` ? throw
  `OpNoLongerApplies` : `fromNodes(applyBlockOp(toNodes(blocks), op), blocks)`.
- `mutate({ op })` → `fetchEndpoint(applyBlockOpEndpoint, { pageId }, { body: op })`.
- `isConfirmedBy(serverData, { effect })` → `isReflected(serverData, effect)`.

Because client and server run the **same** reducer, the predicted `parentId`/
`rank` match server truth byte-for-byte, so the `reparent` exact match is robust.
`reparent` uses parent **and** rank so a same-parent reorder (`move`) isn't
falsely guarded as already-applied. (Risk: a concurrent edit from another tab
that shifts ranks between predict and apply would leave a `reparent` op
re-applying until the next push — single-user editing is unaffected; documented
below.)

**Effect + textOwners are captured at dispatch against the current optimistic
state** (post-prior-pending-ops), so chained ops compose. Captured in a thin
`dispatchOp(op)` wrapper:

| op | effect | textOwners |
|---|---|---|
| `split` | `{create, newId}` | `[blockId]` (origin text truncated) |
| `insert` | `{create, newId}` | `[]` (new block is empty) |
| `merge` | `{remove, blockId}` | `[blockId, prevSiblingId]` (prev grows) |
| `delete` | `{remove, blockId}` | `[]` |
| `indent`/`outdent`/`move` | run `applyBlockOp` once, read moved node → `{reparent, blockId, parentId, rank}` | `[]` |

### 2. `Block[]` ⇄ `BlockNode[]` adapter

`applyBlockOp` operates on `BlockNode` (no `createdAt`/`updatedAt`, `rank` as
string). `blocksResource` holds `Block` (`rank: Rank`, timestamps). Reuse the
existing `toNodes` (currently private in `block-editor-context.tsx` — move it to
the new `optimistic-block-ops.ts` and import it back) and add `fromNodes`:

```ts
function fromNodes(nodes: BlockNode[], prev: Block[]): Block[] {
  const prevById = new Map(prev.map(b => [b.id, b]));
  return nodes.map(n => {
    const old = prevById.get(n.id);
    return {
      id: n.id, pageId: n.pageId, parentId: n.parentId, type: n.type,
      data: n.data, rank: Rank.from(n.rank), expanded: n.expanded,
      createdAt: old?.createdAt ?? new Date(),   // browser Date is fine here
      updatedAt: old?.updatedAt ?? new Date(),
    };
  });
}
```

The overlay value is only rendered (never re-parsed by the resource schema), and
the render path only reads `id`/`parentId`/`rank`/`type`/`data`/`expanded`
(`block-editor.tsx` sorts by `Rank.compare`), so placeholder timestamps on new
nodes are safe.

### 3. Lift the resource read into the provider

`dispatchOp` lives in `BlockEditorProvider`, but `useResource` is one level down
in `BlockEditorInner`. Move the data source up so the provider owns dispatch +
data + freeze set:

- `BlockEditorProvider`: call `useOptimisticResource({ resource: blocksResource,
  params: useMemo(() => ({ pageId }), [pageId]), apply, mutate, isConfirmedBy })`.
  Expose via context: `blocks: optimistic.data`, `pending: optimistic.pending`,
  and `frozenIds = useMemo(() => new Set(optimistic.inFlight.flatMap(o =>
  o.vars.textOwners)), [optimistic.inFlight])`.
- `dispatchOp(op)` becomes: build `BlockOverlayOp` (effect + textOwners from
  `toNodes(rowsRef.current)`) → `optimistic.dispatch(overlayOp)`. All seven
  `makeBlockAPI` ops (`split`/`merge`/`indent`/`outdent`/`insert`/`insertAfter`/
  `remove`) keep calling `dispatchOp` unchanged and become optimistic for free.
- `BlockEditorInner`: read `blocks`/`pending` from context instead of
  `useResource`; the existing `rows`/`flat` memo, `setRows`, `setFlatOrder`
  effects are unchanged, so `rowsRef` (used for intent resolution) now tracks
  optimistic state. Because each keystroke is a distinct event, the prior op's
  `setState` → re-render → `rowsRef` update has committed before the next
  keystroke reads it — this is what makes Enter→Shift+Tab resolve correctly.

Focus already works: `focusNew(newId)` queues focus, the new block is now in
`optimistic.data` so it mounts on the next render and `registerFocusHandle` fires
the pending focus immediately (no longer waits for the round-trip).

**Out of scope** (still non-optimistic, server-roundtrip): DnD `move`, the bulk
ops (`bulkDelete`/`bulkMove`/`bulkDuplicate`/`paste`), and `updateBlock`
(text/expanded/convertTo). They don't suffer the chained-keystroke race. Listed
as follow-up.

### 4. Freeze text autosave during in-flight structural ops (`editable-field`)

The clobber: when focus jumps to the new block after a split, the origin block's
`onBlur → flush()` saves its stale full text. Add an optional `frozen?: boolean`
to `useEditableField` (`plugins/primitives/plugins/editable-field/web/use-editable-field.ts`)
meaning "the server owns this field right now — mirror `value`, never save":

- entering `frozen`: clear any pending debounce timer.
- `onChange`: update `draft` for display but schedule no save.
- `onBlur`: do **not** `flush()`.
- value echo: while `frozen`, apply incoming `value` to `draft` regardless of the
  focus/timer/save guards, and set `lastSavedRef = value` so no spurious save
  fires on unfreeze.

`BlockTextEditor` (`web/components/block-text-editor.tsx`) reads
`frozenIds.has(block.id)` from `useBlockEditor()` and passes `frozen` to
`useEditableField`. With `split` freezing `[blockId]` and `merge` freezing
`[blockId, prevSiblingId]`, no autosave can overwrite the reducer's text edit;
the origin block instantly mirrors the optimistic `beforeText`. The new block is
**not** frozen (it must save the user's continued typing); its 500 ms debounce
comfortably outlasts the op round-trip.

## Files

**New**
- `plugins/page/plugins/editor/web/internal/optimistic-block-ops.ts` —
  `BlockOverlayOp`, `OpEffect`, `isReflected`, `toNodes` (moved here),
  `fromNodes`, `applyOverlayOp` (apply-guard wrapper), and `effectFor(op,
  nodes)` / `textOwnersFor(op, nodes)` capture helpers.
- `plugins/page/plugins/editor/web/internal/optimistic-block-ops.test.ts` —
  unit tests (see Verification).

**Modify**
- `plugins/page/plugins/editor/web/block-editor-context.tsx` — call
  `useOptimisticResource`; rewrite `dispatchOp` to build + dispatch
  `BlockOverlayOp`; expose `blocks`/`pending`/`frozenIds`; remove the local
  `toNodes` (import from the new module).
- `plugins/page/plugins/editor/web/components/block-editor.tsx` —
  `BlockEditorInner` reads `blocks`/`pending` from context instead of
  `useResource`.
- `plugins/page/plugins/editor/web/components/block-text-editor.tsx` — pass
  `frozen={frozenIds.has(block.id)}` into `useEditableField`.
- `plugins/primitives/plugins/editable-field/web/use-editable-field.ts` — add the
  `frozen` option.
- `plugins/primitives/plugins/editable-field/CLAUDE.md` — document `frozen`
  (autogen "Uses"/exports refresh on build).

**Reuse (no change)**
- `applyBlockOp`, `childrenOf`, `prevSibling`, `nextSibling` —
  `editor/core/block-ops.ts`.
- `useOptimisticResource`, `OpNoLongerApplies` — `optimistic-mutation/web`.
- `applyBlockOpEndpoint`, `blocksResource`, `Block`, `BlockOp`, `BlockNode` —
  `editor/core`.

## Verification

1. **Unit** (`bun test` on the new test file):
   - `isReflected` for each `OpEffect` kind.
   - `applyOverlayOp` round-trips `Block[] → applyBlockOp → Block[]` and throws
     `OpNoLongerApplies` when the base already reflects the effect (idempotent
     replay — apply split twice yields **one** new node, not a key collision).
   - Chained ops compose: `[split, outdent]` replayed on a base that already
     absorbed the split drops the split and still applies the outdent.
2. `./equin build`, open a page at `http://<worktree>.localhost:9000`.
3. **Scripted Playwright** (`e2e/screenshot.mjs`):
   - Type text, caret mid-block, press Enter → two blocks, no duplicated text,
     visible **before** the network settles.
   - Type text, Enter, then Shift+Tab in quick succession → the **new** block
     de-indents (no stray de-indented block; origin untouched).
   - Throttle the network (DevTools/CDP) and confirm immediacy + that the push
     reconciles with no snap-back.
4. **Clobber regression**: split mid-text, immediately click another block (blur
   the origin), wait past 500 ms, refresh → the split persists (origin shows
   `beforeText`, not the full text).
5. `./equin check plugin-boundaries` and `./equin check type-check`.

## Risks

- **Concurrent rank drift**: a `reparent` op can linger re-applying if another
  client shifts ranks between predict and the confirming push. Single-user
  editing is unaffected; if it bites, loosen `reparent` confirmation to
  parentId-only for indent/outdent (keep parent+rank for `move`).
- **Fast typing into a brand-new block** before its create round-trips could
  `PATCH` a not-yet-existing id. The 500 ms autosave debounce exceeds the typical
  op round-trip, so the create lands first; documented, not guarded.
- **Replay must stay total**: only `OpNoLongerApplies` is swallowed by `replay`;
  any other throw in `applyOverlayOp` surfaces loudly (a real reducer bug).
