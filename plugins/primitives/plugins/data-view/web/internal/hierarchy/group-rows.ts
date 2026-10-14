import type { DataViewSection, FieldDef } from "../../../core";
import type { ProjectedRow } from "./project-rows";

/**
 * Roots under the same orphan rule as `buildTree`: a row whose `parentId` is
 * null OR references a row absent from the projected set renders as a root.
 * (Filtering/search can drop a parent while keeping its matching descendant.)
 */
export function projectedRoots<TRow>(
  projected: readonly ProjectedRow<TRow>[],
): ProjectedRow<TRow>[] {
  const ids = new Set(projected.map((p) => p.id));
  return projected.filter((p) => p.parentId === null || !ids.has(p.parentId));
}

/**
 * Adapt the consumer's fields to the projected row shape so the shared
 * `partitionIntoSections` can run over `ProjectedRow<TRow>` roots (whose stable
 * key is simply `.id`). Only the members the partition reads are carried —
 * identity/type/options/groupable plus the `value` projection unwrapped to the
 * raw `__row` — so the row-typed render/edit callbacks never need an unsound
 * cast across the wrapper type.
 */
export function fieldsForProjected<TRow>(
  fields: FieldDef<TRow>[],
): FieldDef<ProjectedRow<TRow>>[] {
  return fields.map((f) => {
    const value = f.value;
    return {
      id: f.id,
      label: f.label,
      type: f.type,
      options: f.options,
      groupable: f.groupable,
      value: value ? (p: ProjectedRow<TRow>) => value(p.__row) : undefined,
    };
  });
}

/**
 * Bucket ALL projected rows into per-section lists by their root ancestor's
 * section: climb `parentId` to each row's root, then place the row in the
 * bucket of the section holding that root — children follow their root
 * regardless of their own group-by value. `rootSections` is the shared
 * partition of `projectedRoots(projected)`; the returned buckets align with it
 * by index and preserve the incoming `projected` order.
 */
export function bucketRowsByRootSection<TRow>(
  projected: readonly ProjectedRow<TRow>[],
  rootSections: readonly DataViewSection<ProjectedRow<TRow>>[],
): ProjectedRow<TRow>[][] {
  const ids = new Set(projected.map((p) => p.id));
  const parentById = new Map(projected.map((p) => [p.id, p.parentId]));
  const sectionByRootId = new Map<string, number>();
  rootSections.forEach((section, si) => {
    for (const entry of section.entries) sectionByRootId.set(entry.row.id, si);
  });

  // Memoized root climb — each id resolved once, so the whole pass stays O(n).
  // A parent cycle (corrupt data; `buildTree` renders no such row) terminates
  // at the first repeat and treats the entry point as its own root.
  const rootOf = new Map<string, string>();
  const resolveRoot = (id: string): string => {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur = id;
    let root: string;
    for (;;) {
      const cached = rootOf.get(cur);
      if (cached !== undefined) {
        root = cached;
        break;
      }
      const parent = parentById.get(cur) ?? null;
      if (parent === null || !ids.has(parent) || onPath.has(parent)) {
        root = cur;
        break;
      }
      path.push(cur);
      onPath.add(cur);
      cur = parent;
    }
    rootOf.set(cur, root);
    for (const p of path) rootOf.set(p, root);
    return root;
  };

  const buckets: ProjectedRow<TRow>[][] = rootSections.map(() => []);
  for (const p of projected) {
    const si = sectionByRootId.get(resolveRoot(p.id));
    // Every climb ends at a projected root and every root sits in exactly one
    // section — a miss would be a partition bug, so fail loudly.
    if (si === undefined) {
      throw new Error(
        `bucketRowsByRootSection: root of row "${p.id}" is in no section`,
      );
    }
    buckets[si]!.push(p);
  }
  return buckets;
}
