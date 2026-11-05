import { useCallback } from "react";
import { resolveTypeChain } from "@plugins/fields/core";
import type { FieldDef } from "../../core";
import { useFieldIdentities } from "./use-field-identities";

/** Generic fallback when a field type registers no `directionLabels`. */
const GENERIC_LABELS = { asc: "Ascending", desc: "Descending" } as const;

export type DirectionLabels = { asc: string; desc: string };

/** What naming a field's sort directions reads of it — nothing row-typed. */
type DirectionField = Pick<
  FieldDef<unknown>,
  "type" | "valueOrder" | "options"
>;

/**
 * Resolve a field → its sort-direction labels. The sort builder's
 * DirectionPicker uses this to name what each direction does.
 *
 * An ordinal field (`valueOrder`) is sorted by each value's declared position,
 * never its text, so it names the order's two ends: "New → Dropped" /
 * "Dropped → New" (each end by its option's label when it has one).
 *
 * Any other field takes its type's registered labels, honoring `extends` (an
 * `int` field reuses `number`'s "1 → 9" / "9 → 1" when `int` declares none of
 * its own), else the generic "Ascending" / "Descending" — reading the
 * `fields.identity` registry by id, the same sanctioned no-`fields/web`-import
 * practice as `useResolveFieldIcon` / `useResolveOperatorSet`.
 */
export function useResolveDirectionLabels(): (
  field: DirectionField | undefined,
) => DirectionLabels {
  const identities = useFieldIdentities();
  return useCallback(
    (field) => {
      const ordinal = field === undefined ? null : ordinalLabels(field);
      if (ordinal !== null) return ordinal;
      const chain = resolveTypeChain(field?.type ?? "text", identities);
      for (const id of chain) {
        const labels = identities.get(id)?.directionLabels;
        if (labels) return labels;
      }
      return GENERIC_LABELS;
    },
    [identities],
  );
}

/** An ordinal field's labels, from the ends of its declared order. */
export function ordinalLabels(field: DirectionField): DirectionLabels | null {
  const order = field.valueOrder;
  const first = order?.[0];
  const last = order?.at(-1);
  if (first === undefined || last === undefined) return null;
  const name = (value: string) =>
    field.options?.find((o) => o.value === value)?.label ?? value;
  return {
    asc: `${name(first)} → ${name(last)}`,
    desc: `${name(last)} → ${name(first)}`,
  };
}
