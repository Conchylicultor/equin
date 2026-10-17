import { useMemo } from "react";
import {
  orderFieldsBySection,
  type FieldDef,
  type PropertyEntry,
} from "../../core";

export interface PropertyItem<TRow> {
  field: FieldDef<TRow>;
  visible: boolean;
}

export interface PropertiesController<TRow> {
  /** Ordered rows for the Properties list — EVERY field, hidden ones in their
   *  own place: the stored order, then the fields it does not list appended
   *  hidden (in schema order), band by band. */
  items: PropertyItem<TRow>[];
  /** Show or hide a field in place; materializes the full list on first edit. */
  toggle: (id: string) => void;
  /** Reorder a field to `toIndex` within the `items` list. */
  move: (id: string, toIndex: number) => void;
  /** Reset to the schema default (null) — later-added fields shown again. */
  showAll: () => void;
  /** True once an explicit list is stored (i.e. customized away from the default). */
  isCustomized: boolean;
}

/** Reorder the display items so each section's fields are contiguous, reusing the
 *  ONE section-ordering rule rather than re-deriving it over the item wrapper. */
function orderItemsBySection<TRow>(
  items: PropertyItem<TRow>[],
  schema: FieldDef<TRow>[],
): PropertyItem<TRow>[] {
  const byFieldId = new Map(items.map((i) => [i.field.id, i]));
  return orderFieldsBySection(
    items.map((i) => i.field),
    // Band order from the SCHEMA: these items are stored-then-unlisted, so
    // their own order would decide the bands by accident.
    schema,
  ).map((field) => byFieldId.get(field.id)!);
}

/** arrayMove(items, from, to) — pure, immutable reorder. */
function arrayMove<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/**
 * Builder-facing controller for the per-view-instance Properties list (Notion
 * "Properties"). Mirrors `useSortController`'s shape (memoized facade, flat):
 * every action computes the next ordered `items` immutably, then commits the
 * WHOLE list — every field, `hidden: true` on the ones switched off — through
 * `setProperties` (the host binds that to `setProperties(activeViewId, …)` →
 * `updateView({ properties }, { merge: true })`). Writing the hidden fields too
 * is the point: a field hidden then shown again comes back where it was.
 *
 * `null` (unconfigured) renders the schema's own default body set shown (every
 * field except those declaring `FieldDef.visible: false`) in schema order; the
 * first `toggle`/`move` materializes the explicit list. `showAll()` resets to
 * `null` — back to the schema default, NOT to "everything": a `visible: false`
 * field returns to hidden.
 */
export function usePropertiesController<TRow>(
  fields: FieldDef<TRow>[],
  properties: readonly PropertyEntry[] | null,
  setProperties: (entries: PropertyEntry[] | null) => void,
): PropertiesController<TRow> {
  // The ordered display list. Unconfigured (`null`) → the schema's own default
  // body set shown (every field except those declaring `visible: false`), in
  // schema order. Explicit list → the stored entries in stored order (dropping
  // ids the schema no longer carries), then the fields it does not list appended
  // HIDDEN in schema order — a field added after the view was customized
  // arrives hidden, at the end of its band.
  const items = useMemo<PropertyItem<TRow>[]>(() => {
    if (properties == null) {
      // Seeded from the schema's own default (`FieldDef.visible`), NOT from a
      // hardcoded `true` — otherwise a `visible: false` field would render
      // shown here while `resolveBodyFields` kept it out of the body, and the
      // toggle would silently do nothing on its first click.
      return fields.map((field) => ({
        field,
        visible: field.visible !== false,
      }));
    }
    const byId = new Map(fields.map((f) => [f.id, f]));
    const listed = new Set<string>();
    const ordered: PropertyItem<TRow>[] = [];
    for (const entry of properties) {
      const field = byId.get(entry.id);
      if (!field || listed.has(entry.id)) continue;
      listed.add(entry.id);
      ordered.push({ field, visible: !entry.hidden });
    }
    for (const field of fields) {
      if (!listed.has(field.id)) ordered.push({ field, visible: false });
    }
    // Band by band, matching `resolveBodyFields`. Two things follow, and both
    // are the point: a section is one contiguous run (so the list draws one
    // heading per source), and the displayed order still IS the body order —
    // the commit below writes exactly this order back.
    return orderItemsBySection(ordered, fields);
  }, [fields, properties]);

  const isCustomized = properties != null;

  return useMemo(() => {
    // Commit every field in `next` list order — the single write path.
    const commit = (next: PropertyItem<TRow>[]) =>
      setProperties(
        next.map((i) =>
          i.visible ? { id: i.field.id } : { id: i.field.id, hidden: true },
        ),
      );

    const toggle = (id: string) => {
      commit(
        items.map((i) =>
          i.field.id === id ? { ...i, visible: !i.visible } : i,
        ),
      );
    };
    const move = (id: string, toIndex: number) => {
      const from = items.findIndex((i) => i.field.id === id);
      if (from === -1 || from === toIndex) return;
      commit(arrayMove(items, from, toIndex));
    };
    const showAll = () => setProperties(null);

    return { items, toggle, move, showAll, isCustomized };
  }, [items, setProperties, isCustomized]);
}
