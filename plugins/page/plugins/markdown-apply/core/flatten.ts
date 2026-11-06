// Document-order traversal of a stored subtree, and the identity KEY each node
// aligns by.
//
// One traversal, two consumers. `markdownNodesOfRows` is what a caller hands to
// `serializeForestToMarkdown` to produce the markdown an agent edits;
// `documentOrderRows` is what the planner diffs the edited document against.
// They MUST be the same walk — if the serializer emitted the rows in one order
// and the planner flattened them in another, the plan would be a diff against a
// document nobody ever saw. So both are built from one `childrenByParent` index
// and one comparator, in this module, rather than each re-deriving "rank-ordered
// DFS from the page row".

import {
  PAGE_BLOCK_TYPE,
  plainOf,
  withoutDisplayOnly,
  type BlockHandle,
  type MarkdownNode,
} from "@plugins/page/plugins/editor/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { StoredRow } from "./stored-row";

/**
 * Children of each parent, rank-ascending. Rows that do not connect to the
 * walk's root are simply never reached — the same call history restore's
 * top-down walk over a version makes, for the same reason: an unreachable row
 * cannot be placed, and a planner that cannot place a row must not claim
 * authority to delete it either.
 */
function childrenByParent(
  rows: readonly StoredRow[],
): Map<string | null, StoredRow[]> {
  const byParent = new Map<string | null, StoredRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.parentId);
    if (list) list.push(row);
    else byParent.set(row.parentId, [row]);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => Rank.compare(Rank.from(a.rank), Rank.from(b.rank)));
  }
  return byParent;
}

/**
 * A sub-page SHELL is a leaf of THIS page's forest: its own content lives under
 * a different `page_id` partition and is not in `rows` at all. Never descending
 * into one is therefore both correct and load-bearing — it is what makes every
 * shell serialize as the self-closing `<page id="…"/>` pointer, which is the
 * only form the parse side accepts (a body on a parsed page tag is a loud
 * rejection).
 */
function isShell(row: StoredRow): boolean {
  return row.type === PAGE_BLOCK_TYPE;
}

/**
 * The content rows of the subtree ROOTED at `rootId`, in document order
 * (rank-ordered DFS over its descendants).
 *
 * `rootId` is the SCOPE, not content: the walk starts at its children, so the
 * root row itself is never in the output — which is what bounds every authority
 * downstream of this walk (the planner derives `deleteIds` from it) to the
 * subtree, and leaves the root itself untouchable. The page row is one root
 * among others; a whole-page walk and a walk from any block within the page are
 * the same walk at different depths, which is why this takes a `rootId` rather
 * than a page id.
 */
export function documentOrderRows(
  rows: readonly StoredRow[],
  rootId: string,
): StoredRow[] {
  const byParent = childrenByParent(rows);
  const out: StoredRow[] = [];
  const walk = (parentId: string | null): void => {
    for (const row of byParent.get(parentId) ?? []) {
      out.push(row);
      if (!isShell(row)) walk(row.id);
    }
  };
  walk(rootId);
  return out;
}

/**
 * The same walk, shaped for `serializeForestToMarkdown`. `MarkdownNode.id` is
 * stamped from the row id — required, not decorative: a sub-page's identity IS
 * its row id, and `<page id="…"/>` is the only thing that lets a later apply
 * reconcile the tag against the existing row rather than re-minting it.
 *
 * Same `rootId` contract as {@link documentOrderRows}: the emitted document is
 * the root's CONTENT, and the root itself has no line in it.
 *
 * `annotations` carries the values of a tag's `markdown.tag.annotated`
 * attributes — facts about a row that live in ANOTHER table (a TODO card's
 * linked task and its status), resolved by the caller and keyed by block id. A
 * row the map says nothing about gets no `annotations` KEY at all, not an
 * `undefined` one: the same structural-identity rule the parse side keeps for
 * `ref`, so a node built here is byte-for-byte a node built without a map.
 *
 * **The planner is deliberately not told about any of this.** A void card's
 * alignment key is `type ␀ stableJson(data)` (see {@link identityKeyOf}) and an
 * annotation is by definition not in `data` — so dispatching an agent from a
 * TODO changes what the card SAYS without changing what it IS, and the card
 * keeps its row id through the next apply with no rank rewritten. An annotation
 * that reached the key would make every status change look like a new block.
 */
export function markdownNodesOfRows(
  rows: readonly StoredRow[],
  rootId: string,
  annotations?: ReadonlyMap<string, Record<string, string>>,
): MarkdownNode[] {
  const byParent = childrenByParent(rows);
  const build = (parentId: string | null): MarkdownNode[] =>
    (byParent.get(parentId) ?? []).map((row) => {
      const annotated = annotations?.get(row.id);
      return {
        id: row.id,
        type: row.type,
        data: row.data,
        expanded: row.expanded,
        children: isShell(row) ? [] : build(row.id),
        ...(annotated === undefined ? {} : { annotations: annotated }),
      };
    });
  return build(rootId);
}

// ---------------------------------------------------------------------------
// Identity keys
// ---------------------------------------------------------------------------

/**
 * Separates a key's fields. NUL rather than a printable character: a block type
 * name is arbitrary text, and a separator a type could itself contain would let
 * `("a b", "c")` and `("a", "b c")` mint one key. Spelled as a char code so the
 * byte never appears literally in this source file.
 */
const SEP = String.fromCharCode(0);

/**
 * Deterministic, key-order-independent JSON. `JSON.stringify` is positional over
 * an object's insertion order, so two `data` blobs that `dataEqual` considers
 * identical can stringify differently — which would make an unchanged void block
 * look like a different block and cost it its id. Block `data` originates from a
 * `jsonb` column, so it is always JSON-serializable.
 */
export function stableJson(value: unknown): string {
  // `undefined` is the one JSON-less value a `data` blob can carry (an optional
  // field the schema left off), and it is the ABSENCE of a key everywhere else
  // in this function, so it must read the same here.
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/**
 * The plain text a node aligns by — marks and colors deliberately excluded, so a
 * bold-only edit still produces an EXACT key match (the block is untouched
 * structurally; the changed runs ride the text channel instead). Void types have
 * no text lens and answer `""`.
 */
export function plainTextOf(
  data: unknown,
  handle?: BlockHandle<unknown>,
): string {
  return handle?.text ? plainOf(handle.text(data)) : "";
}

/**
 * The identity key one node aligns by.
 *
 * - text-bearing → `type ␀ plainText`. Two blocks of the same type reading the
 *   same words ARE the same line as far as an alignment can tell; which of
 *   several such lines is which is then decided by POSITION, which is exactly
 *   what the LCS over these keys answers.
 * - void → `type ␀ stableJson(data)`, display-only keys stripped. A void
 *   block's payload is its content.
 * - a node whose identity is ASSERTED — a sub-page shell, or an identified card
 *   the document addressed by id — → pinned to the row id (see
 *   {@link pinnedRowKey}), never inferred from content.
 */
export function identityKeyOf(
  type: string,
  data: unknown,
  handle?: BlockHandle<unknown>,
): string {
  // A void block's DISPLAY state (a table's column widths) is not what it says:
  // markdown never carries it, so a stored row and its parsed line must key alike.
  return handle?.text
    ? `${type}${SEP}${plainOf(handle.text(data))}`
    : `${type}${SEP}${stableJson(withoutDisplayOnly(handle, data))}`;
}

/**
 * The key both halves of an ASSERTED identity share: the stored ROW on one side,
 * and whatever names it on the other — the `<page id="…"/>` pointer a shell
 * parses back into, or an identified card's `ref`. The leading separator makes
 * it unreachable from {@link identityKeyOf}, whose keys all start with a block
 * type name.
 *
 * **One namespace, deliberately, for every kind of pin.** A pin's value is a ROW
 * ID, which is unique across the whole forest whatever the row's type is, so
 * per-kind namespacing would buy nothing and cost the one property that makes
 * the aligner's pin pass total: two nodes claiming the same row are the same
 * claim, and are caught as a duplicate, whichever tag they arrived under.
 */
export function pinnedRowKey(rowId: string): string {
  return `${SEP}pinned${SEP}${rowId}`;
}
