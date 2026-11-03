import type { ComponentType, ReactNode } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import type {
  DataViewId,
  FieldDef,
  FieldValue,
  SurfaceCustomColumns,
} from "../../core";

// The field-extension contract (`DataViewSlots.FieldExtension`): a web
// contract — a contributor is a component that renders through `render`, and
// hands its values over as a live read.

/**
 * Props a field-extension contribution receives. A contribution is a **component**
 * (not a plain `FieldDef[]`) so it can gather hook-loaded data (e.g. a live
 * resource keyed by row id) and close its field `value` projections over it,
 * then hand the resulting fields back via `render`. The host folds each
 * contributor's fields into the DataView's schema. The render-callback shape is
 * the generic lift of Sonata's old `Library.Sort` ordering-component slot.
 *
 * Every contributor also receives the surface coordinates — the `storageKey`
 * (which surface) and `rowKey` (how to identify a row) — so a cross-cutting
 * contributor (e.g. custom-columns) can key its per-row data over the surface. A
 * contributor that doesn't need them (e.g. Sonata's play-count, which closes over
 * its own live resource) simply ignores them.
 */
/** Method-position parameter ⇒ checked bivariantly (see `FieldExtensionProps.rowKey`). */
type BivariantRowKey<TRow> = {
  key(row: TRow, index: number): string;
}["key"];

export interface FieldExtensionProps<TRow> {
  /** Which surface this DataView is (the `defineDataView` id). */
  storageKey: DataViewId;
  /** How to identify a row — used to key per-row data. Bivariant on purpose:
   *  with a plain `(row: TRow) => …` this one member made the whole descriptor
   *  invariant, so a surface whose rows EXTEND `R` (the deps tree's
   *  `DepsTreeRow extends TaskListItem`) could not take extensions declared for
   *  `R`. Sound: a contributor only ever keys rows the host handed it, which are
   *  the host's own. `render` stays strict, so the reverse (an extension for a
   *  narrower row on a wider surface) is still a type error. */
  rowKey: BivariantRowKey<TRow>;
  /**
   * How this surface's custom columns reach its rows: `in-memory` (every
   * field sorts and filters over the loaded rows), `scoped` (its live
   * collection takes `scopedColumns` — a contributor serving scoped columns
   * binds its fields to them in this surface's scope, `FieldDef.column`), or `unscoped` (its
   * live collection cannot take them, for the stated reason — the fields show
   * and edit, and do not sort or filter).
   */
  liveColumns: SurfaceCustomColumns;
  /**
   * Hand the host this contributor's extra fields AND their values, as one
   * read (called in render — the component is mounted, so it may load
   * hook-backed data first). The host stamps each field's `value` and its
   * read state (`pending` while loading with nothing held, `readError` once
   * failed with nothing held, the held values on a failure over them) — so a
   * contributor cannot hand in a stand-in value while its read loads.
   * `null`: this surface gets no field from it.
   */
  render: (contributed: FieldExtensionYield<TRow> | null) => ReactNode;
}

/** The keys of a field that say what its values ARE — the host's to stamp from a read. */
type FieldReadKeys = "value" | "values" | "pending" | "readError" | "rowState";

/** `Omit` over each arm of a union (a plain `Omit` would merge `options` / `optionsResult`). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * A field a field extension contributes, BEFORE its values are read: every
 * `FieldDef` property but the ones a read decides (`value`, `values`,
 * `pending`, `readError`, `rowState` — each `never`, a tsc error to author).
 */
export type ExtensionField<TRow> = DistributiveOmit<
  FieldDef<TRow>,
  FieldReadKeys
> & { [K in FieldReadKeys]?: never };

/** What a field extension hands back: its fields, and their values per row as ONE read. */
export interface FieldExtensionYield<TRow> {
  fields: readonly ExtensionField<TRow>[];
  /** Each contributed field's value per row, by field id — one reader per field, no more, no fewer. */
  values: ResourceResult<Readonly<Record<string, (row: TRow) => FieldValue>>>;
}

/**
 * Minimal field-extensions surface the host consumes. `defineFieldExtensions`
 * (web) returns a value satisfying this (the `RenderSlot`'s own `id` +
 * `useContributions`) PLUS the callable contribution-registrar — mirroring
 * `ItemActionsDescriptor`. The host (`CollectFieldExtensions`) reads
 * `useContributions()` and mounts each contribution isolated under `id`.
 */
export interface FieldExtensionsDescriptor<TRow> extends SlotHandle {
  /** All contributed field-extension components (sealed, like any slot). */
  useContributions: Hook<
    () => readonly SealContributions<{
      id: string;
      /** The heading this contributor's fields are listed under (`null` = they are
       *  ordinary fields of the host's own schema). The host STAMPS it onto every
       *  field the contributor returns — see `FieldDef.section`. */
      section: string | null;
      component: ComponentType<FieldExtensionProps<TRow>>;
      order?: number;
    }>[]
  >;
}
