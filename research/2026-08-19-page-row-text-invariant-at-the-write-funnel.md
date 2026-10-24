# The row's text rule belongs to the write funnel, not to its callers

*2026-08-19 — page/editor*

## Context

Converting a text block into a void block type (`/divider`, `/image`, `/embed`,
`/place`, …) posts a patch the server rejects:

```
HTTP 400 POST /api/pages/<pageId>/blocks/patch
Invalid data for block type "divider": (root): Unrecognized key(s) in object: 'text'
```

Nothing visibly breaks, because the write that establishes the new type is a
*different* write that succeeds. What is left behind is a rejected write and a
console error on every text→void conversion.

Chasing it down turned up the same hole in the opposite direction, and there the
rejected write is the *only* write — so the conversion is genuinely lost.

The server boundary is right and must not move. `parseBlockData`
(`plugins/page/plugins/editor/server/internal/parse-block-data.ts`) parses a
block's `data` against its type's `.strict()` schema and states its stance:
*"Unknown keys are a LOUD 400, never stripped: silently canonicalizing the write
would hide the class of bug this boundary exists to catch."* Both halves are
pinned by unit tests (`parse-block-data.test.ts`: "a MISSING text key on a
text-bearing type is a loud 400", "a void type with an injected text key is
still a 400") and by two e2e scripts (`annotations-verify.ts`,
`context-container-verify.ts`).

So the boundary is fine. The client violates it, in both directions.

## What is actually happening

### The reported direction: text → void

Text has exactly one owner: the block's per-block `Y.Doc`.
`page_blocks.data.text` is a ~1s-debounced *projection* of it. Three writers in
`block-editor-context.tsx` may name `text`, and only two know the rule:

1. `convertStrippingText` (~1564) deletes the `/divider` query from the block's
   `Y.Doc`, then calls `convertRow`.
2. `convertRow` (~1536) writes the new type through `commitRow`, with
   `data: preserveText(b.data, data, acceptsTextRef.current(type))`.
   `preserveText` (~221) **drops** `text` for a text-less target.
   **This write is correct, and it is the whole conversion.**
3. The doc mutation in (1) armed the debounced projection
   (`use-collab-block-doc.ts`). The text renderer then unmounts — the row is a
   divider now — and its teardown runs `flushProjection({ final: true })`.
4. `projectText` (~1062) does
   `commitRow(id, b => ({ ...b, data: { ...(b.data ?? {}), text: runs } }))`.
   It gates on the row **existing**, never on the row's **type**. Its patch
   names only `data` → `{ text: [...] }` at a row the server knows is a
   `divider` → 400.

**Answer to "is the surviving row written by the op that was NOT rejected?"**
Yes. Write (2) succeeds and is the conversion; write (4) is redundant and should
never have been sent.

*Turn into → Page* reaches the identical failure by a different route:
`turnBlockIntoPage` posts a server endpoint with no overlay, and when the push
lands the row's type is `page` — registered and void (`sub-page/core`,
`PageDataSchema`) — so the text renderer unmounts and the same final flush fires.
Same bug, no slash menu involved.

### The unreported direction: void → text — and here the conversion IS lost

A void block is `convertible` in the rail menu (`block-actions-menu.tsx:86` —
everything except a `page` row), so a divider offers *Turn into → Text*
(`:195`, `api.convertTo(target.type, target.emptyRowData())`).

- `emptyRowData()` is `rowDataOf(empty())` — the target's defaults **minus**
  `text` (`define-block.ts:377`) — so `page/text`'s `{ text: [] }` becomes `{}`.
- `preserveText({}, {}, true)` finds no prior text and returns `{}`.
- `parseBlockData("text", {})` → `RichTextSchema` is a bare array with no default
  (`core/rich-text.ts:111`) → **400 `text: Required`, and that patch is the only
  carrier of the conversion.**

Nothing is written. The optimistic overlay never reverts, so the block looks
converted until reload, when it is a divider again.

**Answer to "could a void type lose data because the only write carrying it was
the rejected one?"** In the reported direction, no — the projection patch's blob
is `{...b.data, text}`, a superset of what is already persisted, so it is never
the sole carrier of anything. In the mirror direction, yes: the whole conversion
rides the rejected write.

Empirically main's DB is clean — no void row carries `text`, every text-bearing
row has it, and every void row carries its real payload
(`select type, count(*) filter (where data ? 'text') from page_blocks group by type`).
The server boundary held; nothing is corrupt on disk.

### The cost that is not just a console error

A durable HTTP rejection is classified `{kind:"http"}`
(`use-optimistic-resource.ts:409`); the reconnect drain re-fires **network**-failed
ops only (`:515`), and failed ops are immune to confirm / cascade / denial
(`overlay.ts:172`). So the doomed patch neither retries itself nor wedges the
send lane — it sits in the overlay forever, rendering its prediction, and the
surface's forced sync reporting (`:580`) parks the page's save indicator on
**error** with a Retry button that re-fails. **No user action clears it short of
a reload.**

## Root cause

`commitRows` (~975) is the documented *"single chokepoint for any DIRECT row-set
mutation"*. The rule about `text` does not live there — it lives at two **call
sites** (`preserveText`, `rowDataOf`), so the third writer never observes it and
neither half of the biconditional is enforced anywhere:

> `data.text` is present on a row **iff** the row's type accepts text.

`acceptsText` is already a derived fact, not a flag (`"text" in schema.shape`,
`define-block.ts:359`), and is already reachable from the provider
(`acceptsTextRef`, ~631). It just isn't consulted where writes land.

## The fix

Conform each row the transform **authored** to the rule, in `commitRows`, before
the diff:

```ts
// The row model's one text rule, enforced where direct row writes land.
// `data.text` exists on a row IFF its type accepts text: the projection is
// meaningless on a void type (whose strict schema 400s on the key) and required
// on a text-bearing one (whose strict schema 400s on its absence). Writers state
// their intent; this is where that intent meets the row model — so no writer,
// `projectText` included, has to remember either half.
const conformRowText = useCallback((row: Block): Block => {
  const handle = blockHandlesRef.current.get(row.type);
  // No registered handle, NO OPINION — deliberately not the same branch as a
  // void handle. A type can be absent because it was renamed or removed while
  // its rows live on (see the agent_notes rename migration), because the host
  // mounted a subset of plugins, or because the row belongs to another page in
  // the composite union. Stripping those rows' `text` would delete content;
  // filling them would invent the very key this exists to keep out. An unknown
  // type still reaches the write boundary and is still rejected loudly.
  if (!handle) return row;
  const data = (row.data ?? {}) as Record<string, unknown>;
  // `handle.text` is the declared text lens, present IFF the type is
  // text-bearing — the same fact `acceptsText` is derived from.
  if (!handle.text) {
    return data.text === undefined ? row : { ...row, data: rowDataOf(data) };
  }
  return data.text !== undefined
    ? row
    : { ...row, data: { ...data, text: handle.text(handle.empty?.() ?? {}) } };
}, [blockHandlesRef]);
```

and, in `commitRows`:

```ts
const before = liveRowsRef.current;
const byId = new Map(before.map((b) => [b.id, b]));
// Conform only rows this write AUTHORED. `after` is the whole row set — over
// the composite host, the union of several pages — and every writer here
// returns `b` unchanged for rows it did not touch, so identity is an exact
// test. Conforming the rest would sweep an unrelated row into this write's
// patch, under this write's undo label, or (for `setExpanded`, `record:false`)
// as an unrecorded, unundoable data write.
const after = transform(before).map((r) => (byId.get(r.id) === r ? r : conformRowText(r)));
```

**Conform `after` only.** `before` stays untouched, so `patchesFromDiff`'s undo
update — `fieldsOf(u.before, u.changes)` (`block-diff.ts:165`) — still restores
the pre-conversion row *with* its `text`, and undo of a text→void conversion
keeps working. Conforming `before`, or conforming inside `diffBlocks`, would make
undo restore a text row with no `text` — a loud 400 the other way. This is the
single most likely way to reintroduce the bug, so it belongs in the comment.

`advanceRows(after)` publishes the same conformed array; if the conform is ever
moved between the diff and the dispatch, the same-turn replay path rebuilds on
unconformed rows and the next diff resurrects the key.

### What falls out

- **text → void.** `projectText`'s blob loses `text`, becomes identical to the
  row, `isEmptyPatch` (`:1001`) short-circuits — the redundant patch is not
  *rejected*, it is **never sent**. Same for the *Turn into → Page* trigger.
- **void → text.** `convertRow`'s `data: {}` gains `text: []`, so the patch is
  one the server accepts and the conversion persists.
- **`preserveText` loses its `targetAcceptsText` parameter** and reduces to what
  its name says. `acceptsTextRef` (~631) and its `blockContributions` lookup then
  have no reader and go away, replaced by one `useLatestRef` over the
  `blockHandles` map already in scope (~620); drop it from `convertRow`'s dep
  list (`:1561`) too. The unregistered-type default is unchanged by this
  collapse: `preserveText` keeps text for unknowns today (`acceptsTextRef`
  returns `true`), and the conform's `!handle` branch keeps it too — verify that
  explicitly when deleting the ref, since three different defaults for
  "unregistered" exist in the tree and only two are safe.

Two honest costs of the fill:

- It can write a row-level lie for one projection window. text→divider→text on
  one block id: the divider conversion never deletes `page_block_docs`, so the
  doc still holds the old text; the fill writes `[]` and the ~1s projection
  corrects it. Self-healing, but every *row* reader (read_page/markdown,
  backlinks, content search, history snapshots) briefly sees an empty block that
  isn't.
- `handle.text(handle.empty?.() ?? {})` is always `[]` — `text` is installed as
  `(data) => runsOf(data.text)`. Reading it through the type's own lens is an
  ownership argument, not a behavioural one; no type can fill something else.
  The blast radius is genuinely one key: across every void schema
  (`image`, `embed`, `bookmark`, `place`, `file`, `video`, `audio`, `divider`)
  all fields are optional, so **`text` is the only required field in the whole
  block registry**.

### Why this rung

Rung 1/2 is unreachable: block types are an open string-keyed registry, so
`Block["data"]` cannot be a discriminated union over them. The funnel is where
the constraint can be stated once.

There is working precedent for the rule in the same plugin tree: the
agent-facing write path enforces it off the same `handle.text` lens, in both
directions — `survivorData`, `plugins/page/plugins/markdown-apply/core/plan.ts:206`,
whose comment names the case (*"the removal of a `text` key a text→void
conversion leaves behind, which that type's strict schema would otherwise
reject"*). **Do not copy its spelling.** `survivorData` opens with
`if (!handle?.text) return incoming;`, conflating *no handle* with *void
handle* — safe there because it never strips, wrong here because this conform
does. The two branches must stay separate, which is what the comment above is
for.

### The second writer: the `BlockOp` reducer (folded in)

`commitRows` is the only path to `dispatchPatch` **for direct row-set writes**,
but not the only path to the patch endpoint. `dispatchOp` (`:1093`),
`applyOverlay` (`:1275`) and `mergeBlock` (`:1404`) diff raw `applyBlockOp`
output through `recordPatchEntry` (`:797`) / `recordStructuralWithDocEdit`
(`:855`), whose undo/redo patches reach the same strict endpoint without passing
through the funnel. The funnel alone would therefore cover every *direct* row
writer and no op — so the biconditional would read as global while holding on
only one of the two paths. Both get closed here.

Two holes on the op path, verified:

- `applyMerge` (`core/block-ops.ts:1054`) writes `withRuns(prev, …)` onto the
  previous visible line, refusing only `PAGE_BLOCK_TYPE` and **anchor** types —
  its own comment says the anchor refusal exists because merging into one *"would
  write `data.text` onto a void schema (400 at the write boundary)"*, but a
  **non-anchor** void (divider / image / embed / place) is not refused. Only a
  client-side intent gate stops it (`keystroke-intent.ts:527`, `:568`), whose own
  comment records that this exact 400 already shipped once.
- `applySplit` (`:915`, `:993`) writes `text` onto a tail whose type is
  `op.siblingType ?? block.type` — plain `string` on the op. Every declaration is
  `"text"` today, so it is latent; a container declaring
  `splitChildWhenExpanded: { childType: "divider" }` would 400 on every Enter.

**Do not fix these by conforming `fromOpResult`.** The server runs the *same*
`applyBlockOp` and then 400s rather than conforming, so a client that silently
conformed would predict a forest the server refuses to produce — trading a loud
400 for a permanently unconfirmable overlay op. The only place both sides can
agree is the reducer itself.

**The merge hole — a reducer refusal.** Give `applyMerge` a text-less-`prev`
refusal beside its `PAGE`/anchor ones, reading a `textBearingTypes` set added to
`BlockOpContext` next to `anchorTypes`. Both sides already derive `anchorTypes`
from their own registry off the same fact, so the twin is the same one-line
filter: `useAnchorTypes`' sibling in
`plugins/page/plugins/editor/web/internal/block-handles.ts` on the client, and
`handle-apply-block-op.ts:34`'s sibling (`h.acceptsText` instead of `h.anchor`)
on the server.

**Thread the CONTEXT, not a second set.** `BlockOpContext` already exists as the
reducer's parameter, but every seam between the two derivation sites and
`applyBlockOp` degraded it back to a bare `anchorTypes: ReadonlySet<string>` —
`applyOverlayOp` (`optimistic-block-ops.ts:402`), `fromOpResult` and
`buildOverlayOp` (`block-editor-context.tsx:136`, `:1117`), both stores
(`block-store.ts:79`, `:143`), the server handler (`:88`). Adding a second
parallel parameter to all six is how the next fact gets forgotten on one side.
Pass `BlockOpContext` itself through those seams instead, minted once per side
(`useBlockOpContext()` on the client, `blockOpContext()` on the server), so the
next reducer fact costs one field rather than one parameter per seam — and so
"client and server pass the same context" is a single object to compare rather
than a convention spread over six signatures.

**The split hole — a check, not a refusal.** `applySplit`'s tail type comes from
*declarations* (`splitInto`, `splitChildWhenExpanded.childType`, and the
`siblingType`/`childType` the keyboard resolver derives from them), so the set is
closed at build time and belongs one rung higher than a runtime refusal: extend
`plugins/page/plugins/editor/check/index.ts` with a case asserting every declared
split-target type is text-bearing. A container declaring
`splitChildWhenExpanded: { childType: "divider" }` then fails
`./equin check` instead of 400ing on every Enter. The merge refusal covers
the dynamic path; this covers the declared one.

### Files

The funnel half:

- `plugins/page/plugins/editor/web/block-editor-context.tsx` — `commitRows`
  (975–1030), `preserveText` (207–229), `acceptsTextRef` (630–634), `convertRow`
  (1536–1562) and its deps, `makeBlockAPI`'s deps (1823–1837).
- `plugins/page/plugins/editor/core/row-data.ts` — reuse `rowDataOf`; no change.

The reducer half:

- `plugins/page/plugins/editor/core/block-ops.ts` — `BlockOpContext` (248–259)
  gains `textBearingTypes`; `applyMerge` (1017–1057) gains the refusal.
- `plugins/page/plugins/editor/web/internal/block-handles.ts` — the
  `useAnchorTypes` sibling, and the one `useBlockOpContext()` mint.
- `plugins/page/plugins/editor/server/internal/handle-apply-block-op.ts` — the
  server twin (34–40, 88).
- The six seams that thread a bare set today and take the context instead:
  `optimistic-block-ops.ts:402`, `block-editor-context.tsx:136`/`:1117`,
  `block-store.ts:79`/`:143`, `handle-apply-block-op.ts:88`.
- `plugins/page/plugins/editor/check/index.ts` — the split-target check.

Documentation:

- `plugins/page/plugins/editor/CLAUDE.md` — the *"Text is doc-owned: a row write
  can never say `text`"* section says "exactly two functions … are allowed to
  name `text`". Restate it as the biconditional, say which writer each half is
  enforced on (funnel for direct row writes, reducer refusal + check for ops),
  and record the no-user-action-clears-it consequence that makes this more than
  console noise. The *"A page's structural writes are one ordered stream"*
  section should note that `BlockOpContext`, not a bare `anchorTypes`, is now
  what both sides must agree on.

Nothing on the server's write boundary changes — only the op handler's context.

## Regression guard

### Unit — `plugins/page/plugins/editor/web/__tests__/row-text-invariant.test.tsx`

Fork `structural-undo.test.tsx`'s `seed()` / `RowsProbe` / `snapshot` harness,
but **not** its `<PluginProvider plugins={[]}>` (`:177`): with no contributions
every handle lookup misses, the conform's `!handle` branch makes the fix inert,
and the test passes before and after. Registering fixtures *is* the test.

- Register two block types through the web `Editor.Block` slot using the
  `LoadedPlugin` cast pattern from
  `plugins/primitives/plugins/app-shell/web/__tests__/toolbar-contribution-driven.test.tsx:29`.
  (`parse-block-data.test.ts`'s recipe does not transfer — it registers on the
  *server* registry.)
- `BlockRegistration` (`web/slots.ts:85`) is a discriminated union: the text
  fixture (`textBlockSchema({})`) must supply **no** `component`; the void
  fixture (`z.object({})`) **must** supply one. Nothing mounts them, so
  `() => null` suffices.
- Mount `BlockEditorProviderInner` (`:579`) over a **spied** memory store — call
  `useMemoryBlockStore` in a wrapper and wrap `dispatch` to push each
  `BlockOverlayOp` into a sink. That buys the assertion rows alone cannot make:
  *no patch was sent*, as distinct from *an empty patch was applied*.

Assertions:

1. **The reported bug.** `convertTo(VOID)`, then
   `projectText(id, docRuns([{ text: "leftover" }]))` → the sink records **zero**
   dispatches for the projection **and** the row's `data` has no `text` key.
2. **The lost conversion.** From a void row, `convertTo(TEXT, emptyRowData())` →
   `data.text` is `[]`, key **present**.
3. **The property `preserveText` exists for.** A text→text conversion carries the
   existing runs across byte-for-byte — guards the fill degenerating into a
   blanket `[]`.
4. **The default that must not flip.** A row whose type has no registered
   contribution keeps its `text` across an `update()` — the `!handle` branch,
   which is the one that silently deletes content if someone "simplifies" it to
   `!handle?.text`.
5. `update({ attachmentId })` on a void row does not resurrect `text`.

### Unit — `plugins/page/plugins/editor/core/block-ops.test.ts` (the reducer half)

`bun:test`, colocated, alongside the existing refusal cases (`:1223`, `:1541`).
Two additions:

1. **Merge into a non-anchor void is refused, identically to an anchor.** Feed a
   forest whose previous visible line is a `divider`, pass a
   `textBearingTypes` context that excludes it, and assert `applyMerge` returns
   the input array *by identity* — the file's own idiom for a fully-refused op
   (`:926`). Pair it with the positive: the same merge into a text row still
   merges, so the refusal is not blanket.
2. **Context parity.** The client's `useBlockOpContext()` and the server's
   `blockOpContext()` derive from different registries, and a disagreement makes
   an op apply differently on each side and never confirm — the hazard
   `block-handles.ts:8` already names for `anchorTypes`. Assert both halves are
   derived by the same filter over the same `BlockHandle` fact, so the parity is
   checkable rather than conventional.

### E2E — `plugins/page/plugins/editor/e2e/convert-in-place-verify.ts`

This is the declared executable spec for conversion, and its case table
(`:99–190`) contains **no void swap target at all** — which is why this went
unnoticed. But a `/divider` case cannot join the table: the loop's first
assertion requires `[data-block-id=…] [contenteditable="true"]` and `continue`s
without it (`:206`), and `rowPlain` (`:61`) returns `""` for a missing `text` and
for `text: []` alike — it cannot express the distinction this bug is about.

Add a **separate phase after the loop** (the file already has one for DOM-node
identity), with a `hasTextKey(row)` helper over the authoritative
`GET /api/pages/:pageId/blocks`, asserting:

- `/divider`: row `type === "divider"`, `!hasTextKey(row)`, no `[contenteditable]`
  in the row;
- then *Turn into → Text*: `type === "text"`, `hasTextKey(row)`, survives a reload.

For the console signal, `h.session()` already returns `captured`
(`e2e-harness/e2e/browser.ts:40`) — a destructure, not a listener. Assert a
**delta over the phase, filtered to the signature**, not a global empty check
(unrelated WS/reconnect/asset noise would make that flaky):

```ts
const before = captured.consoleErrors.length;
// … drive the void swap, settle past the ~1 s projection …
const rejected = captured.consoleErrors
  .slice(before)
  .filter((l) => /blocks\/patch|Invalid data for block type|Unrecognized key/.test(l));
r.ok("void swap posts no rejected row write", rejected.length === 0, JSON.stringify(rejected));
```

`plugins/page/plugins/place/e2e/place-block.ts` (the reported repro) gets the
same two-line check as a cheap secondary — but its header (`:11`) declares it *"a
transcript tool, not a gate: it logs what it saw and fails only when the block
cannot be created at all"*. If a hard failure goes in, that sentence must be
amended in the same commit, or the file's stated contract and its behaviour
disagree.

## Verification

1. `./equin test plugins/page/plugins/editor` — the funnel test and the
   reducer refusal test both fail before their respective changes, pass after.
2. `./equin check page.editor:block-data-registered` plus the new
   split-target case — green, and red against a deliberately-broken
   `splitChildWhenExpanded: { childType: "divider" }`.
3. `./equin build` (background), then
   `bun plugins/page/plugins/editor/e2e/convert-in-place-verify.ts` — every case
   green, no rejected row write in the new phase.
4. `bun plugins/page/plugins/place/e2e/place-block.ts` — the original repro, no
   `CONSOLE-ERROR` at step [3].
5. By hand at `http://<worktree>.localhost:9000/pages`, driving both directions
   plus *Turn into → Page*, then
   `select type, count(*) filter (where data ? 'text') from page_blocks group by type`
   — every void type at 0, every text-bearing type at its full row count.
6. Backspace at the start of the line below a `/divider` — a caret move, not a
   merge, and no rejected write (the reducer refusal, reached through the real
   keystroke ladder rather than the unit fixture).
7. Watch the page's save indicator across a text→void conversion: it must return
   to saved, not park on an error with a Retry.
