// The rows a live tree draws, assembled from what it read (pure — the hook in
// `use-live-tree.tsx` holds the reads). A live tree's rows are never one
// read: the root window (or the hits), one window per open node, the context
// rows (a hit's ancestors, a revealed row's path) and the moves in flight.
// `buildTree` keeps each parent's children in INCOMING order, so what this
// decides is the order of each sibling list — the windows' own order (the
// server's, a sort included: the client never re-sorts it), with every row
// that is not a window's placed among them.

/** How a row's identity and place are read (the collection's id and `tree.parent`). */
export interface TreeRowAccess<R> {
  idOf: (row: R) => string;
  parentOf: (row: R) => string | null;
}

/**
 * A drop in flight (`HierarchyConfig.onMove`'s positional intent), drawn as
 * `row` — the moved row as last read — under `parentId`, beside `targetId`
 * (`null`: after the loaded siblings), and nowhere else.
 */
export interface PendingTreeMove<R> {
  row: R;
  parentId: string | null;
  targetId: string | null;
  zone: "before" | "after";
}

/** The assembled rows and each one's parent as drawn (a pending move's destination). */
export interface AssembledTree<R> {
  rows: readonly R[];
  parentOf: ReadonlyMap<string, string | null>;
  /**
   * Rows whose parent is not drawn and never will be from what was read — a
   * row whose ancestor is outside the collection (its served `where`). They
   * are drawn as roots, the in-memory pipeline's orphan rule (`buildTree`).
   */
  orphans: ReadonlySet<string>;
}

/**
 * Assemble the rows a live tree draws:
 *
 * 1. `roots` — the root window, or the hits — in read order, each once;
 * 2. the open levels (`levels`, by parent id), walked from what is drawn: a
 *    level is drawn only while its parent is (a node that just left its
 *    window drags no stale children along — its reader is about to be
 *    released);
 * 3. each `pin` not already drawn (a hit's ancestor, a revealed path row, an
 *    alias target), ancestors first, among its parent's siblings at the place
 *    `compare` gives it — right before the first sibling ordering after it,
 *    else right after the last loaded one (before the level's "Load more") —
 *    and the levels under it walked in turn;
 * 4. each pending move: the row taken out of its place and put beside its
 *    anchor under its destination (after the destination's last loaded child
 *    when the anchor is none or not drawn); under a destination not drawn it
 *    is not drawn at all.
 *
 * A read row whose parent is still not drawn is an orphan, drawn as a root
 * ({@link AssembledTree.orphans}). The read rows stay in read order relative
 * to each other (a paged read's tail is its last row), and each parent's
 * children are in their drawn order — all `buildTree` reads, since it keeps
 * incoming order per parent.
 */
export function assembleTreeRows<R>(args: {
  access: TreeRowAccess<R>;
  roots: readonly R[];
  levels?: ReadonlyMap<string, readonly R[]>;
  pins?: readonly R[];
  compare: (a: R, b: R) => number;
  moves?: readonly PendingTreeMove<R>[];
}): AssembledTree<R> {
  const {
    access,
    roots,
    levels = NO_LEVELS,
    pins = [],
    compare,
    moves = [],
  } = args;
  const { idOf } = access;
  const out: R[] = [];
  const parent = new Map<string, string | null>();
  const take = (row: R, under: string | null) => {
    parent.set(idOf(row), under);
    out.push(row);
  };
  for (const row of roots) {
    if (!parent.has(idOf(row))) take(row, access.parentOf(row));
  }
  /** Insert `row` under `parentId` at the sibling place `before` picks. */
  const insert = (
    row: R,
    parentId: string | null,
    before: (sibling: R) => boolean,
  ) => {
    let last = -1;
    let at = -1;
    out.forEach((r, i) => {
      if (at >= 0 || parent.get(idOf(r)) !== parentId) return;
      if (before(r)) at = i;
      else last = i;
    });
    const index = at >= 0 ? at : last >= 0 ? last + 1 : out.length;
    out.splice(index, 0, row);
    parent.set(idOf(row), parentId);
  };
  const walked = new Set<string>();
  const walkLevels = () => {
    for (let i = 0; i < out.length; i++) {
      const id = idOf(out[i]!);
      if (walked.has(id)) continue;
      walked.add(id);
      for (const child of levels.get(id) ?? []) {
        if (!parent.has(idOf(child))) take(child, id);
      }
    }
  };
  walkLevels();
  for (const pin of pins) {
    if (parent.has(idOf(pin))) continue;
    insert(pin, access.parentOf(pin), (sibling) => compare(pin, sibling) < 0);
    walkLevels();
  }
  for (const move of moves) {
    const id = idOf(move.row);
    const i = out.findIndex((r) => idOf(r) === id);
    if (i >= 0) out.splice(i, 1);
    parent.delete(id);
    if (move.parentId !== null && !parent.has(move.parentId)) continue;
    const target =
      move.targetId === null
        ? -1
        : out.findIndex(
            (r) =>
              idOf(r) === move.targetId &&
              parent.get(idOf(r)) === move.parentId,
          );
    if (target < 0) {
      insert(move.row, move.parentId, () => false);
    } else {
      out.splice(move.zone === "before" ? target : target + 1, 0, move.row);
      parent.set(id, move.parentId);
    }
  }
  const orphans = new Set<string>();
  for (const row of out) {
    const p = parent.get(idOf(row))!;
    if (p !== null && !parent.has(p)) orphans.add(idOf(row));
  }
  return { rows: out, parentOf: parent, orphans };
}

/**
 * The rows under a root the source's scope admits — a live tree's scope is
 * the ROOT level's (a subtree is whole, as `filterScope: "roots"` means), so
 * a hit is kept when the root of its drawn chain (an orphan is its own root)
 * matches. `inScope` is the scope's predicate over a root row.
 */
export function scopedToRoots<R>(
  tree: AssembledTree<R>,
  idOf: (row: R) => string,
  inScope: (root: R) => boolean,
): readonly R[] {
  const byId = new Map(tree.rows.map((r) => [idOf(r), r]));
  const rootOf = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    for (;;) {
      const p = tree.parentOf.get(cur) ?? null;
      if (p === null || !byId.has(p) || seen.has(p)) return cur;
      seen.add(cur);
      cur = p;
    }
  };
  const verdict = new Map<string, boolean>();
  return tree.rows.filter((row) => {
    const root = rootOf(idOf(row));
    let ok = verdict.get(root);
    if (ok === undefined) {
      ok = inScope(byId.get(root)!);
      verdict.set(root, ok);
    }
    return ok;
  });
}

const NO_LEVELS: ReadonlyMap<string, readonly never[]> = new Map();
