import { useCallback, type ComponentType, type ReactNode } from "react";
import {
  defineSlot,
  useCompanionLookup,
  useRawContributions,
} from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import { resolveTypeChain } from "@plugins/fields/core";
import type { ColumnConfigDerive, ColumnConfigProps, FieldDef } from "../core";
import { useFieldIdentities } from "./internal/use-field-identities";

/**
 * Per-type add-time column-config capability. A plain slot carrying, per field
 * type (keyed by `match`, the type token), the two halves of "this type has an
 * opaque custom-column config blob": the editor `component` that authors it, and
 * the optional pure `derive` that projects it onto the generic `FieldDef` keys it
 * implies. They live on ONE contribution because both require understanding the
 * same private shape — a type cannot own the editor and leave the projection to
 * someone else. Only types needing add-time configuration (e.g. `enum`'s options)
 * contribute; all others resolve to `null` / `{}`. Mirrors the `Filter`/`ValueCodec`
 * slots — a plain `defineSlot` resolved per type honoring the `extends` chain.
 */
const ColumnConfig = defineSlot<{
  match: string;
  component: ComponentType<ColumnConfigProps>;
  derive?: ColumnConfigDerive;
}>({
  docLabel: (c) => c.match,
  // A companion here ships only in bundles that use its field type (see
  // `KeySpace`): the data-view primitive plus a plugin referencing the type.
  companions: { key: "match", space: "field-type" },
});

/**
 * Returns a renderer that resolves a field type's config editor (honoring
 * `extends`) and renders it error-boundary-isolated with the given props, or
 * `null` when the type contributes none. Mirrors `useResolveCell` — the resolver
 * RENDERS rather than handing back a component, so call sites never create a
 * component during render.
 */
export function useResolveColumnConfig(): (
  typeId: string,
  props: ColumnConfigProps,
) => ReactNode | null {
  const identities = useFieldIdentities();
  const lookup = useCompanionLookup(
    ColumnConfig,
    useRawContributions(ColumnConfig),
  );
  return useCallback(
    (typeId, props) => {
      const contribution = lookup(resolveTypeChain(typeId, identities));
      return contribution
        ? renderIsolated(ColumnConfig, contribution, props)
        : null;
    },
    [lookup, identities],
  );
}

/**
 * Returns the projection `(typeId, config) => Partial<FieldDef>` — the generic
 * `FieldDef` keys a custom column's opaque config blob implies, resolved through
 * the type's `derive` (honoring `extends`). A type with no `derive` (or none
 * contributed at all) yields `{}`, so a column that needs no projection costs
 * nothing.
 *
 * `custom-columns` calls this when minting its `FieldDef[]`, which is what makes
 * the generic keys (notably `options`) authoritative everywhere downstream —
 * cells, editors, filter inputs and group-by section labels all read `field.options`
 * and none of them knows a single field type's config shape.
 */
export function useResolveColumnDerive(): (
  typeId: string,
  config: unknown,
) => Partial<FieldDef<unknown>> {
  const identities = useFieldIdentities();
  const lookup = useCompanionLookup(
    ColumnConfig,
    ColumnConfig.useContributions(),
  );
  return useCallback(
    (typeId, config) =>
      lookup(resolveTypeChain(typeId, identities))?.derive?.(config) ?? {},
    [lookup, identities],
  );
}

export { ColumnConfig };
