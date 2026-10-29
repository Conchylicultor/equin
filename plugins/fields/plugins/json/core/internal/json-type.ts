import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const dataObjectIcon = symbol("data-object");

export const jsonFieldType = defineFieldType<unknown>("json");

// No `coerce`: a JSON blob has no meaningful sortable/comparable scalar
// projection (mirrors the `object` field identity, which omits it too).
export const jsonIdentity = defineFieldIdentity<unknown>({
  type: jsonFieldType,
  kind: "prose",
  label: "JSON",
  icon: dataObjectIcon,
});
