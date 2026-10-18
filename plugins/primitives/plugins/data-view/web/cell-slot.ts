import { useCallback, type ReactNode } from "react";
import {
  useCompanionLookup,
  useRawContributions,
  type Contribution,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  defineDispatchSlot,
  renderIsolated,
} from "@plugins/primitives/plugins/slot-render/web";
import { resolveTypeChain } from "@plugins/fields/core";
import type { FieldDef, FieldValue, TableCellProps } from "../core";
import { useFieldIdentities } from "./internal/use-field-identities";

/**
 * What a cell contribution declares about ITSELF, beyond how to render.
 *
 * The registry is where a "what shape does this type present as" question has a
 * generic answer: a consumer that needed to know would otherwise have to name
 * field types, which is exactly the collection-consumer coupling this slot
 * exists to prevent.
 */
export interface CellContributionMeta {
  /**
   * True → this field type's READ cell is a chip (a `Badge`), not a text run.
   *
   * The list's subtitle reads it to decide its separators: it draws ` · ` only
   * between two adjacent NON-chip terms, and separates a chip by spacing alone
   * (three chips strung on middots read worse than the two-line row they
   * replace). Declared per TYPE by the cell's own plugin, so the list names no
   * field type.
   *
   * It is a statement about the field's TYPE, not about one particular
   * renderer: a consumer's `FieldDef.cell` override on a chip-typed field is
   * taken to render a chip too (Events' "uninstalled source type" fallback
   * renders a `Badge`). A `cell` override that renders plain TEXT for a
   * chip-typed field therefore loses its middots — cosmetic, and the price of
   * not asking every consumer to re-declare what its type already said.
   */
  chip?: boolean;
}

/**
 * Per-type table cell slot. Contributors call `DataViewSlots.Cell({ match, component })`.
 * Resolution is custom (`useResolveCell`) so it can walk the `extends` chain —
 * `defineDispatchSlot`'s built-in `.Dispatch` can't.
 */
const Cell = defineDispatchSlot<TableCellProps, string, CellContributionMeta>({
  key: (p) => p.field.type ?? "text",
  docLabel: (c) => (typeof c.match === "string" ? c.match : undefined),
  // A companion here ships only in bundles that use its field type (see
  // `KeySpace`): the data-view primitive plus a plugin referencing the type.
  companions: { key: "match", space: "field-type" },
});

/**
 * The ONE `extends`-chain walk over the Cell registry: the first contribution
 * matching any type in the field's chain, or `undefined`. Both public readers
 * (`useResolveCell`, `useIsChipField`) go through it, so "which contribution
 * owns this field" cannot be answered two different ways.
 */
function useFindCellContribution(): (
  field: FieldDef<unknown>,
) => (Contribution & CellContributionMeta) | undefined {
  const identities = useFieldIdentities();
  const lookup = useCompanionLookup(Cell, useRawContributions(Cell));
  return useCallback(
    (field) =>
      lookup(resolveTypeChain(field.type ?? "text", identities)) as
        (Contribution & CellContributionMeta) | undefined,
    [lookup, identities],
  );
}

/** Returns a renderer that resolves a field's type cell honoring `extends`, or undefined. */
export function useResolveCell(): (
  field: FieldDef<unknown>,
  value: FieldValue,
  raw: unknown,
  values?: readonly string[],
) => ReactNode | undefined {
  const find = useFindCellContribution();
  return useCallback(
    (field, value, row, values) => {
      const contribution = find(field);
      if (!contribution) return undefined;
      return renderIsolated(Cell, contribution, {
        value,
        values,
        data: field.data?.(row),
        field,
        raw: row,
      } satisfies TableCellProps);
    },
    [find],
  );
}

/**
 * Returns a predicate answering "does this field render as a chip?" — the
 * `chip` flag its type's cell contribution declared (see
 * {@link CellContributionMeta.chip}). A field whose type contributes no cell
 * (or contributes one without the flag) renders as text.
 */
export function useIsChipField(): (field: FieldDef<unknown>) => boolean {
  const find = useFindCellContribution();
  return useCallback((field) => find(field)?.chip === true, [find]);
}

export { Cell };
