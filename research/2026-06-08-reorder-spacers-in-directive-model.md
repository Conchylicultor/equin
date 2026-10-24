# Reorder spacers in the directive model

## Context

The `reorder` plugin makes every `defineRenderSlot()` reorderable via DnD
middleware. Before the config_v2 migration (commit `bb3a61533`, doc
`research/2026-06-04-global-reorder-config-integration.md`), users could insert
**spacers** — blank, draggable gaps between items in a reorderable slot — and an
"Add spacer" affordance lived in the edit-mode popover. The migration moved slot
layout from Postgres ranks into config_v2 directives (`{ order: string[]; hidden:
string[] }` of `entryKey` strings, applied over the live catalog) and **dropped
spacer support** as deferred follow-up. The inert `SpacerItem`/`isSpacer`/
`SPACER_PREFIX` type machinery was kept threaded through the code, but nothing
ever produces a spacer.

This plan reintroduces spacers **within the directive model**: a spacer is a
synthetic token in the `order` array (prefixed `__spacer__`). This needs **no
schema change** (`order` is already `stringListField` → `z.array(z.string())`),
keeps spacers committable to git and agent-editable like the rest of the
directive, and reuses the existing inert machinery. The intended outcome: the
edit-mode "Add spacer" affordance returns, spacers render as flex gaps, drag to
reposition, and delete — all persisted to the slot's config directive.

## Design

**Model.** A spacer is a string in `directive.order` of the form
`__spacer__<unique-id>` (reuse `SPACER_PREFIX = "__spacer__"`). `order` becomes a
mixed sequence of `entryKey`s and spacer tokens. Spacers never touch `hidden` and
never join groups. App-created tokens use `crypto.randomUUID()` for the suffix;
duplicates (e.g. hand-authored) are de-duplicated on read.

**Read path — rewrite `applyDirective` from comparator-sort to a positional walk
of `order`** (the clean primitive the research doc anticipated). This preserves
current non-spacer behavior exactly while letting spacers materialize at their
`order` positions:

1. Partition contributions into `hidden` / visible-non-excluded / excluded (as
   today, `sorting.ts:94-102`). Excluded items are **never** in the working set.
2. Build `byKey: Map<entryKey, Contribution>` over visible-non-excluded.
3. Walk `directive.order`, tracking a `Set` of emitted spacer tokens:
   - token starts with `SPACER_PREFIX` and not yet emitted → emit
     `{ id: token, _spacer: true }` (dedup: skip if already emitted);
   - else `byKey` has it → emit that contribution, mark consumed;
   - else → skip (drift: removed/unknown contribution).
4. Append unconsumed visible-non-excluded in natural runtime order (iterate the
   `visible` list, which is built in `contributions` order → preserves
   `naturalIdx` semantics).
5. Append excluded items last, in natural order (the pinned-last guarantee the
   comparator gave via `:107-110`).

The resulting `entries` may now contain spacers. The downstream groups block
(`sorting.ts:136-208`) is unchanged: a spacer has no `membershipMap` entry, so it
routes to `ungrouped` and stays top-level, sorted by its walk position.

**Write path (config-backed, via `useSetConfig`).**

- `addSpacer()` — **materialize** the current full visible order
  (`state.entries.map(entryKey)`), append a fresh `${SPACER_PREFIX}${crypto.randomUUID()}`
  token, `setConfig("order", [...materialized, token])`. Materialization is
  required: a bare append to a possibly-empty/partial `order` would place the
  spacer after only the explicitly-ordered items, not at the visual end (matches
  the old end-of-list add behavior).
- `deleteSpacer(token)` — **filter** the persisted list:
  `setConfig("order", directiveRef.current.order.filter(t => t !== token))`. Do
  **not** materialize here — re-materializing would promote every
  natural-order item into `order`, bloating the directive and freezing
  drift-tolerance.
- Drag/reorder — the existing `onDrop` already operates on `state.entries` and
  persists `next.map(entryKey)`; `entryKey(spacer) === spacer.id` (the token) and
  the `isSpacer` guards already exist, so spacer tokens round-trip unchanged. Add
  one explicit `isSpacer` short-circuit in the membership-pull branch
  (`dnd-list-middleware.tsx:239-245`) for robustness (currently dead-safe because
  a spacer is never in `membershipMap`).

**Edit-mode affordances.** Thread `addSpacer` + `onDeleteSpacer` through
`ReorderAreaCtxValue`; re-add the delete button to `SpacerReorderItem` (wire to
`ctx.onDeleteSpacer(itemKey)`); re-add the "Add Spacer" row to `RestoreButton`
(pass `addSpacer` as a prop, mirroring the existing `addGroup` prop at
`dnd-list-middleware.tsx:540`).

**Agent-facing docs.** Document the spacer-token convention in the generated
`.origin.jsonc` catalog comments so agents can hand-insert gaps.

## Files to modify

1. **`plugins/reorder/web/internal/sorting.ts`** — Rewrite `applyDirective`
   (`:82-217`) as the positional walk above (with spacer-token dedup `Set`).
   Remove the "spacers are deferred" comment (`:6-8`); update the `applyDirective`
   doc comment (`:67-81`). Keep `SpacerItem`/`isSpacer`/`SPACER_PREFIX`/the
   `TopLevelEntry` union (now live, not inert).

2. **`plugins/reorder/web/internal/dnd-list-middleware.tsx`** — Add `addSpacer`
   (materialize + append UUID token) and `deleteSpacer` (filter persisted
   `order`) callbacks (alongside `hideItem`/`restoreItem`, `:182-195`). Add both
   to `ctxValue` (`:466-474`). Pass `addSpacer` to `<RestoreButton>` (`:537-543`).
   Add an `isSpacer` guard to `onDrop`'s membership-pull `fetch` (`:239`).

3. **`plugins/reorder/web/internal/dnd-components.tsx`** — Add `addSpacer` and
   `onDeleteSpacer` to `ReorderAreaCtxValue` (`:14-24`). Re-add the delete button
   to `SpacerReorderItem` (`:151-178`), wired to `ctx.onDeleteSpacer(itemKey)` via
   `useContext(ReorderAreaContext)` (replaces the old fetch-based delete). Add an
   "Add Spacer" `Row` to `RestoreButton` next to "Add Group" (`:238-250`); thread
   `addSpacer` as a new prop.

4. **`plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts`**
   — In `buildOriginAnnotationsProvider` (`:146-161`), append a comment line to
   the per-slot catalog (after the `:154` header) documenting:
   `Insert a blank gap by adding a "__spacer__<unique-id>" string into order.`
   Comments don't affect the config hash, so this is free — but it requires
   `./equin build` to regenerate the committed `.origin.jsonc` files and
   keep `config-origins-in-sync` green.

5. **`plugins/reorder/CLAUDE.md`** — Replace the "Spacers are temporarily
   unsupported" caveat (`:63`) with the spacer-token model (synthetic
   `__spacer__<id>` tokens in `order`; UUID-on-create, dedup-on-read; never in
   `hidden` or groups).

## Edge cases

- **Duplicate `__spacer__` tokens** (hand-authored) → deduped on read in
  `applyDirective` (skip already-emitted tokens). Prevents React-key / dnd-id
  collisions. App-created tokens use UUIDs, so never collide.
- **`addSpacer` against empty/partial `order`** → must materialize full visible
  order (else spacer lands mid-list).
- **`deleteSpacer`** → filter persisted `order` only; never materialize.
- **`__spacer__` token in `hidden`** (hand-authored) → inert; matches no real
  `contributionKey`, no guard needed.
- **Rapid same-key (`order`) writes** (drag + add-spacer in one tick) →
  config_v2's `setConfig` is a full-document read-modify-write of the on-disk
  override (last-writer-wins per field); gesture-paced in practice, so safe — do
  not batch them in a single tick.

## Non-issues (confirmed, no change)

- **Server:** zero implications — spacer tokens are plain strings the
  `stringListField` schema already accepts and `setConfigField` stores verbatim.
- **`dnd-item-middleware.tsx`:** operates only on real contributions; spacers are
  rendered directly by the list middleware via `SpacerReorderItem`.
- **`reorderable-slots` manifest / `reorderable-slots-in-sync` check:** unaffected
  (manifest is `{slotId, pluginId}[]`).
- **Groups:** `onGroupCreate`/`onGroupJoin` already early-return on `isSpacer`, so
  a spacer can never enter a group.

## Verification

1. `./equin build` succeeds; regenerated `.origin.jsonc` files now carry
   the spacer-convention comment. `./equin check` passes
   (`config-origins-in-sync`, `eslint`, boundaries).
2. **In-app add/drag/delete:** load `http://<worktree>.localhost:9000`, toggle
   the edit-mode pen, open the "Add" popover on a toolbar slot, click "Add
   Spacer". Confirm a dashed gap appears at the end; drag it between two items;
   reload and confirm it persists. Inspect `config/<plugin>/<slot>.jsonc` →
   `order` contains the `__spacer__<uuid>` token at the dragged position. Delete
   the spacer via its × button; confirm the token is removed from `order`.
   Script this with `bun e2e/screenshot.mjs` (before/after) to verify the
   `disabled`/state and capture the gap.
3. **Agent-edit path:** hand-add a `__spacer__manual` token into a committed
   `config/<plugin>/<slot>.jsonc` `order` array, `./equin build`, reload →
   gap renders at that position.
4. **Dedup:** put two identical `__spacer__dup` tokens in `order`, reload →
   exactly one gap renders, no React key warning in the browser logs
   (`read_logs`), drag still works.
5. **Drift tolerance:** with a saved directive containing a spacer, add/remove a
   real contribution in the slot, rebuild → the spacer keeps its relative
   position, the new contribution appends, nothing is invalidated.
6. **Non-spacer regression:** confirm a slot with an `order`/`hidden` directive
   but no spacers renders identically to before the walk rewrite (order'd-first,
   unmentioned-natural-append, `excludeFromReorder` pinned last — e.g. the pen
   button stays at the toolbar end).
