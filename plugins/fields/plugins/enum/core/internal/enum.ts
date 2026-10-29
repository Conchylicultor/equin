import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const listIcon = symbol("list");

export const enumFieldType = defineFieldType<string>("enum");

export const enumIdentity = defineFieldIdentity<string>({
  type: enumFieldType,
  kind: "label",
  label: "Select",
  icon: listIcon,
  customColumn: true,
  coerce: (v) => (typeof v === "string" ? v : String(v ?? "")),
  directionLabels: { asc: "A → Z", desc: "Z → A" },
});
