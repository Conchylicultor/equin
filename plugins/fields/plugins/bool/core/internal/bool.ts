import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const toggleOnIcon = symbol("toggle-on");

export const boolFieldType = defineFieldType<boolean>("bool");

export const boolIdentity = defineFieldIdentity<boolean>({
  type: boolFieldType,
  kind: "flag",
  label: "Boolean",
  icon: toggleOnIcon,
  customColumn: true,
  coerce: (v) => (v ? 1 : 0),
  directionLabels: { asc: "Unchecked first", desc: "Checked first" },
});
