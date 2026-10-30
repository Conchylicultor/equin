import type { BlockNode } from "../../core";
import type { BlockRow } from "./forest";

// ---------------------------------------------------------------------------
// Row <-> Node adapters. The reducer (`applyBlockOp`) operates on the JSON-pure
// `BlockNode` subset; the DB stores `BlockRow` (with createdAt/updatedAt). rank
// stays a string on both sides; `data` passes through untouched.
// ---------------------------------------------------------------------------

/** Project a stored row down to the JSON-pure node the reducer consumes. */
export function rowToNode(row: BlockRow): BlockNode {
  return {
    id: row.id,
    pageId: row.pageId,
    parentId: row.parentId,
    type: row.type,
    data: row.data,
    rank: row.rank,
    expanded: row.expanded,
  };
}

// ---------------------------------------------------------------------------
// Reconcile: diff two block-node arrays by id into insert / update / delete.
// Pure (no DB) so it can be unit-tested in isolation.
// ---------------------------------------------------------------------------

/**
 * Stable deep-equal over JSON-serializable values. Used to compare block `data`
 * payloads (tiny text/icon objects) without depending on key insertion order:
 * objects are compared by their sorted key set, so `{a:1,b:2}` equals
 * `{b:2,a:1}`. Arrays are compared positionally. Sufficient for the JSON values
 * stored in the `data` jsonb column; not a general structural equality.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).sort();
  const bKeys = Object.keys(bo).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!deepEqual(ao[aKeys[i]!], bo[bKeys[i]!])) return false;
  }
  return true;
}

export interface ReconcileResult {
  /** Nodes present in `after` but not in `before`. */
  inserted: BlockNode[];
  /** Nodes present in both whose persisted columns changed. Full after-node. */
  updated: { id: string; node: BlockNode }[];
  /** Ids present in `before` but not in `after`. */
  deletedIds: string[];
}

/**
 * Diff the reducer's before/after block lists by id. A node is `updated` when
 * any persisted structural column differs between the two snapshots
 * (`parentId | rank | data | expanded | type`); `data` is compared with a stable
 * deep-equal so re-serialized-but-equal payloads don't produce spurious writes.
 * Pure — no DB access — so it is independently unit-testable.
 */
export function reconcileBlocks(
  before: BlockNode[],
  after: BlockNode[],
): ReconcileResult {
  const beforeById = new Map(before.map((b) => [b.id, b]));
  const afterById = new Map(after.map((b) => [b.id, b]));

  const inserted: BlockNode[] = [];
  const updated: { id: string; node: BlockNode }[] = [];

  for (const node of after) {
    const prev = beforeById.get(node.id);
    if (!prev) {
      inserted.push(node);
      continue;
    }
    if (
      prev.parentId !== node.parentId ||
      prev.rank !== node.rank ||
      prev.expanded !== node.expanded ||
      prev.type !== node.type ||
      !deepEqual(prev.data, node.data)
    ) {
      updated.push({ id: node.id, node });
    }
  }

  const deletedIds: string[] = [];
  for (const node of before) {
    if (!afterById.has(node.id)) deletedIds.push(node.id);
  }

  return { inserted, updated, deletedIds };
}
