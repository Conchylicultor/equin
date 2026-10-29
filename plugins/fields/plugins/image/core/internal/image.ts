import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const imageIcon = symbol("image");

export const imageFieldType = defineFieldType<string>("image");

export const imageIdentity = defineFieldIdentity<string>({
  type: imageFieldType,
  kind: "visual",
  label: "Image",
  icon: imageIcon,
  coerce: (v) => String(v ?? ""),
});
