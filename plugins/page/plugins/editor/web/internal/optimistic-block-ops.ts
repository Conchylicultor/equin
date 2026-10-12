// Optimistic overlay layer for the block editor's structural keystroke ops.
//
// The client runs the SAME pure `applyBlockOp` reducer the server runs, applied
// optimistically through `useOptimisticResource`. A small `OpEffect` fingerprint
// — captured at dispatch from the predicted next state — drives BOTH:
//   - the idempotency apply-guard (`applyOverlayOp` throws `OpNoLongerApplies`
//     when the base already reflects the op, so replay drops it — no double
//     apply / key collision), and
//   - content-based confirmation (`isReflected` on a fresh server snapshot).
//
// Pure module (no React): unit-tested directly in `optimistic-block-ops.test.ts`.

import { Rank } from "@plugins/primitives/plugins/rank/core";
import { OpNoLongerApplies } from "@plugins/primitives/plugins/optimistic-mutation/web";
import {
  applyBlockOp,
  childrenOf,
  dataEqual,
  namesField,
  opNamedIds,
  toNodes,
  writtenIds,
  type BlockFieldChanges,
  type BlockNode,
  type BlockOp,
  type BlockOpContext,
  type BlockPatch,
} from "../../core";
import type { Block } from "../../core";

/** Where one block landed, as the reducer predicted it. */
type PredictedMove = { id: string; parentId: string | null; rank: string };

/**
 * A compact fingerprint of what an op produces, captured at dispatch against the
 * current optimistic state. `isReflected` reuses it for both the apply-guard and
 * confirmation, so client prediction and server truth are compared with one
 * predicate. `reparent` keys on parent AND rank so a same-parent reorder isn't
 * falsely judged already-applied.
 */
export type OpEffect =
  // split, insert → the minted `newId` appears; paste/duplicate → their minted
  // ROOT ids do. A list rather than one id so a forest insert is expressible: the
  // whole planned forest lands in one server transaction, so the roots' presence
  // already implies their descendants'.
  | { kind: "create"; ids: string[] }
  // merge → the merged block disappears; delete → every named root does. A list
  // for the same reason `reparent` is one: deletion is a SET operation, and one
  // gesture is one op.
  | { kind: "remove"; ids: string[] }
  // indent/outdent/move/bulkMove → every listed block sits at its predicted parent+rank.
  // A list, not one id: indent/outdent are set operations (a single Tab is the
  // one-element case). Only blocks that ACTUALLY moved are listed, so an op the
  // reducer partially refused still confirms on exactly what it did.
  | { kind: "reparent"; moves: PredictedMove[] }
  /**
   * `unwrap` → the container `id` is gone AND each of its former children sits at
   * its predicted parent+rank. Both halves, conjoined: the op has TWO effects on
   * the rows and either one alone mis-describes it.
   *
   * Not a bare `remove`: an anchor that vanished with its children still absent
   * (another client hard-deleted the subtree) would read as absorbed, so the
   * replay would drop an op whose promotion never happened. Not a bare
   * `reparent` either: the promotion alone can be true while the empty container
   * row survives. The conjunction is exactly "the forest already looks like the
   * unwrap ran", which is what the apply-guard and confirmation both ask.
   *
   * `moves` may legitimately be EMPTY (a childless container unwraps to a plain
   * delete) — unlike `reparent`, that is not vacuous here, because the removal
   * conjunct still has to hold.
   */
  | { kind: "unwrap"; id: string; moves: PredictedMove[] };

/**
 * The overlay `Vars` carried by `useOptimisticResource`. Two variants share the
 * one `useOptimisticResource` instance so structural ops AND undo/redo patches
 * flow through the same overlay/replay + freeze pipeline:
 *
 *  - `op` — a single `BlockOp` applied through the shared `applyBlockOp` reducer
 *    (the forward keystroke/structural edits). Confirmed by its `OpEffect`.
 *  - `patch` — a minimal `BlockPatch` (create rows + field-scoped updates +
 *    delete ids) applied directly onto the client `Block[]` (the undo/redo
 *    inverse path). Confirmed when every created row is present (and, for a
 *    genuine create, matching — see `restoreIds`), every update's NAMED fields
 *    have landed, and every deleted id is absent.
 */
export type BlockOverlayOp =
  | {
      tag: "op";
      op: BlockOp;
      effect: OpEffect;
      /**
       * The rows this op writes — see {@link overlayOpTargets} for what the set
       * means and {@link predictOp} for how it is built. Stored rather than
       * derived because deriving it needs the reducer, and a `ReadonlySet`
       * rather than an array because `blockedByOlder` makes O(pending²)
       * `sameOverlayTarget` calls over sets that are now exact (a paste names
       * its whole forest). Nothing serialises `vars` — `describeOp` returns a
       * string and the divergence report carries no raw vars — so a `Set` is
       * safe to carry here.
       */
      targets: ReadonlySet<string>;
    }
  | {
      tag: "patch";
      patch: BlockPatch;
      /**
       * The `creates` of this patch that are RESTORES rather than creates: ids
       * this client has seen in server truth and that are not in it now
       * (`RowTruth` `"removed"`, `internal/row-truth.ts`). Derived at the one
       * dispatch chokepoint (`dispatchPatch` in `block-editor-context.tsx`)
       * from `everServerIds`, never chosen per call site.
       *
       * Every block delete is a trash, and a create whose id matches a trashed
       * row RESTORES the stored row (server §3.1 P4): the row comes back with
       * the fields it HAS — re-ranked after a slot occupant, reparented to the
       * root if its parent is gone, expanded if the user toggled it between
       * the delete and this undo — and the create's fields are ignored. So a
       * restore asserts only PRESENCE. Judging it field-by-field (what a
       * genuine create asserts) can never confirm when the stored row differs,
       * and no later push ever will: the restore ran in its own transaction
       * and the patch transaction wrote nothing. The op then sits in the
       * overlay rendering the recorded fields over the server's row — a toggle
       * recorded collapsed hiding a child the server has expanded — until an
       * unrelated write happens to move it.
       *
       * Presence-only is exact for both predicates: `isPatchReflected` (the
       * row is in the snapshot ⇒ the restore landed, whatever its fields) and
       * the apply-guard (an already-present row is the restored row ⇒ the
       * op has nothing left to do, so replay drops it and the server's row
       * shows through). A client-minted id (`"unseen"`) is never in this set
       * and keeps the full comparison — nothing here weakens a genuine
       * create's confirmation.
       *
       * `overlayOpTargets` still counts these ids: a restore WRITES its row
       * (the flags flip, the entry is consumed), so the ordering rule must
       * still see it.
       */
      restoreIds: ReadonlySet<string>;
    };

/**
 * Block ids an overlay op writes — the op-identity basis for the overlay's
 * ordering rule (`sameTarget` on `useOptimisticResource`), which makes an op
 * WAIT while an older, still-pending, same-target op survives the pass.
 *
 * A patch's set is derived here and is exact from the patch itself: it is
 * literally the rows the patch upserts and deletes, so storing it would only
 * give it room to drift. A structural op's set was built at dispatch and is the
 * UNION of what the reducer actually wrote (measured, {@link predictOp}) and
 * what the op names (`opNamedIds`) — see `predictOp` for why the union rather
 * than either half.
 *
 * **The residual bound, stated so it is not rediscovered as a defect.** An op's
 * set is frozen at DISPATCH, against the base the op was predicted on. At replay
 * the base can differ, so the set the op REALLY writes may be a strict superset:
 * adoption that appeared because a racing expand landed, `prevVisibleLine`
 * resolving to a different target, a cascade that grew. That gap is inherent —
 * `sameTarget(a, b)` sees only `vars`, never a base, and blocking has to be
 * decided before the replay that would measure it.
 *
 * Which is why this does **not** license an absorbing (subset) rule for
 * structural ops. The objection has changed shape, not gone away: it used to be
 * "an op's targets are an under-approximation BY CONSTRUCTION", and it is now
 * "they are exact only against the base they were predicted on". A symmetric
 * intersection is sound either way (an over-match only DEFERS a departure); a
 * subset test is not, so the `older.tag !== "patch"` guard in the deferred
 * `coversOverlayTarget` sketch stays.
 */
function overlayOpTargets(v: BlockOverlayOp): ReadonlySet<string> {
  if (v.tag === "patch") {
    return new Set([
      ...v.patch.creates.map((b) => b.id),
      ...v.patch.updates.map((u) => u.id),
      ...v.patch.deleteIds,
    ]);
  }
  return v.targets;
}

/**
 * Do two overlay ops write at least one common block row? The `sameTarget`
 * predicate for cascade confirmation: only a newer CONFIRMED op on the same
 * row(s) may supersede an older resolved one (the snapshot provably contains
 * the older write's effect on that row). The stuck-inverse-pair case this
 * keeps fixed — an undo patch and its redo inverse — always shares its full
 * id set, so the pair cascades; unrelated rows (e.g. a `projectText` patch on
 * another block) never do.
 */
export function sameOverlayTarget(
  a: BlockOverlayOp,
  b: BlockOverlayOp,
): boolean {
  const aIds = overlayOpTargets(a);
  const bIds = overlayOpTargets(b);
  // Iterate the smaller set against the larger: this runs O(pending²) times per
  // pass, and the sets are now exact (a paste's is its whole forest).
  const [small, large] = aIds.size <= bIds.size ? [aIds, bIds] : [bIds, aIds];
  for (const id of small) {
    if (large.has(id)) return true;
  }
  return false;
}

/** Has `blocks` already absorbed `e`? Single predicate for guard + confirmation. */
export function isReflected(blocks: Block[], e: OpEffect): boolean {
  switch (e.kind) {
    case "create": {
      // `ids` is never empty (an op with an empty reducer diff — an empty paste
      // or duplicate — is never dispatched), so this is not vacuously true.
      const present = new Set(blocks.map((b) => b.id));
      return e.ids.every((id) => present.has(id));
    }
    case "remove": {
      // `ids` is never empty (a delete naming nothing is dropped before
      // dispatch), so this is not vacuously true.
      const present = new Set(blocks.map((b) => b.id));
      return e.ids.every((id) => !present.has(id));
    }
    case "reparent":
      // `moves` is never empty (a no-op op is never dispatched — `dispatchOp`
      // drops it), so this is not vacuously true.
      return e.moves.every((m) => movedTo(blocks, m));
    case "unwrap":
      // Both halves: the container gone AND every promoted child where the
      // reducer put it (see the effect's doc for why neither alone will do).
      return (
        !blocks.some((b) => b.id === e.id) &&
        e.moves.every((m) => movedTo(blocks, m))
      );
  }
}

/** Does `blocks` place `m.id` at exactly the predicted parent + rank? */
function movedTo(blocks: Block[], m: PredictedMove): boolean {
  return blocks.some(
    (b) =>
      b.id === m.id && b.parentId === m.parentId && String(b.rank) === m.rank,
  );
}

/**
 * Does `row` already carry every field `changes` NAMES? The one comparator
 * behind both patch predicates, so "has this write landed" has a single
 * definition over the field-scoped shape — a patch can never be produced by one
 * notion of "changed" and judged by another. It reads exactly the named fields,
 * which is the hole the field scope closes: a whole-row comparison judged
 * columns the writer never claimed.
 *
 * `compareData` is the ONE axis the two callers differ on, deliberately — read
 * {@link isPatchAbsorbed} and {@link isPatchReflected} together.
 */
function fieldsReflected(
  row: Block,
  changes: BlockFieldChanges,
  compareData: boolean,
): boolean {
  if (namesField(changes, "parentId") && row.parentId !== changes.parentId)
    return false;
  if (namesField(changes, "type") && row.type !== changes.type) return false;
  if (namesField(changes, "rank") && String(row.rank) !== String(changes.rank))
    return false;
  if (namesField(changes, "expanded") && row.expanded !== changes.expanded)
    return false;
  // Deep-compared with the SAME predicate the diff used to emit the change, so
  // the writer and the guard can never disagree about whether a row differs.
  if (
    compareData &&
    namesField(changes, "data") &&
    !dataEqual(row.data, changes.data)
  ) {
    return false;
  }
  return true;
}

/** Every persisted field of a full row, as a change set (what a create asserts). */
function allFields(row: Block): BlockFieldChanges {
  return {
    parentId: row.parentId,
    type: row.type,
    rank: row.rank,
    expanded: row.expanded,
    data: row.data,
  };
}

/**
 * Shared body of the two patch predicates: every created row present (and,
 * for a genuine create, matching), every update's NAMED fields landed, every
 * deleted id gone.
 *
 * A create in `restoreIds` asserts PRESENCE only — see the field's doc on
 * `BlockOverlayOp`: the server restores the STORED row and ignores the
 * create's copy, so the row's fields are the server's to decide, under both
 * predicates. A create outside the set is a client-minted row the server
 * writes column-for-column, so every field is compared.
 *
 * An update naming an absent row is vacuously satisfied under both: an update
 * never creates, so `applyPatch` and the server writer skip it too — applying
 * would change nothing, and the op can (must) confirm against a base without
 * the row rather than replaying forever. That is the whole of what the retired
 * `updateOnly` flag was approximating.
 */
function patchLanded(
  blocks: Block[],
  patch: BlockPatch,
  restoreIds: ReadonlySet<string>,
  compareData: boolean,
): boolean {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  for (const c of patch.creates) {
    const cur = byId.get(c.id);
    if (!cur) return false;
    if (restoreIds.has(c.id)) continue;
    if (!fieldsReflected(cur, allFields(c), compareData)) return false;
  }
  for (const u of patch.updates) {
    const cur = byId.get(u.id);
    if (!cur) continue;
    if (!fieldsReflected(cur, u.changes, compareData)) return false;
  }
  for (const id of patch.deleteIds) {
    if (byId.has(id)) return false;
  }
  return true;
}

/**
 * Does SERVER TRUTH prove a patch landed? True when every field the patch names
 * has landed — `data` **excluded** — and every deleted id is gone. The
 * `isConfirmedBy` predicate for the patch variant.
 *
 * `data` is excluded on purpose, and this is the confirmation half of an
 * asymmetry with {@link isPatchAbsorbed} (read both docs together). Server truth
 * legitimately differs from what the client wrote: `parseBlockData` normalizes
 * the payload at the write boundary, and a row's `data.text` trails its content
 * doc by up to ~1s (the debounced projection), so a snapshot that provably
 * contains this write can still carry different `data`. Comparing it here would
 * make ops fail to confirm, stick in the overlay, and file divergence reports.
 *
 * Being liberal is safe for confirmation and NOT safe for the apply-guard, which
 * is exactly why they are two functions.
 *
 * `restoreIds` (the patch variant's own set — see `BlockOverlayOp`): a create
 * in it is a restore of a trashed row, and is reflected by the row's PRESENCE
 * alone. The server keeps the stored row's fields, so comparing them here is
 * the same mistake as comparing `data`, with the same symptom (an op that can
 * never confirm) and no later push to rescue it.
 */
export function isPatchReflected(
  blocks: Block[],
  patch: BlockPatch,
  restoreIds: ReadonlySet<string>,
): boolean {
  return patchLanded(blocks, patch, restoreIds, false);
}

/** Overlay a change set onto a row, touching only the fields it names. */
function mergeFields(row: Block, changes: BlockFieldChanges): Block {
  const next = { ...row };
  if (namesField(changes, "parentId")) next.parentId = changes.parentId!;
  if (namesField(changes, "type")) next.type = changes.type!;
  if (namesField(changes, "rank")) next.rank = changes.rank!;
  if (namesField(changes, "expanded")) next.expanded = changes.expanded!;
  if (namesField(changes, "data")) next.data = changes.data;
  return next;
}

/**
 * Would applying this patch to THIS base change anything? The apply-guard: when
 * true, `applyOverlayOp` throws `OpNoLongerApplies` so the replay drops the
 * entry instead of double-applying it.
 *
 * The same question as {@link isPatchReflected} asks, but about a different
 * subject — the base we are about to write, not a server snapshot we are reading
 * evidence off. So it must be EXACT, `data` included: a patch that changes only
 * `data` (a to-do's `checked`, a callout's color, an image's width — every
 * `BlockEditorAPI.update`) is a real edit, and a data-blind guard reads it as
 * already-absorbed and silently swallows it. That is not a theoretical gap: it
 * made `update` a complete no-op in `persist={false}` memory mode (whose
 * `dispatch` catches `OpNoLongerApplies` and keeps the current rows) and
 * non-optimistic on the server path.
 *
 * A create in `restoreIds` is absorbed by the row's PRESENCE alone, exactly as
 * under {@link isPatchReflected}: an already-present row IS the restored row
 * (the server's, or an earlier op's), and the create has nothing left to do
 * to it — see `applyPatch`, which keeps the present row for the same reason.
 */
export function isPatchAbsorbed(
  blocks: Block[],
  patch: BlockPatch,
  restoreIds: ReadonlySet<string>,
): boolean {
  return patchLanded(blocks, patch, restoreIds, true);
}

/**
 * Apply a `BlockPatch` onto a client `Block[]` base: MERGE each update's named
 * fields into its row (never a whole-row swap — an update says nothing about
 * the fields it omits), insert/replace each created row, then drop the deleted
 * ids (and any descendants of them, since the server delete cascades the
 * subtree). Ordering is by rank at render time, so we don't need to position
 * inserts — just include them. An update whose row is absent is skipped, which
 * mirrors the server writer exactly.
 *
 * A create in `restoreIds` (a restore of a trashed row) inserts its recorded
 * copy only while the row is ABSENT — the optimistic render until the server
 * answers. Once the row is present it is the restored row, with the fields the
 * server decided (re-ranked, reparented, toggled since the delete), and the
 * recorded copy must not paint over it: the create asserts presence, nothing
 * more. A genuine create landing on a present row still replaces it whole.
 */
export function applyPatch(
  blocks: Block[],
  patch: BlockPatch,
  restoreIds: ReadonlySet<string>,
): Block[] {
  const createById = new Map(patch.creates.map((b) => [b.id, b]));
  const changesById = new Map(patch.updates.map((u) => [u.id, u.changes]));
  const deleted = new Set(patch.deleteIds);
  // Drop the explicitly-deleted ids plus their descendants (mirrors the server's
  // FK cascade), so an undo that re-deletes a subtree-root clears the subtree.
  //
  // The cascade reads the POST-patch parentage, which is what the server does
  // and is not a detail: `writeBlockPatch` closes its delete set over the
  // forest AS THE PATCH LEAVES IT, so a row this patch re-parents OUT of the
  // deleted subtree is not in the cascade. Reading pre-patch parentage here
  // instead would silently swallow exactly that shape — redoing an `unwrap`
  // (promote the children, delete the container) dropped every promoted child.
  // `namesField`, not `?? b.parentId`: a promotion to the TOP level writes
  // `parentId: null`, which `??` would silently read as "no opinion".
  const parentOf = (b: Block) => {
    const created = createById.get(b.id);
    if (created && !restoreIds.has(b.id)) return created.parentId;
    const changes = changesById.get(b.id);
    return changes && namesField(changes, "parentId")
      ? (changes.parentId ?? null)
      : b.parentId;
  };
  const dropped = new Set(deleted);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of blocks) {
      const parentId = parentOf(b);
      if (parentId !== null && dropped.has(parentId) && !dropped.has(b.id)) {
        dropped.add(b.id);
        grew = true;
      }
    }
  }

  const next: Block[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    if (dropped.has(b.id)) continue;
    // A genuine create landing on a row that is already present is an
    // idempotent re-assert of the whole row: the create IS the full state, so
    // it wins outright. A RESTORE landing on a present row is the opposite —
    // the present row is the restored one and wins (see the header). An update
    // only merges its named fields.
    const created = createById.get(b.id);
    const changes = changesById.get(b.id);
    next.push(
      created && !restoreIds.has(b.id)
        ? created
        : changes
          ? mergeFields(b, changes)
          : b,
    );
    seen.add(b.id);
  }
  // Append creates that weren't already present (re-created / inserted rows).
  // Updates are deliberately NOT appended: an update never creates a row, so an
  // absent target is a skip — mirroring the server writer, and the reason a
  // debounced projection flush can never resurrect a deleted block.
  for (const c of patch.creates) {
    if (!seen.has(c.id) && !dropped.has(c.id)) next.push(c);
  }
  return next;
}

// `toNodes` now lives in `core/block-ops.ts`, beside the two types it maps
// between, so consumers outside this plugin can reach it. Re-exported here so
// this module's existing importers are unaffected.
export { toNodes };

/**
 * Reconstruct full `Block` rows from reducer output. Timestamps are preserved
 * from the matching `prev` row by id (a `new Date()` placeholder for brand-new
 * nodes is safe — the overlay value is only rendered, never re-parsed by the
 * resource schema, and the render path never reads timestamps). `rank` is wrapped
 * back into a `Rank` instance.
 */
export function fromNodes(nodes: BlockNode[], prev: Block[]): Block[] {
  const prevById = new Map(prev.map((b) => [b.id, b]));
  return nodes.map((n) => {
    const old = prevById.get(n.id);
    return {
      id: n.id,
      pageId: n.pageId,
      parentId: n.parentId,
      type: n.type,
      data: n.data,
      rank: Rank.from(n.rank),
      expanded: n.expanded,
      createdAt: old?.createdAt ?? new Date(),
      updatedAt: old?.updatedAt ?? new Date(),
    };
  });
}

/**
 * Apply one overlay op to a `Block[]` base. Idempotency guard: if the base
 * already reflects the op/patch, throw `OpNoLongerApplies` so the replay drops
 * this entry (preventing a double apply on the own-push-before-resolve window).
 * Otherwise apply: a structural `op` through the shared reducer (node adapter),
 * or a `patch` directly onto the rows.
 *
 * `ctx` is the reducer's `BlockOpContext` — it MUST be the same context the
 * server passes (both mint it from their own block-handle registry through the
 * shared `blockOpContextOf`), or the op applies differently on each side and can
 * never confirm. Defaulting to `{}` is byte-identical to a context-free call.
 */
export function applyOverlayOp(
  blocks: Block[],
  v: BlockOverlayOp,
  ctx: BlockOpContext = {},
): Block[] {
  if (v.tag === "patch") {
    // `isPatchAbsorbed`, NOT the confirmation predicate: the guard asks "would
    // applying this change anything here", which includes `data` (see both docs).
    if (isPatchAbsorbed(blocks, v.patch, v.restoreIds))
      throw new OpNoLongerApplies();
    return applyPatch(blocks, v.patch, v.restoreIds);
  }
  if (isReflected(blocks, v.effect)) throw new OpNoLongerApplies();
  return fromNodes(applyBlockOp(toNodes(blocks), v.op, ctx), blocks);
}

/**
 * Build the overlay vars for a minimal patch (the undo/redo inverse path).
 * `restoreIds` is the subset of `patch.creates` ids that restore a trashed row
 * (`RowTruth` `"removed"` at dispatch) — see the field's doc on
 * `BlockOverlayOp`. Required, not defaulted: a caller that cannot say which
 * creates are restores has no business dispatching a patch with creates, and
 * an empty default would silently give every restore a confirmation it can
 * never earn.
 */
export function buildPatchOverlayOp(
  patch: BlockPatch,
  { restoreIds }: { restoreIds: ReadonlySet<string> },
): BlockOverlayOp {
  return { tag: "patch", patch, restoreIds };
}

/**
 * Run `op` against `before` ONCE and derive everything a dispatch needs: the
 * predicted rows, the rows the reducer wrote, and the overlay vars.
 *
 * One function rather than the old `fromOpResult` + `buildOverlayOp` pair,
 * because `after` has no parameter here: it cannot disagree with `before`, and
 * it cannot be built with a different `ctx` than the effect was predicted under.
 * That also costs one `applyBlockOp` run per dispatch instead of two.
 *
 * **`targets` is the UNION of what the reducer wrote and what the op names, and
 * the union is load-bearing.** A pure before→after diff is SMALLER than the
 * named set in real cases: an end-of-line split rewrites the origin's `data.text`
 * byte-identically (so the origin is absent from the diff), a partially-refused
 * indent moves fewer rows than it names, and a `bulkMove` names its whole
 * selection while only the roots move. Dropping those would re-open the very
 * hole this measurement closes — a later patch on the split origin would stop
 * being blocked. The union is monotone: coverage never decreases against naming
 * alone, and it gains merge's unnamed target, split's adopted children, delete's
 * cascade, unwrap's promotion, and the ancestors a reveal opens.
 *
 * `written` is returned SEPARATELY from `vars.targets` precisely because the
 * union is never empty, while `written.length === 0` is exactly "the reducer
 * refused this op" — the test `dispatchOp` drops an op on.
 *
 * **`OpEffect` is built exactly as it was before this measurement existed.**
 * Confirmation and the apply-guard keep the semantics that shipped; only the
 * blocking relation widens. `ctx` must match what `applyOverlayOp` (and the
 * server) use — both mint it through the shared `blockOpContextOf`.
 */
export function predictOp(
  op: BlockOp,
  before: Block[],
  ctx: BlockOpContext = {},
): { after: Block[]; written: string[]; vars: BlockOverlayOp } {
  const beforeNodes = toNodes(before);
  const after = fromNodes(applyBlockOp(beforeNodes, op, ctx), before);
  const written = writtenIds(before, after);
  const targets = new Set([...written, ...opNamedIds(op)]);
  return {
    after,
    written,
    vars: {
      tag: "op",
      op,
      effect: opEffect(op, before, after, beforeNodes),
      targets,
    },
  };
}

/**
 * The op's confirmation/apply-guard fingerprint, per kind, read off the
 * before/after pair `predictOp` already holds.
 *
 * The forest kinds (`paste`, `duplicate`) need no prediction at all — their
 * effect is exactly the ROOT ids the caller just minted, which is `opNamedIds`'
 * own answer for both. They used to have a helper of their own, deliberately
 * unexported so that a paste or a duplicate could only reach the pipeline
 * through the provider's `dispatchOp` — the one place that records an undo
 * entry. Folding it in here keeps that property by the same means: there is no
 * exported forest-overlay builder, and neither kind is on `BlockStore`.
 */
function opEffect(
  op: BlockOp,
  before: Block[],
  after: Block[],
  beforeNodes: BlockNode[],
): OpEffect {
  switch (op.kind) {
    case "split":
    case "insert":
      // The new block is created.
      return { kind: "create", ids: [op.newId] };
    case "paste":
    case "duplicate":
      return { kind: "create", ids: opNamedIds(op) };
    case "splice": {
      // The rows it CREATED — the forest roots that landed as rows (a leading
      // paragraph absorbed into the origin is not one) and the tail, when one
      // was minted. Measured, not named: which of them exist is the reducer's
      // answer. Never empty: a splice creating nothing is a text edit, which
      // the executor records as a doc edit and never dispatches.
      const beforeIds = new Set(before.map((b) => b.id));
      const landed = new Set(
        after.filter((b) => !beforeIds.has(b.id)).map((b) => b.id),
      );
      return {
        kind: "create",
        ids: [...op.forest.map((n) => n.id), op.tailId].filter((id) =>
          landed.has(id),
        ),
      };
    }
    case "merge":
      return { kind: "remove", ids: [op.blockId] };
    case "deleteSpan": {
      // Every row the span removed — its end line and the lines between —
      // measured off the reducer's own output, since the op names only C.
      const afterIds = new Set(after.map((b) => b.id));
      return {
        kind: "remove",
        ids: before.filter((b) => !afterIds.has(b.id)).map((b) => b.id),
      };
    }
    case "delete":
      return { kind: "remove", ids: op.blockIds };
    case "unwrap": {
      // The container goes away AND its children are promoted, so the effect
      // carries both. The moved set is the container's CHILDREN, which the op
      // does not name, so read them off the pre-op forest.
      const promoted = childrenOf(beforeNodes, op.blockId).map((c) => c.id);
      return {
        kind: "unwrap",
        id: op.blockId,
        moves: predictMoves(before, after, promoted),
      };
    }
    case "indent":
    case "outdent":
    case "move":
    case "bulkMove":
      // Key the reparent effect on where the named blocks landed (byte-identical
      // to the server, which runs the same reducer). Blocks the reducer refused
      // to move (a bulk indent's first child, say) are left OUT of the effect:
      // their parent+rank is unchanged, so listing them would make the
      // apply-guard read the op as already-absorbed. A `bulkMove` names its whole
      // selection, so the same filter reduces it to the roots that really moved.
      return {
        kind: "reparent",
        moves: predictMoves(before, after, opNamedIds(op)),
      };
  }
}

/**
 * Where `ids` landed, read off the before/after rows. Blocks that did not
 * actually move are omitted: their parent+rank is unchanged, so listing them
 * would make the apply-guard read the op as already-absorbed.
 *
 * **Both sides of the rank go through `String()`, and that is not defensive.**
 * `PredictedMove.rank` is a string — `movedTo` compares `String(b.rank) ===
 * m.rank` — while these rows are `Block`s, whose `rank` is a `Rank` INSTANCE.
 * Emitting the instance would make every reparent effect unconfirmable: nothing
 * would ever match, the op would stick in the overlay, and a `stalled`
 * divergence report would follow. Comparing `prev.rank !== next.rank` by
 * identity has the mirror failure — `fromNodes` mints a fresh `Rank` per row, so
 * every named block would read as moved.
 */
function predictMoves(
  before: Block[],
  after: Block[],
  ids: readonly string[],
): PredictedMove[] {
  const beforeById = new Map(before.map((b) => [b.id, b]));
  const afterById = new Map(after.map((b) => [b.id, b]));
  return ids.flatMap((id) => {
    const next = afterById.get(id);
    const prev = beforeById.get(id);
    if (!next) return []; // vanished after apply (defensive; shouldn't happen)
    if (
      prev &&
      prev.parentId === next.parentId &&
      String(prev.rank) === String(next.rank)
    ) {
      return [];
    }
    return [{ id, parentId: next.parentId, rank: String(next.rank) }];
  });
}

/**
 * Narrow a predicted `delete` to `blockIds` — the ONE constructor for a
 * `{tag:"op"}` value that is not a fresh prediction, so the composite's
 * per-owner-page fan-out never spells the literal (and can never omit
 * `targets`). The effect is byte-identical to what {@link predictOp} builds for
 * this kind, so a fanned-out op is indistinguishable from one dispatched for
 * that page alone.
 *
 * `targets` is carried through WHOLE rather than narrowed. It is the union-space
 * set of the entire gesture, so a per-page op holds ids belonging to another
 * page — and the worst that can do is match another op in THIS page's pending
 * list that also names a foreign id. A spurious match only DEFERS a departure
 * (the ordering rule makes an op wait; it never drops one), so widening here
 * costs at most one extra pass, never an edit.
 */
export function narrowDeleteOverlayOp(
  v: Extract<BlockOverlayOp, { tag: "op" }>,
  blockIds: string[],
): BlockOverlayOp {
  return {
    tag: "op",
    op: { kind: "delete", blockIds },
    effect: { kind: "remove", ids: blockIds },
    targets: v.targets,
  };
}
