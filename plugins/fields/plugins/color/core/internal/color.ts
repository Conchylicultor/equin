import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const paletteIcon = symbol("palette");

export const colorFieldType = defineFieldType<string>("color");

export const colorIdentity = defineFieldIdentity<string>({
  type: colorFieldType,
  kind: "label",
  label: "Color",
  icon: paletteIcon,
  coerce: (v) => String(v ?? ""),
});
