import { useCallback } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import { resolveTypeChain } from "@plugins/fields/core";
import type { FilterOperatorSet } from "../core";
import { useFieldIdentities } from "./internal/use-field-identities";

/**
 * Per-type filter slot. A plain slot carrying one `FilterOperatorSet` per field
 * type: the set of named operators (a `lower` into the filter language + an
 * optional value editor) over one filter-language `domain`, which the
 * filter builder offers for that type.
 */
const Filter = defineSlot<FilterOperatorSet>({
  docLabel: (c) => c.match,
  // A companion here ships only in bundles that use its field type (see
  // `KeySpace`): the data-view primitive plus a plugin referencing the type.
  companions: { key: "match", space: "field-type" },
});

/** Resolve a field type id → its FilterOperatorSet, honoring `extends`. */
export function useResolveOperatorSet(): (
  typeId: string,
) => FilterOperatorSet | undefined {
  const identities = useFieldIdentities();
  const contributions = Filter.useContributions();
  return useCallback(
    (typeId) => {
      const chain = resolveTypeChain(typeId, identities);
      for (const id of chain) {
        const c = contributions.find((x) => x.match === id);
        if (c) return c as unknown as FilterOperatorSet;
      }
      return undefined;
    },
    [identities, contributions],
  );
}

export { Filter };
