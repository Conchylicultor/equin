import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const textFieldsIcon = symbol("text-fields");

export const textFieldType = defineFieldType<string>("text");

export const textIdentity = defineFieldIdentity<string>({
  type: textFieldType,
  kind: "label",
  label: "Text",
  icon: textFieldsIcon,
  customColumn: true,
  coerce: (v) => (typeof v === "string" ? v : String(v ?? "")),
  directionLabels: { asc: "A → Z", desc: "Z → A" },
});
