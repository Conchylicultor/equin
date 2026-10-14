// Pure keyed-delta diff core. Extracted from `createResourceRuntime` so the
// server-side producer of the `(upserts, deletes, order)` deltas — the
// counterpart to the client `mergeKeyedDelta` consumer in
// `@plugins/primitives/plugins/live-state/web/keyed-delta-merge.ts` — is named,
// isolated, and fuzzable without standing up a socket or a registry.
//
// A keyed-mode array resource keeps a per-`(key,params)` snapshot of
// id→`SnapEntry` (a content identity over the row's canonical JSON — see
// `SnapEncoder` — computed identically on every path). On a notify the runtime
// re-runs the loader, diffs the new array against that snapshot by row id, and
// broadcasts only the changed rows + the id order — so a single-row change
// ships one row instead of the whole list. This module owns that diff. The
// runtime owns the snapshot *storage* (the `Map<pk, snapshot>`) AND the
// per-resource encoder choice: these functions take the prior snapshot + the
// encoder in and hand the next snapshot back, staying pure (no I/O, no
// mutation of their inputs). A resource's `prev` snapshots must have been
// built with the SAME encoder passed to the diff (entries are compared for
// equality) — the runtime guarantees this by deriving the encoder statically
// from the resource definition.

import { hash64 } from "@plugins/packages/plugins/string-hash/core";

/**
 * One retained snapshot entry for a row: either the row's full canonical JSON
 * (`string`) or a 64-bit content hash of it (`bigint`). Which one an entry
 * stores is a PER-RESOURCE choice made once by the runtime (`SnapEncoder`
 * below) — the two never mix within one resource's snapshots.
 */
export type SnapEntry = string | bigint;

/** A keyed snapshot: row id → snapshot entry (see `SnapEntry`), in array order. */
export type KeyedSnapshot = ReadonlyMap<string, SnapEntry>;

/**
 * Encodes a row's canonical JSON into the value retained in the snapshot. The
 * diff functions below only ever compare entries for EQUALITY, so any injective
 * -enough encoding works for diffing; the choice is about memory and about the
 * one consumer that needs the bytes back:
 *
 * - a 64-bit hash (the default for keyed resources): retain a 64-bit content
 *   hash instead of the full JSON string. Which hash is the runtime's
 *   `ResourceRuntimeOptions.snapHash` — the Bun hosts inject
 *   `Bun.hash.wyhash(json) ^ BigInt(json.length)` (native, fast); every other
 *   host gets `hashSnapEncoder`, the portable `hash64` (plain JS, so a browser
 *   page can host the runtime). A snapshot Map shrinks from
 *   value-sized (UTF-16 ⇒ ~2 B/char of row JSON, rebuilt and dropped on every
 *   recompute — the delivery-path GC sawtooth) to ~16 B/row. The trade,
 *   explicit: a 64-bit collision makes a genuinely-changed row read as
 *   unchanged — a missed update no self-heal path catches (the diff sees no
 *   change, so no frame and no flushAgain). Birthday-bounded: for a pk with
 *   n rows the probability of ANY collision is ~n²/2⁶⁵ (n=10⁵ ⇒ ~3·10⁻¹⁰);
 *   the Bun hosts' length fold additionally kills every different-length
 *   collision.
 * - `retainSnapEncoder`: keep the canonical JSON string — REQUIRED for
 *   `scopedMembership` resources, whose persisted-incremental path
 *   reconstructs the FULL value from the stored snapshot via `JSON.parse`
 *   (`runtime.ts` drainMembershipScoped). Behavior identical to the
 *   pre-`SnapEntry` code.
 */
export type SnapEncoder = (canonicalJson: string) => SnapEntry;

/** The portable 64-bit hash encoder: the runtime's default `snapHash`. */
export const hashSnapEncoder: SnapEncoder = (json) => hash64(json);

export const retainSnapEncoder: SnapEncoder = (json) => json;

export interface KeyedDiff {
  upserts: [string, unknown][];
  deletes: string[];
  /**
   * The full ordered id list, OR `undefined` when order/membership are
   * unchanged (the common in-place-update case: a status/title flip on one
   * row). The snapshot Map is built from `value` in order, so iterating the
   * prior snapshot's keys yields the prior order; when it matches the new order
   * element-for-element we omit it from the wire. An omitted `order` strictly
   * means "in-place upserts, membership/order unchanged" — `deletes` is then
   * necessarily empty and there are no brand-new ids.
   */
  order: string[] | undefined;
  /**
   * False only when there was no prior snapshot (first notify for this pk).
   * Callers ship a full update in that case so brand-new clients get a complete
   * base.
   */
  hadSnapshot: boolean;
}

/** Build the id→entry map for a keyed resource's array `value`, in array order. */
export function buildSnapshot(
  value: readonly unknown[],
  keyOf: (row: unknown) => string,
  encode: SnapEncoder,
): Map<string, SnapEntry> {
  const map = new Map<string, SnapEntry>();
  for (const row of value) map.set(keyOf(row), encode(JSON.stringify(row)));
  return map;
}

/**
 * Full diff: compare the new array `value` against `prev` (the prior snapshot,
 * or `undefined` on first notify). Returns the wire `KeyedDiff` plus the freshly
 * computed `nextSnapshot` the caller stores in place of `prev`. Pure — does not
 * mutate `prev`.
 *
 * - `upserts` = every row whose content-hash differs from `prev` (a change) or
 *   is absent from `prev` (a new row).
 * - `deletes` = every id in `prev` not present in the new array.
 * - `order` = the full new id list, OR `undefined` when it is element-for-element
 *   identical to the prior order (in-place update, membership/order unchanged).
 */
export function diffKeyedFull(
  prev: KeyedSnapshot | undefined,
  value: readonly unknown[],
  keyOf: (row: unknown) => string,
  encode: SnapEncoder,
): { diff: KeyedDiff; nextSnapshot: Map<string, SnapEntry> } {
  const hadSnapshot = prev !== undefined;
  // Map preserves insertion order, and the snapshot was built from the prior
  // `value` in order, so its key iteration order is the prior id order.
  const prevOrder = prev ? [...prev.keys()] : undefined;
  const next = new Map<string, SnapEntry>();
  const upserts: [string, unknown][] = [];
  const order: string[] = [];
  for (const row of value) {
    const id = keyOf(row);
    const hash = encode(JSON.stringify(row));
    next.set(id, hash);
    order.push(id);
    if (!prev || prev.get(id) !== hash) upserts.push([id, row]);
  }
  const deletes: string[] = [];
  if (prev) {
    for (const id of prev.keys()) if (!next.has(id)) deletes.push(id);
  }
  // Omit `order` when the id sequence is identical to the prior one — a delete
  // or insert changes membership ⇒ length/sequence differs ⇒ order is sent.
  const orderUnchanged =
    prevOrder !== undefined &&
    prevOrder.length === order.length &&
    prevOrder.every((id, i) => id === order[i]);
  return {
    diff: {
      upserts,
      deletes,
      order: orderUnchanged ? undefined : order,
      hadSnapshot,
    },
    nextSnapshot: next,
  };
}

/**
 * Scoped diff (Layer 2): `scopedRows` is a PARTIAL array — only the recomputed
 * affected rows. The changed rows are MERGED into a copy of `prev` (never a
 * replace): each row whose hash differs becomes an upsert and its hash is
 * written into `nextSnapshot`; rows not in `scopedRows` are carried over intact.
 * `deletes` is necessarily empty and `order` is undefined — a scoped diff
 * never asserts membership/order (the runtime's membership drains use
 * `diffKeyedScopedMembership`; this one is kept for the live-state client
 * round-trip suite, via `core/testing`). Pure — does not mutate `prev`.
 *
 * Precondition: a `prev` snapshot exists (the caller only enters the scoped path
 * when a snapshot was already seeded). Returns the partial-update upserts plus
 * the merged `nextSnapshot`.
 */
export function diffKeyedScoped(
  prev: KeyedSnapshot,
  scopedRows: readonly unknown[],
  keyOf: (row: unknown) => string,
  encode: SnapEncoder,
): { upserts: [string, unknown][]; nextSnapshot: Map<string, SnapEntry> } {
  const next = new Map<string, SnapEntry>(prev);
  const upserts: [string, unknown][] = [];
  for (const row of scopedRows) {
    const id = keyOf(row);
    const hash = encode(JSON.stringify(row));
    if (next.get(id) !== hash) {
      upserts.push([id, row]);
      next.set(id, hash);
    }
  }
  return { upserts, nextSnapshot: next };
}

/**
 * The membership-scope inputs to `diffKeyedScopedMembership`: the id sets that
 * frame a single flush's row-level change for a `scopedMembership` keyed
 * resource. See `research/2026-07-03-global-scoped-membership-m5.md`.
 *
 * - `requestedIds` — the ids the loader was asked to refill (op-I ∪ op-U ids). An
 *   id present here but ABSENT from `refillRows` is a membership EXIT (its
 *   mutable-`where` flipped to false, or it was concurrently deleted).
 * - `deletedIds` — op-D ids. Never queried (a deleted row can't be refilled); an
 *   id here that is in `prev` is an EXIT, listed in `deletes`.
 * - `orderedIds` — the full ORDER BY'd id list from the resource's order
 *   authority (`orderOf` / `windowIdsOf`), supplied when the refill ENTERED at
 *   least one id not already in `prev` (an entry needs an authoritative
 *   placement) — or whenever the caller re-derived the order for another reason
 *   (a bounded window's leaver/tail-pull, or a member row whose order signature
 *   moved). Supplied WITHOUT any entry/exit, the diff ships `order` only if it
 *   actually differs from the prior snapshot order. Absent for an exit-only or
 *   in-place change: the order is then derived from the prior snapshot minus the
 *   exits, so no ids query runs.
 */
export interface KeyedMembershipInput {
  requestedIds: ReadonlySet<string>;
  deletedIds: ReadonlySet<string>;
  orderedIds?: readonly string[];
}

/**
 * Membership-aware scoped diff (M5): the counterpart to `diffKeyedScoped` for a
 * keyed resource that opted into row-level INSERT/DELETE/where-flip scoping.
 * `refillRows` is a PARTIAL array — only the `requestedIds` the loader
 * re-selected — so this both merges those rows in AND resolves membership
 * exits/entries against `prev`, returning a delta that MAY assert `order`
 * (unlike `diffKeyedScoped`, which never does). Pure — never mutates `prev`.
 *
 * Wire contract (see `keyed-delta-merge.ts`): the client rebuilds the keyed array
 * PURELY from `order`, so any membership change MUST ship the full `order`; and an
 * `order` id resolvable from neither the `upserts` nor the client's base forces a
 * drift-resub. Both are honored here — `nextSnapshot` is rebuilt FROM `order` so
 * snapshot ≡ wire order, and `upserts`/`order` are sanitized to the surviving ids.
 *
 * Algorithm:
 *   1. Merge `refillRows` into a copy of `prev`; a changed/new row is an upsert.
 *   2. Exits = ids in (`requestedIds` ∪ `deletedIds`) that are in `prev` but were
 *      NOT returned by the refill → removed from the snapshot, listed in `deletes`.
 *   3. Entries = refill ids absent from `prev`. No entries AND no exits ⇒ Case A:
 *      `{ upserts, deletes: [], order: undefined }` — the exact `diffKeyedScoped`
 *      shape (in-place upserts, membership/order unchanged).
 *   4. Otherwise membership changed. The order SOURCE is `orderedIds` when
 *      supplied (an entry happened), else the prior snapshot order (exit-only).
 *      `finalOrder = orderSource.filter(id => merged.has(id))` drops ids the order
 *      source no longer agrees on (an `orderedIds` id absent from the merge, or a
 *      merged id concurrently deleted out of `orderedIds`); `nextSnapshot` is
 *      rebuilt from `finalOrder`; `upserts` are filtered to the survivors.
 */
export function diffKeyedScopedMembership(
  prev: KeyedSnapshot,
  refillRows: readonly unknown[],
  input: KeyedMembershipInput,
  keyOf: (row: unknown) => string,
  encode: SnapEncoder,
): {
  upserts: [string, unknown][];
  deletes: string[];
  order: string[] | undefined;
  nextSnapshot: Map<string, SnapEntry>;
} {
  const { requestedIds, deletedIds, orderedIds } = input;

  // (1) Merge the partial refill into a copy of prev. A row whose hash differs
  // (changed) or is absent (new) is an upsert; carried-over rows stay intact.
  const merged = new Map<string, SnapEntry>(prev);
  const upserts: [string, unknown][] = [];
  const refillIds = new Set<string>();
  for (const row of refillRows) {
    const id = keyOf(row);
    refillIds.add(id);
    const hash = encode(JSON.stringify(row));
    if (merged.get(id) !== hash) {
      upserts.push([id, row]);
      merged.set(id, hash);
    }
  }

  // (2) Exits: a requested/deleted id that WAS a member but the refill did not
  // return (where-flip to false, or a concurrent delete). Deduped across the two
  // sets — an id can appear in both (insert-then-delete coalesced in one flush).
  const deletes: string[] = [];
  const exitCandidates = new Set<string>();
  for (const id of requestedIds) exitCandidates.add(id);
  for (const id of deletedIds) exitCandidates.add(id);
  for (const id of exitCandidates) {
    if (prev.has(id) && !refillIds.has(id)) {
      merged.delete(id);
      deletes.push(id);
    }
  }

  // (3) Entries: a refilled id that was not previously a member.
  let entered = false;
  for (const id of refillIds) {
    if (!prev.has(id)) {
      entered = true;
      break;
    }
  }

  // Case A: no membership change AND no order authority supplied — identical
  // shape to `diffKeyedScoped`. `merged` preserves prev's key order (no
  // add/remove), so `order` is correctly omitted. When the caller DID supply
  // `orderedIds` without any entry/exit (a window re-derived because a member
  // row's order signature moved), fall through: the order may have changed.
  if (!entered && deletes.length === 0 && orderedIds === undefined) {
    return { upserts, deletes: [], order: undefined, nextSnapshot: merged };
  }

  // (4) Membership (or order) changed. Order source = the caller's authoritative
  // list when supplied, else prev order minus exits (exit-only).
  // An entry WITHOUT `orderedIds` is a caller-contract violation: falling back to
  // the prior order would silently drop the entering row from both the wire and
  // the snapshot — an invisible data loss. Fail loudly instead.
  if (entered && orderedIds === undefined) {
    throw new Error(
      "diffKeyedScopedMembership: a refilled id entered membership but no orderedIds " +
        "was supplied — the caller must run orderOf whenever the refill returns an " +
        "id absent from the prior snapshot",
    );
  }
  const orderSource = orderedIds ?? [...prev.keys()];
  const finalOrder = orderSource.filter((id) => merged.has(id));
  // Rebuild the snapshot FROM finalOrder so snapshot ≡ wire order. Any merged id
  // not in finalOrder (a non-surviving entrant sorted past the window tail, an
  // `orderedIds` disagreement, a concurrent delete) drops out — its own feed
  // event later becomes a no-op.
  const survivors = new Set(finalOrder);
  const nextSnapshot = new Map<string, SnapEntry>();
  for (const id of finalOrder) nextSnapshot.set(id, merged.get(id)!);
  const survivingUpserts = upserts.filter(([id]) => survivors.has(id));
  // Omit `order` when the final id sequence is element-for-element identical to
  // the prior snapshot order — mirroring `diffKeyedFull`'s omission. Reachable
  // when the caller supplied `orderedIds` but the membership/order did not
  // actually change: a non-surviving entrant, or an order re-derive (signature
  // move) whose window came back in the same sequence. The rebuilt snapshot is
  // still returned (it may have shed a non-survivor the wire never carried).
  const prevOrder = [...prev.keys()];
  const orderUnchanged =
    finalOrder.length === prevOrder.length &&
    finalOrder.every((id, i) => id === prevOrder[i]);
  return {
    upserts: survivingUpserts,
    deletes,
    order: orderUnchanged ? undefined : finalOrder,
    nextSnapshot,
  };
}
