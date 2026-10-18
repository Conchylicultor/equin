import { useCallback, useMemo } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import { resolveTypeChain } from "@plugins/fields/core";
import type { FieldGrouping, FieldGroupingSet } from "../core";
import {
  IDENTITY_GROUPING,
  IDENTITY_GROUPING_SET,
} from "./internal/identity-grouping";
import { useFieldIdentities } from "./internal/use-field-identities";

/**
 * Per-type grouping slot. A plain slot carrying, per field type (keyed by
 * `match`, the type token), the ways that type buckets its values plus the label
 * its granularity band wears ("Group dates by"). Mirrors the `Filter` /
 * `ValueCodec` slots — a plain `defineSlot` payload resolved per type honoring
 * the `extends` chain, not a dispatch slot, since a grouping is a pure function
 * set rather than a component.
 *
 * This is what makes data-view name no field type. Groupability itself is
 * derived from it (`isGroupableField`): a field is groupable because its type
 * says how it buckets, never because the primitive holds a list of type tokens.
 */
const GroupingSlot = defineSlot<{ match: string } & FieldGroupingSet>({
  docLabel: (c) => c.match,
  // A companion here ships only in bundles that use its field type (see
  // `KeySpace`): the data-view primitive plus a plugin referencing the type.
  companions: { key: "match", space: "field-type" },
});

/** Resolve a field type id → the groupings it declares, honoring `extends`;
 *  `undefined` = no type in the chain declares any. */
export function useResolveGroupings(): (
  typeId: string,
) => FieldGroupingSet | undefined {
  const identities = useFieldIdentities();
  const contributions = GroupingSlot.useContributions();
  return useCallback(
    (typeId) => {
      const chain = resolveTypeChain(typeId, identities);
      for (const id of chain) {
        const c = contributions.find((x) => x.match === id);
        if (c) return c;
      }
      return undefined;
    },
    [identities, contributions],
  );
}

/** The three questions data-view asks the grouping registry, in one object. */
export interface GroupingRegistry {
  /** Does any type in this type's `extends` chain declare groupings? The whole
   *  of the default groupable policy — see `isGroupableField`. */
  has: (typeId: string) => boolean;
  /** The granularity band a field of this type offers (label + choices): the
   *  declared set, or the built-in identity fallback. */
  setFor: (typeId: string) => FieldGroupingSet;
  /** The ONE grouping a `GroupByRule` names. A dangling `groupingId` (the type's
   *  groupings changed under a persisted config) falls back to the first choice
   *  rather than throwing — the same tolerance a dangling group-by field gets. */
  resolve: (typeId: string, groupingId: string) => FieldGrouping;
}

/** Registry-shaped read of the `Grouping` slot, with the identity fallback
 *  applied. Every data-view consumer of groupings goes through this. */
export function useGroupingRegistry(): GroupingRegistry {
  const resolveGroupings = useResolveGroupings();
  return useMemo(() => {
    const setFor = (typeId: string): FieldGroupingSet =>
      resolveGroupings(typeId) ?? IDENTITY_GROUPING_SET;
    return {
      has: (typeId) => resolveGroupings(typeId) !== undefined,
      setFor,
      resolve: (typeId, groupingId) => {
        const { groupings } = setFor(typeId);
        return (
          groupings.find((g) => g.id === groupingId) ??
          groupings[0] ??
          IDENTITY_GROUPING
        );
      },
    };
  }, [resolveGroupings]);
}

export { GroupingSlot as Grouping };
