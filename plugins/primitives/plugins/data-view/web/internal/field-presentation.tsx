import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { DataViewRowsComplete, FieldDef, FieldValue } from "../../core";
import { useIsChipField } from "../cell-slot";

// How a view's field cells present, and which of their values say nothing.
//
// A row view (list, the nested table's outline) draws its chip-typed values
// QUIET — a dot and the label, no filled chip — and leaves out a value most of
// its rows share: in a list of forty tasks, thirty-eight "Claude" chips are the
// default, not information. The table never mounts the provider, so a cell
// outside one presents as it always did (a chip, nothing elided): its columns
// align, and a column of one repeated value is a column that reads at a glance.
//
// One context, the `FieldExtentsContext` pattern: computed ONCE per view over
// its rows, read by every `FieldCell`. Outside a provider, the constant default.

/** A value's canonical key, as elision compares it (an enum option's `value`). */
type ValueKey = string;

/** What every `FieldCell` inside a provider reads. */
export interface FieldPresentation {
  /** `"chip"` (the default — a table cell) or `"quiet"` (a row view's terms). */
  presentation: "chip" | "quiet";
  /** Field id → the value it leaves out: the one most of the view's rows hold. */
  elided: ReadonlyMap<string, ValueKey>;
}

const DEFAULT: FieldPresentation = { presentation: "chip", elided: new Map() };

const FieldPresentationContext = createContext<FieldPresentation>(DEFAULT);

/** The share of the view's rows a value must hold to be left out. */
export const ELISION_THRESHOLD = 0.6;

/** Below this many rows nothing is elided: in a list of one or two rows the
 *  "common" value is simply the row's value, and leaving it out would leave
 *  the row saying nothing. */
export const ELISION_MIN_ROWS = 3;

/** A scalar's key, or `null` when it is empty (an empty blocks elision). */
function scalarKey(value: FieldValue): ValueKey | null {
  if (value == null || value === "") return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * The value each candidate field leaves out over `rows`, or none.
 *
 * A candidate is a field whose resolved cell presents as a chip (`isChip` — the
 * Cell registry's flag, so no field type is named here), that reads a value,
 * and that is not editable (an elided editable cell would take its pencil with
 * it). A value is left out when it is held by at least
 * {@link ELISION_THRESHOLD} of the rows — and ONLY when no row has the field
 * empty: with a blank beside it an elided cell would read as "no value" too,
 * and the two would be indistinguishable. A multi-value field (`values`) is
 * counted per member (a tag most rows carry); its own `cell` override, which
 * the elision cannot filter, makes it no candidate.
 *
 * `complete` is whether `rows` is the whole set: a paged read's share of a
 * value changes as pages land, so nothing is elided until it is read to its
 * end — a value would otherwise appear and vanish as the reader scrolls.
 */
export function computeElided(
  rows: readonly unknown[],
  fields: readonly FieldDef<unknown>[],
  isChip: (field: FieldDef<unknown>) => boolean,
  complete: boolean,
): ReadonlyMap<string, ValueKey> {
  const out = new Map<string, ValueKey>();
  if (!complete || rows.length < ELISION_MIN_ROWS) return out;
  for (const field of fields) {
    if (field.onEdit != null || field.onEditValues != null) continue;
    if (field.pending === true || field.readError != null) continue;
    if (!isChip(field)) continue;
    const counts = new Map<ValueKey, number>();
    let empty = false;
    if (field.values) {
      if (field.cell) continue;
      for (const row of rows) {
        const values = field.values(row);
        if (values.length === 0) {
          empty = true;
          break;
        }
        for (const v of new Set(values))
          counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    } else if (field.value) {
      for (const row of rows) {
        const key = scalarKey(field.value(row));
        if (key === null) {
          empty = true;
          break;
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    } else {
      continue;
    }
    if (empty) continue;
    let top: ValueKey | null = null;
    let topCount = 0;
    for (const [key, n] of counts) {
      if (n > topCount) {
        top = key;
        topCount = n;
      }
    }
    if (top !== null && topCount / rows.length >= ELISION_THRESHOLD) {
      out.set(field.id, top);
    }
  }
  return out;
}

export interface FieldPresentationProviderProps {
  /** The rows the view draws (the elision's population). */
  rows: readonly unknown[];
  /** The fields whose values may be left out — the row's terms, never its
   *  title or leading visual (the row's identity). */
  fields: readonly FieldDef<unknown>[];
  /** `DataViewRenderProps.rowsComplete`: elision runs only on `true`. */
  rowsComplete: DataViewRowsComplete<unknown>;
  children: ReactNode;
}

/**
 * Mounted by a ROW view (list, the nested table's outline) around its body:
 * every `FieldCell` inside presents quiet, and the value most rows share is
 * left out (see {@link computeElided}). The table never mounts it.
 */
export function FieldPresentationProvider({
  rows,
  fields,
  rowsComplete,
  children,
}: FieldPresentationProviderProps): ReactNode {
  const isChip = useIsChipField();
  const complete = rowsComplete === true;
  // Spelled as a string, so the context value keeps its identity while the
  // ANSWER is the same: a new rows array (every host render, every live
  // delta) must not re-render every memoized row reading it.
  const spelled = useMemo(
    () => JSON.stringify([...computeElided(rows, fields, isChip, complete)]),
    [rows, fields, isChip, complete],
  );
  const value = useMemo<FieldPresentation>(
    () => ({
      presentation: "quiet",
      elided: new Map(JSON.parse(spelled) as [string, ValueKey][]),
    }),
    [spelled],
  );
  return (
    <FieldPresentationContext.Provider value={value}>
      {children}
    </FieldPresentationContext.Provider>
  );
}

/** The enclosing view's presentation; the chip default outside a provider. */
export function useFieldPresentation(): FieldPresentation {
  return useContext(FieldPresentationContext);
}

/**
 * Whether `field`'s whole read on `row` is left out: a scalar holding the
 * elided value, or a multi-value field all of whose values are it. The list's
 * subtitle drops such a term, separator and all.
 */
export function isElidedRead(
  p: FieldPresentation,
  field: FieldDef<unknown>,
  row: unknown,
): boolean {
  const key = p.elided.get(field.id);
  if (key === undefined) return false;
  if (field.values) {
    const values = field.values(row);
    return values.length > 0 && values.every((v) => v === key);
  }
  return field.value !== undefined && scalarKey(field.value(row)) === key;
}

/** A multi-value field's values with its elided one left out. */
export function visibleValues(
  p: FieldPresentation,
  field: FieldDef<unknown>,
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  const key = p.elided.get(field.id);
  if (key === undefined || values === undefined) return values;
  return values.filter((v) => v !== key);
}
