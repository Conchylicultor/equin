import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const arrowDropDownCircleIcon = symbol("arrow-drop-down-circle");

export const dynamicEnumFieldType = defineFieldType<string>("dynamic-enum");

export const dynamicEnumIdentity = defineFieldIdentity<string>({
  type: dynamicEnumFieldType,
  kind: "label",
  label: "Dynamic Select",
  icon: arrowDropDownCircleIcon,
  coerce: (v) => String(v ?? ""),
});
