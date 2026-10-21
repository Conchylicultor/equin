/**
 * The 3-way merge of two drizzle snapshots against their nearest common
 * ancestor — the content of a merge node
 * (research/2026-09-30-global-clone-migrations-published-set.md §3). PURE.
 *
 * Plain objects are merged key by key, recursively; arrays and scalars are
 * leaves compared by deep equality. For each key:
 *
 * - ours equals base → theirs; theirs equals base → ours; ours equals theirs →
 *   either (absent on a side counts as a value, so a delete merges like an edit);
 * - a key ABSENT from base and added on both sides is always a conflict, even
 *   when both additions are identical. Each side's migrations carry their own
 *   DDL for it, and that DDL is not idempotent in general: drizzle emits bare
 *   `ADD COLUMN`, so the second side's statement fails; and although it emits
 *   `CREATE TABLE IF NOT EXISTS`, that makes the second side's table a silent
 *   no-op, which would drop any column only that side declared. When the two
 *   additions are objects that differ, the conflict is reported at each differing
 *   leaf — so two sides adding column `note` with different types conflict at
 *   `….columns.note.type` — otherwise at the added key itself;
 * - otherwise, when both sides are plain objects, recurse;
 * - otherwise it is a conflict: a key deleted on one side and changed on the
 *   other, or a leaf changed differently on both.
 *
 * `id`, `prevId` and `_meta` (drizzle's per-migration rename hints) are not
 * merged: the merge node gets its own id and prevId, and an empty `_meta`.
 */

/** drizzle's `_meta` when a generation renamed nothing. */
export const EMPTY_SNAPSHOT_META = { columns: {}, schemas: {}, tables: {} };

const EXCLUDED_TOP_LEVEL = new Set(["id", "prevId", "_meta"]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Snapshot = { [k: string]: Json };

/** One path both sides changed differently. `undefined` = absent on that side. */
export interface SnapshotConflict {
  path: string[];
  ours: Json | undefined;
  theirs: Json | undefined;
  base: Json | undefined;
}

export type SnapshotMergeResult =
  { ok: true; merged: Snapshot } | { ok: false; conflicts: SnapshotConflict[] };

function isPlainObject(v: unknown): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null)
    return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

// Merge one value; `undefined` in the result means "absent".
function mergeValue(
  path: string[],
  base: Json | undefined,
  ours: Json | undefined,
  theirs: Json | undefined,
  conflicts: SnapshotConflict[],
): Json | undefined {
  if (deepEqual(ours, base)) return theirs;
  if (deepEqual(theirs, base)) return ours;
  // Added on both sides (base absent, both present — neither equals base).
  if (base === undefined) {
    const before = conflicts.length;
    diffLeaves(path, ours, theirs, conflicts);
    if (conflicts.length === before) {
      conflicts.push({ path, ours, theirs, base });
    }
    return ours;
  }
  // Objects are recursed into even when equal: two identical subtrees can each
  // hold the same key newly added on both sides, which is a conflict above.
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    return mergeObject(
      path,
      isPlainObject(base) ? base : {},
      ours,
      theirs,
      conflicts,
    );
  }
  // The same change to an existing leaf on both sides.
  if (deepEqual(ours, theirs)) return ours;
  conflicts.push({ path, ours, theirs, base });
  return ours;
}

/**
 * Where two independently added values differ, as conflicts with an absent
 * base: a key only one side has, or a leaf the two sides set differently.
 * Identical values push nothing — the caller then reports the added key itself.
 */
function diffLeaves(
  path: string[],
  ours: Json | undefined,
  theirs: Json | undefined,
  conflicts: SnapshotConflict[],
): void {
  if (deepEqual(ours, theirs)) return;
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    const keys = [
      ...Object.keys(ours),
      ...Object.keys(theirs).filter((k) => !(k in ours)),
    ];
    for (const k of keys)
      diffLeaves([...path, k], ours[k], theirs[k], conflicts);
    return;
  }
  conflicts.push({ path, ours, theirs, base: undefined });
}

function mergeObject(
  path: string[],
  base: { [k: string]: Json },
  ours: { [k: string]: Json },
  theirs: { [k: string]: Json },
  conflicts: SnapshotConflict[],
  exclude: ReadonlySet<string> = new Set(),
): { [k: string]: Json } {
  const out: { [k: string]: Json } = {};
  // Base's key order, then the keys base lacks in sorted order — NEVER one
  // side's order: the output must not depend on which tip is "ours", so a merge
  // node is the same bytes whichever order its tips are folded in.
  const added = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  for (const k of Object.keys(base)) added.delete(k);
  const keys = [...Object.keys(base), ...[...added].sort()];
  for (const k of keys) {
    if (exclude.has(k)) continue;
    const v = mergeValue([...path, k], base[k], ours[k], theirs[k], conflicts);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Merge `ours` and `theirs` against `base`. The result carries no `id`,
 * `prevId` or `_meta` — the caller stamps the merge node's own.
 */
export function mergeSnapshots(
  base: Snapshot,
  ours: Snapshot,
  theirs: Snapshot,
): SnapshotMergeResult {
  const conflicts: SnapshotConflict[] = [];
  const merged = mergeObject(
    [],
    base,
    ours,
    theirs,
    conflicts,
    EXCLUDED_TOP_LEVEL,
  );
  return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true, merged };
}

/**
 * Whether two snapshots describe the same schema: deep equality over every
 * top-level key but `id`, `prevId` and `_meta` — the same keys a merge ignores.
 */
export function equivalentSnapshots(a: Snapshot, b: Snapshot): boolean {
  const strip = (s: Snapshot) =>
    Object.fromEntries(
      Object.entries(s).filter(([k]) => !EXCLUDED_TOP_LEVEL.has(k)),
    );
  return deepEqual(strip(a), strip(b));
}

function show(v: Json | undefined): string {
  if (v === undefined) return "<absent>";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * One line per conflict:
 * `tables.public.foo.columns.bar.type: ours=text theirs=integer base=<absent>`.
 * Path segments are joined with `.` as they are — drizzle's table keys already
 * read `public.<table>`.
 */
export function formatSnapshotConflict(c: SnapshotConflict): string {
  return `${c.path.join(".")}: ours=${show(c.ours)} theirs=${show(c.theirs)} base=${show(c.base)}`;
}
