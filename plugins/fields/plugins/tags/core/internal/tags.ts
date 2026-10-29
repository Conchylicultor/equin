import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const labelIcon = symbol("label");

export const tagsFieldType = defineFieldType<string[]>("tags");

export const tagsIdentity = defineFieldIdentity<string[]>({
  type: tagsFieldType,
  kind: "label",
  label: "Tags",
  icon: labelIcon,
});
