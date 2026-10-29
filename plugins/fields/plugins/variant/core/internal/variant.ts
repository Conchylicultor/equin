import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const callSplitIcon = symbol("call-split");

/**
 * A discriminated/polymorphic object value. The `type` discriminant selects
 * which "variant" the rest of the keys belong to; every other key is opaque
 * per-type payload owned by the chosen variant.
 *
 * Storage is opaque/passthrough at the config boundary (mirroring a
 * `reorder-tree` node `{ type, ...payload }`): the config schema validates only
 * the `type` discriminant and preserves the payload verbatim. Per-type
 * validation of the payload happens downstream, against an injected per-type
 * field registry (see `validateVariant` / `useVariants` in the config
 * sub-plugin).
 */
export type VariantValue = { type: string } & Record<string, unknown>;

export const variantFieldType = defineFieldType<VariantValue>("variant");

export const variantIdentity = defineFieldIdentity<VariantValue>({
  type: variantFieldType,
  kind: "label",
  label: "Variant",
  icon: callSplitIcon,
  // no coerce — not a sortable/filterable scalar (like reorder-tree/object).
});
