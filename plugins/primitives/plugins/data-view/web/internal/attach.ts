import type { DataViewAttachConfig, DataViewRowEntry } from "../../core";

/**
 * Which rows attach, and beneath which key — the `attach` relation resolved
 * over the rows a view holds (`DataViewAttachConfig`):
 *
 * - `roots` — the rows drawn on their own, in the order given;
 * - `childrenOf` — per parent key, the rows drawn beneath it, in the order
 *   given.
 *
 * A row attaches when its parent key names ANOTHER key some held row carries
 * and that key is anchored — one of its rows is a root, or attaches beneath an
 * anchored key itself. So a parent not held, a self-parent, and a cycle (with
 * every row hanging from it) leave the row top-level: the relation is derived
 * data, and a cycle in it must never hide rows.
 */
export interface ResolvedAttach<TRow> {
  roots: TRow[];
  childrenOf: ReadonlyMap<string, readonly TRow[]>;
}

export function resolveAttach<TRow>(
  rows: readonly TRow[],
  attach: DataViewAttachConfig<TRow>,
): ResolvedAttach<TRow> {
  const keyed = new Map<string, TRow[]>();
  for (const row of rows) {
    const key = attach.getKey(row);
    if (key === null) continue;
    const list = keyed.get(key);
    if (list) list.push(row);
    else keyed.set(key, [row]);
  }
  // The parent key a row asks for, when another held key answers it.
  const asked = (row: TRow): string | null => {
    const parent = attach.getParentKey(row);
    if (parent === null || !keyed.has(parent)) return null;
    return parent === attach.getKey(row) ? null : parent;
  };
  const anchored = new Map<string, boolean>();
  const visiting = new Set<string>();
  const isAnchored = (key: string): boolean => {
    const known = anchored.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return false; // a cycle anchors nothing
    visiting.add(key);
    const result = keyed.get(key)!.some((row) => {
      const parent = asked(row);
      return parent === null || isAnchored(parent);
    });
    visiting.delete(key);
    anchored.set(key, result);
    return result;
  };
  const roots: TRow[] = [];
  const childrenOf = new Map<string, TRow[]>();
  for (const row of rows) {
    const parent = asked(row);
    if (parent === null || !isAnchored(parent)) {
      roots.push(row);
      continue;
    }
    const list = childrenOf.get(parent);
    if (list) list.push(row);
    else childrenOf.set(parent, [row]);
  }
  return { roots, childrenOf };
}

/**
 * The rows a view draws under Sub-items `roots`: every row that would not
 * attach. The `resolveAttach` rule, so `roots` hides exactly what `nested`
 * draws beneath a parent.
 */
export function attachRoots<TRow>(
  rows: readonly TRow[],
  attach: DataViewAttachConfig<TRow>,
): TRow[] {
  return resolveAttach(rows, attach).roots;
}

/** Whether `entry`, or any entry attached beneath it, stands for `key`. */
export function entryHolds<TRow>(
  entry: DataViewRowEntry<TRow>,
  key: string,
  rowKey: (row: TRow) => string,
): boolean {
  if (entry.key === key) return true;
  if (entry.members?.some((m) => rowKey(m) === key)) return true;
  return entry.children?.some((c) => entryHolds(c, key, rowKey)) ?? false;
}

/** The expand-map key of an entry's attached children — prefixed, so it never
 *  collides with the same row's own disclosure (the list's `detail`). */
export function attachExpandKey(entryKey: string): string {
  return `attach:${entryKey}`;
}

/**
 * Whether an entry's attached children are drawn — the one answer every view
 * drawing `entry.children` reads: the view's expand map (`attachExpandKey`)
 * when it holds a choice, else the source's `defaultExpanded`; and always
 * while one of them holds the selected row, which must be on screen to be
 * revealed.
 */
export function attachedChildrenOpen<TRow>(
  entry: DataViewRowEntry<TRow>,
  ctx: {
    attach: DataViewAttachConfig<TRow>;
    expanded: Readonly<Record<string, boolean>> | undefined;
    selectedRowId: string | undefined;
    rowKey: (row: TRow) => string;
  },
): boolean {
  const children = entry.children;
  if (!children) return false;
  const holdsSelected =
    ctx.selectedRowId !== undefined &&
    children.some((c) => entryHolds(c, ctx.selectedRowId!, ctx.rowKey));
  if (holdsSelected) return true;
  return (
    ctx.expanded?.[attachExpandKey(entry.key)] ??
    ctx.attach.defaultExpanded === true
  );
}
