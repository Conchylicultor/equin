import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/core";

export interface FieldType<T = unknown> {
  readonly id: string;
  /** Phantom — inference only, never present at runtime. */
  readonly _T?: T;
}

/** How one value of a closed-set field presents (an enum chip's label, tint and tooltip). */
export interface FieldOptionMeta {
  readonly label: string;
  /** The chip tint; absent ⇒ muted. */
  readonly variant?: BadgeVariant;
  /** The chip's tooltip — why this value means what it means. */
  readonly hint?: string;
  /** Labels filter chips and group sections, but draws no chip in the cell —
   *  for a value that is the unremarkable default ("By hand"), where a chip on
   *  every such row would be noise. */
  readonly quiet?: true;
  /** The value's glyph — what a row draws for it where a glyph stands for
   *  the words (a state in a row's lead), tinted by its `variant`. */
  readonly icon?: IconRef;
}

export interface FieldMeta {
  label?: string;
  description?: string;
  placeholder?: string;
  typeHint?: string;
  /** The record's title field — what a list of its rows names each row by. */
  primary?: boolean;
  /** `false` opts the field out of filtering (a list derives a filter for every field it can). */
  filterable?: false;
  /**
   * Each value's presentation, for a closed-set field (`enumTextField`'s
   * `options`), keyed by each value's canonical spelling (`optionKey`: a
   * string itself, `"true"` / `"false"`, `"null"`). Not named `options`: a factory's own
   * `options` (`enumField`'s pickable list) is spelled beside the meta.
   */
  optionMeta?: Readonly<Record<string, FieldOptionMeta>>;
}

/**
 * What a field's value IS for a row — the vocabulary a DataView places fields
 * by (a `quantity` trails right-aligned, an `instant` sits at the row's edge…).
 * A closed list: every field type declares one on its identity, and a type
 * that `extends` another inherits it unless it declares its own. A `state`
 * is never declared — a list decides it from the options (a closed-set field
 * whose options declare a tint).
 */
export const FIELD_KINDS = [
  "label",
  "prose",
  "state",
  "instant",
  "duration",
  "quantity",
  "ordinal",
  "identifier",
  "person",
  "path",
  "visual",
  "flag",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

interface FieldIdentityBase<T> {
  readonly type: FieldType<T>;
  readonly label?: string;
  readonly icon?: IconRef;
  /** Opt-in: this type may be chosen when adding a custom DataView column. */
  readonly customColumn?: boolean;
  /** Projection to a sortable/comparable scalar (Date→ms, bool→0/1, …). */
  readonly coerce?: (value: T) => string | number | null;
  /**
   * Human-readable sort-direction labels for this type, mirroring Notion's
   * type-aware sort menu ("A → Z" / "Z → A" for text, "Newest first" for dates).
   * `asc`/`desc` map to the ascending/descending comparator. Inherited via the
   * `extends` chain (int/float reuse number's). Omitted → the generic
   * "Ascending" / "Descending" fallback.
   */
  readonly directionLabels?: { readonly asc: string; readonly desc: string };
}

/**
 * A field type's identity. A root type (no `extends`) must declare its
 * {@link FieldKind}; a derived type inherits its base's unless it declares
 * its own — so no type falls into a kind by accident.
 */
export type FieldIdentity<T = unknown> = FieldIdentityBase<T> &
  (
    | {
        /** Base type whose table/filter contributions this type inherits (one hop in practice). */
        readonly extends: FieldType;
        readonly kind?: Exclude<FieldKind, "state">;
      }
    | {
        readonly extends?: undefined;
        readonly kind: Exclude<FieldKind, "state">;
      }
  );
