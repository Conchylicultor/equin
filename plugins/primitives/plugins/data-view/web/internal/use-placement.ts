import { useMemo } from "react";
import { resolveFieldKind, type FieldKind } from "@plugins/fields/core";
import type {
  FieldDef,
  FieldOption,
  PlacementSpec,
  PropertyEntry,
  ViewSlots,
} from "../../core";
import { useFieldIdentities } from "./use-field-identities";
import { resolvePlacement, type Placement } from "./placement";

/**
 * A field's kind: its type's (`FieldIdentity.kind`, through `extends`) —
 * except that a closed-set field whose options declare how they look (a
 * `variant`, a `tint` or an `icon`) is a `state`. That is the one rule decided
 * here, and it names no type.
 */
export function useResolveFieldKind(): (field: FieldDef<unknown>) => FieldKind {
  const identities = useFieldIdentities();
  return useMemo(
    () => (field) => {
      const kind = resolveFieldKind(field.type ?? "text", identities);
      if (kind === "label" && optionsOf(field).some(isStateOption)) {
        return "state";
      }
      return kind;
    },
    [identities],
  );
}

function optionsOf(field: FieldDef<unknown>): readonly FieldOption[] {
  if (field.options) return field.options;
  if (field.optionsResult?.status === "ready") {
    return field.optionsResult.options;
  }
  return [];
}

function isStateOption(option: FieldOption): boolean {
  return (
    option.variant !== undefined ||
    option.tint !== undefined ||
    option.icon !== undefined
  );
}

/**
 * Where every field of the schema goes in THIS view — the one read every view
 * draws its slots from (`resolvePlacement` over the type registry's kinds and
 * the view's own slot table). `viewSlots` must be a stable value (a module
 * constant).
 */
export function usePlacement<TRow>(
  fields: readonly FieldDef<TRow>[],
  properties: readonly PropertyEntry[] | null | undefined,
  spec: PlacementSpec,
  viewSlots: ViewSlots,
): Placement<TRow> {
  const kindOf = useResolveFieldKind() as (field: FieldDef<TRow>) => FieldKind;
  return useMemo(
    () => resolvePlacement({ fields, kindOf, viewSlots, spec, properties }),
    [fields, kindOf, viewSlots, spec, properties],
  );
}
